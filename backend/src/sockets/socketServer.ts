import { Server as SocketIOServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';
import { verifyToken, type TokenPayload } from '../utils/jwtUtils.js';
import { logger } from '../utils/logger.js';
import { db } from '../database/excelDb.js';
import type { StreamFrame } from '../camera/types.js';

let io: SocketIOServer | null = null;

// Callback registered by cameraManager to handle device camera frames
let onDeviceFrameHandler: ((locationId: number, frameBase64: string) => void) | null = null;
let onDeviceDisconnectHandler: ((locationId: number) => void) | null = null;

const FRAME_DATA_URL = /^data:image\/(jpeg|png|webp);base64,/;

export function registerDeviceCameraHandlers(
  onFrame: (locationId: number, frameBase64: string) => void,
  onDisconnect: (locationId: number) => void
) {
  onDeviceFrameHandler = onFrame;
  onDeviceDisconnectHandler = onDisconnect;
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
    // Only the raw image is used; classification happens server-side (YOLO26).
    let lastRejectNoticeAt = 0;
    socket.on('camera:ingest_frame', (data: { locationId: number; frameBase64: string }) => {
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

      onDeviceFrameHandler?.(locationId, data.frameBase64);
    });

    socket.on('camera:disconnect_device', (data: { locationId: number }) => {
      const locationId = Number(data?.locationId);
      if (canIngestCamera(user, locationId) && onDeviceDisconnectHandler) {
        onDeviceDisconnectHandler(locationId);
      }
    });

    socket.on('join:location', (locationId: number) => {
      socket.join(`location_${locationId}`);
    });

    socket.on('leave:location', (locationId: number) => {
      socket.leave(`location_${locationId}`);
    });

    socket.on('disconnect', () => {
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
export function broadcastCameraFrame(frame: StreamFrame): void {
  if (!io) return;
  io.emit('camera:frame', frame);
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
