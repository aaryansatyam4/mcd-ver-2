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
    // Google Sheet database: the Web app URL of google-apps-script.js. When set, the sheet is the
    // source of truth and the local Excel file is only a cache.
    googleScriptUrl: (process.env.GOOGLE_SCRIPT_URL || '').trim(),
    googleScriptSecret: (process.env.GOOGLE_SCRIPT_SECRET || '').trim(),
    googleScriptTimeoutMs: parseInt(process.env.GOOGLE_SCRIPT_TIMEOUT_MS || '30000', 10),
    // How often edits made by hand in the Google Sheet are picked up (0 turns it off)
    googleSheetReloadSeconds: parseInt(process.env.GOOGLE_SHEET_RELOAD_SECONDS || '30', 10),
    // Daily truck count on Telegram: bot token from @BotFather, one or more chat ids (comma separated)
    // and the time it is sent (HH:MM, India time)
    telegramBotToken: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
    telegramChatIds: (process.env.TELEGRAM_CHAT_ID || '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    telegramReportTime: (process.env.TELEGRAM_REPORT_TIME || '23:55')
        .trim()
        .replace(/^(\d):/, '0$1:'),
    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    demoMode: process.env.DEMO_MODE !== 'false',
    timezone: process.env.TIMEZONE || 'Asia/Kolkata',
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    // YOLO26 sidecar (backend/yolo/detect_server.py). All real camera frames are classified here.
    // Accepts a bare host:port (Render private network) as well as a full URL
    yoloUrl: (process.env.YOLO_URL || 'http://127.0.0.1:5002')
        .trim()
        .replace(/^(?!https?:\/\/)/, 'http://')
        .replace(/\/+$/, ''),
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
