import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { verifyToken, type TokenPayload } from '../utils/jwtUtils.js';
import { logger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { db } from '../database/excelDb.js';
import type { StreamFrame } from '../camera/types.js';
import type { YoloResult, YoloDetection } from '../services/yoloDetector.js';

let io: SocketIOServer | null = null;

// Callback registered by cameraManager to handle device camera frames
let onDeviceFrameHandler:
  | ((locationId: number, frameBase64: string, detections?: YoloResult) => void)
  | null = null;
let onDeviceDisconnectHandler: ((locationId: number) => void) | null = null;

const FRAME_DATA_URL = /^data:image\/(jpeg|png|webp);base64,/;
const MAX_DEVICE_DETECTIONS = 300;

export function registerDeviceCameraHandlers(
  onFrame: (locationId: number, frameBase64: string, detections?: YoloResult) => void,
  onDisconnect: (locationId: number) => void
) {
  onDeviceFrameHandler = onFrame;
  onDeviceDisconnectHandler = onDisconnect;
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Validate YOLO26 detections produced on the streaming device (onnxruntime-web in the browser).
 * Returns null for anything malformed so the frame falls back to server-side detection.
 */
export function parseDeviceDetections(raw: unknown): YoloResult | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isFiniteNumber(r.width) || !isFiniteNumber(r.height) || r.width <= 0 || r.height <= 0) return null;
  if (!Array.isArray(r.detections) || r.detections.length > MAX_DEVICE_DETECTIONS) return null;

  const detections: YoloDetection[] = [];
  for (const item of r.detections) {
    if (!item || typeof item !== 'object') return null;
    const d = item as Record<string, unknown>;
    const bbox = d.bbox;
    if (
      typeof d.class_name !== 'string' ||
      !isFiniteNumber(d.class_id) ||
      !isFiniteNumber(d.confidence) ||
      d.confidence < 0 ||
      d.confidence > 1 ||
      !Array.isArray(bbox) ||
      bbox.length !== 4 ||
      !bbox.every(isFiniteNumber)
    ) {
      return null;
    }
    detections.push({
      class_id: d.class_id,
      class_name: d.class_name.slice(0, 32),
      confidence: d.confidence,
      bbox: [bbox[0], bbox[1], bbox[2], bbox[3]],
    });
  }

  return {
    detections,
    inference_ms: isFiniteNumber(r.inference_ms) ? r.inference_ms : 0,
    width: r.width,
    height: r.height,
  };
}

/**
 * Only an active Master Admin, or the Operator assigned to that location, may stream a
 * camera into a location (and therefore drive its automatic counter).
 */
export function canIngestCamera(payload: TokenPayload | undefined, locationId: number): boolean {
  if (!payload) return false;
  const user = db.getUserById(payload.userId);
  if (!user || user.active !== 1) return false;
  if (user.role === 'admin') return true;
  return user.role === 'operator' && user.assigned_location_id === locationId;
}

/**
 * Camera frames are the bulk of the traffic (Render bills outgoing data), so they only go to
 * browsers that are showing a camera: 'live' viewers (Live Monitoring) get a few frames a second,
 * 'preview' viewers (Dashboard tiles) one every few seconds. A browser that is streaming its own
 * camera never gets that camera's frames back.
 */
export type CameraWatchMode = 'live' | 'preview';
const WATCH_MODES: CameraWatchMode[] = ['live', 'preview'];
const frameRoom = (mode: CameraWatchMode, locationId: number) => `frames:${mode}:${locationId}`;
const frameIntervalMs = (mode: CameraWatchMode) =>
  mode === 'live' ? Math.round(1000 / Math.max(0.1, config.cameraLiveFps)) : config.cameraPreviewSeconds * 1000;

const lastFrameSentAt = new Map<string, number>(); // room -> time of last frame sent to it
const latestFrame = new Map<number, StreamFrame>(); // locationId -> newest frame, for new viewers
const streamingSocket = new Map<number, string>(); // locationId -> socket id of the device streaming it

