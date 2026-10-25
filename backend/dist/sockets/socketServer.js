import { Server as SocketIOServer } from 'socket.io';
import { verifyToken } from '../utils/jwtUtils.js';
import { logger } from '../utils/logger.js';
import { db } from '../database/excelDb.js';
let io = null;
// Callback registered by cameraManager to handle device camera frames
let onDeviceFrameHandler = null;
let onDeviceDisconnectHandler = null;
const FRAME_DATA_URL = /^data:image\/(jpeg|png|webp);base64,/;
export function registerDeviceCameraHandlers(onFrame, onDisconnect) {
    onDeviceFrameHandler = onFrame;
    onDeviceDisconnectHandler = onDisconnect;
}
/**
 * Only an active Master Admin, or the Operator assigned to that location, may stream a
 * camera into a location (and therefore drive its automatic counter).
 */
export function canIngestCamera(payload, locationId) {
    if (!payload)
        return false;
    const user = db.getUserById(payload.userId);
    if (!user || user.active !== 1)
        return false;
    if (user.role === 'admin')
        return true;
    return user.role === 'operator' && user.assigned_location_id === locationId;
}
export function initSocketServer(httpServer, corsOrigin) {
    io = new SocketIOServer(httpServer, {
        cors: {
            origin: '*', // Allow connections from frontend dev server or production host
            methods: ['GET', 'POST'],
            credentials: true,
        },
        transports: ['websocket', 'polling'],
        maxHttpBufferSize: 1e7, // 10MB to accommodate high-res camera frames
    });
    io.use((socket, next) => {
        const token = socket.handshake.auth.token || socket.handshake.headers['authorization'];
        if (token) {
            const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
            const payload = verifyToken(cleanToken);
            if (payload) {
                socket.user = payload;
            }
        }
        next();
    });
    io.on('connection', (socket) => {
        const user = socket.user;
        logger.info(`Socket client connected: ${socket.id} (${user ? user.username : 'anonymous'})`);
        // Receive live frame uploaded from a browser device camera (USB / Bluetooth / Webcam / Mobile).
        // Only the raw image is used; classification happens server-side (YOLO26).
        let lastRejectNoticeAt = 0;
        socket.on('camera:ingest_frame', (data) => {
            if (!data || typeof data.frameBase64 !== 'string' || !FRAME_DATA_URL.test(data.frameBase64))
                return;
            const locationId = Number(data.locationId);
            if (!Number.isInteger(locationId))
                return;
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
        socket.on('camera:disconnect_device', (data) => {
            const locationId = Number(data?.locationId);
            if (canIngestCamera(user, locationId) && onDeviceDisconnectHandler) {
                onDeviceDisconnectHandler(locationId);
            }
        });
        socket.on('join:location', (locationId) => {
            socket.join(`location_${locationId}`);
        });
        socket.on('leave:location', (locationId) => {
            socket.leave(`location_${locationId}`);
        });
        socket.on('disconnect', () => {
            logger.info(`Socket client disconnected: ${socket.id}`);
        });
    });
    return io;
}
export function getIO() {
    return io;
}
/**
 * Broadcast real-time camera video frame
 */
export function broadcastCameraFrame(frame) {
    if (!io)
        return;
    io.emit('camera:frame', frame);
}
/**
 * Broadcast vehicle detection event
 */
export function broadcastVehicleDetected(event) {
    if (!io)
        return;
    io.emit('vehicle:detected', event);
}
/**
 * Broadcast count updated event
 */
export function broadcastCountUpdated(data) {
    if (!io)
        return;
    io.emit('count:updated', data);
}
export function broadcastCountAdjusted(data) {
    if (!io)
        return;
    io.emit('count:adjusted', data);
}
/**
 * Broadcast camera status change (online/offline/reconnecting)
 */
export function broadcastCameraStatus(data) {
    if (!io)
        return;
    io.emit('camera:status', data);
}
