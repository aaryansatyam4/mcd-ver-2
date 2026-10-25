import dotenv from 'dotenv';
import path from 'path';
dotenv.config();
const publicDir = path.resolve(process.cwd(), 'public');
export const config = {
    port: parseInt(process.env.PORT || '5000', 10),
    nodeEnv: process.env.NODE_ENV || 'development',
    jwtSecret: process.env.JWT_SECRET || 'wheelwash_super_secret_jwt_key_2026_mcd_production',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    publicDir: publicDir,
    excelDbPath: process.env.EXCEL_DB_PATH || path.join(publicDir, 'database.xlsx'),
    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    demoMode: process.env.DEMO_MODE !== 'false',
    timezone: process.env.TIMEZONE || 'Asia/Kolkata',
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    // YOLO26 sidecar (backend/yolo/detect_server.py). All real camera frames are classified here.
    yoloUrl: (process.env.YOLO_URL || 'http://127.0.0.1:5002').replace(/\/+$/, ''),
    yoloPython: process.env.YOLO_PYTHON || 'python3',
    yoloAutoStart: process.env.YOLO_AUTOSTART !== 'false',
    yoloTimeoutMs: parseInt(process.env.YOLO_TIMEOUT_MS || '4000', 10),
    // COCO class names that count as a truck passage (YOLO sometimes labels large tippers as "bus")
    yoloVehicleClasses: (process.env.YOLO_VEHICLE_CLASSES || 'truck,bus')
        .split(',')
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean),
    yoloTruckMinConfidence: parseFloat(process.env.YOLO_TRUCK_MIN_CONF || '0.45'),
    yoloPersonMinConfidence: parseFloat(process.env.YOLO_PERSON_MIN_CONF || '0.35'),
};