export function initSocketServer(httpServer: HttpServer, corsOrigin: string): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*', // Allow connections from frontend dev server or production host
      methods: ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1e7, // 10MB to accommodate high-res camera frames
  });

  io.use((socket: Socket, next) => {
    const token = socket.handshake.auth.token || socket.handshake.headers['authorization'];
    if (token) {
      const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
      const payload = verifyToken(cleanToken);
      if (payload) {
        (socket as any).user = payload;
      }
    }
    next();
  });

  io.on('connection', (socket: Socket) => {
    const user = (socket as any).user;
    logger.info(`Socket client connected: ${socket.id} (${user ? user.username : 'anonymous'})`);

    // Receive live frame uploaded from a browser device camera (USB / Bluetooth / Webcam / Mobile).
    // The device runs YOLO26 itself and attaches its raw detections; the server still decides what counts.
    // Frames without (valid) detections fall back to the server-side YOLO26 sidecar.
    let lastRejectNoticeAt = 0;
    socket.on('camera:ingest_frame', (data: { locationId: number; frameBase64: string; detections?: unknown }) => {
      if (!data || typeof data.frameBase64 !== 'string' || !FRAME_DATA_URL.test(data.frameBase64)) return;
      const locationId = Number(data.locationId);
      if (!Number.isInteger(locationId)) return;

      if (!canIngestCamera(user, locationId)) {
        const now = Date.now();
        if (now - lastRejectNoticeAt > 5000) {
          lastRejectNoticeAt = now;
          logger.warn(`Rejected camera stream for location ${locationId} from ${user ? user.username : 'anonymous'}`);
          socket.emit('camera:ingest_rejected', {
            locationId,
            reason: 'You are not authorised to stream a camera to this location. Please log in again.',
          });
        }
        return;
      }

      streamingSocket.set(locationId, socket.id);
      const detections = data.detections === undefined ? null : parseDeviceDetections(data.detections);
      onDeviceFrameHandler?.(locationId, data.frameBase64, detections ?? undefined);
    });

    socket.on('camera:disconnect_device', (data: { locationId: number }) => {
      const locationId = Number(data?.locationId);
      if (canIngestCamera(user, locationId) && onDeviceDisconnectHandler) {
        onDeviceDisconnectHandler(locationId);
      }
      if (streamingSocket.get(locationId) === socket.id) streamingSocket.delete(locationId);
    });

    // Which cameras this browser is showing right now; replaces what it watched before.
    // An empty list (page without cameras, hidden tab, idle viewer) stops all frames.
    socket.on('camera:watch', (data: { locationIds?: unknown; mode?: unknown }) => {
      for (const room of socket.rooms) {
        if (room.startsWith('frames:')) socket.leave(room);
      }
      if (!user) return;
      const mode: CameraWatchMode = data?.mode === 'live' ? 'live' : 'preview';
      const ids = Array.isArray(data?.locationIds) ? data.locationIds.map(Number).filter(Number.isInteger) : [];
      for (const locationId of ids) {
        socket.join(frameRoom(mode, locationId));
        // Show the newest picture straight away instead of waiting for the next frame
        const frame = latestFrame.get(locationId);
        if (frame && streamingSocket.get(locationId) !== socket.id) socket.emit('camera:frame', frame);
      }
    });

    socket.on('join:location', (locationId: number) => {
      socket.join(`location_${locationId}`);
    });

    socket.on('leave:location', (locationId: number) => {
      socket.leave(`location_${locationId}`);
    });

    socket.on('disconnect', () => {
      for (const [locationId, id] of streamingSocket) {
        if (id === socket.id) streamingSocket.delete(locationId);
      }
      logger.info(`Socket client disconnected: ${socket.id}`);
    });
  });

  return io;
}

export function getIO(): SocketIOServer | null {
  return io;
}

/**
 * Broadcast real-time camera video frame
 */
export function broadcastCameraFrame(frame: StreamFrame, now = Date.now()): void {
  if (!io) return;
  latestFrame.set(frame.locationId, frame);

  for (const mode of WATCH_MODES) {
    const room = frameRoom(mode, frame.locationId);
    if (!io.sockets.adapter.rooms.get(room)?.size) continue;
    if (now - (lastFrameSentAt.get(room) ?? 0) < frameIntervalMs(mode)) continue;
    lastFrameSentAt.set(room, now);

    const device = streamingSocket.get(frame.locationId);
    (device ? io.to(room).except(device) : io.to(room)).emit('camera:frame', frame);
  }
}

/**
 * Broadcast vehicle detection event
 */
export function broadcastVehicleDetected(event: {
  locationId: number;
  locationName: string;
  timestamp: string;
  todayCount: number;
}): void {
  if (!io) return;
  io.emit('vehicle:detected', event);
}

/**
 * Broadcast count updated event
 */
export function broadcastCountUpdated(data: any): void {
  if (!io) return;
  io.emit('count:updated', data);
}

export function broadcastCountAdjusted(data: any): void {
  if (!io) return;
  io.emit('count:adjusted', data);
}

/**
 * Broadcast camera status change (online/offline/reconnecting)
 */
export function broadcastCameraStatus(data: {
  cameraId: number;
  locationId: number;
  status: string;
  source?: string;
}): void {
  if (!io) return;
  io.emit('camera:status', data);
}
