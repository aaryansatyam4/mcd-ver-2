import http from 'http';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { db } from './database/excelDb.js';
import { initSocketServer } from './sockets/socketServer.js';
import { cameraManager } from './camera/cameraManager.js';
import { ensureYoloService, stopYoloService } from './services/yoloSupervisor.js';
import { CountService } from './services/countService.js';
import { getKolkataTimestamp } from './utils/dateUtils.js';
/** Human-readable "Dashboard" tab kept at the front of the Google Sheet */
function buildSheetDashboard() {
    const summary = CountService.getDashboardSummary();
    const updated = getKolkataTimestamp();
    const rows = summary.locations.map((loc) => [
        loc.locationName,
        String(loc.todayCount),
        String(loc.automaticCount),
        String(loc.manualAdjustment),
        loc.lastDetectionTime || '-',
        loc.cameraStatus,
        summary.date,
        updated,
    ]);
    rows.push(['TOTAL', String(summary.totalTrucksToday), '', '', '', '', summary.date, updated]);
    return {
        headers: ['Location', 'Trucks Today', 'Automatic', 'Manual Adjustment', 'Last Truck Seen', 'Camera', 'Date', 'Updated (IST)'],
        rows,
    };
}
async function bootstrap() {
    try {
        logger.info('==================================================');
        logger.info('      WHEELWASH MONITOR - STARTING SERVER        ');
        logger.info('==================================================');
        // 1. Initialize Database (Google Sheet when GOOGLE_SCRIPT_URL is set, otherwise the Excel file)
        await db.init();
        db.sheets?.setDashboardProvider(buildSheetDashboard);
        // 2. Setup HTTP & Express Server
        const app = createApp();
        const server = http.createServer(app);
        // 3. Initialize Real-Time WebSockets
        initSocketServer(server, config.corsOrigin);
        logger.info('Socket.IO real-time server attached');
        // 4. Start / attach the YOLO26 truck-vs-human detector (non-blocking: model load can take a while)
        ensureYoloService().catch((err) => logger.warn('YOLO26 startup check failed:', err));
        // 5. Initialize Camera Manager and Motion Detection Pipelines
        await cameraManager.init();
        // 6. Start Listening
        server.listen(config.port, () => {
            logger.info(`WheelWash Monitor API Server running at http://localhost:${config.port}`);
            const storage = db.getStorageStatus();
            if (storage.mode === 'google-sheets') {
                logger.info(`Database: Google Sheet ${storage.spreadsheetUrl ?? ''} (local cache: ${config.excelDbPath})`);
            }
            else {
                logger.info(`Database: Excel file at ${config.excelDbPath}`);
            }
            logger.info(`Static download URL: http://localhost:${config.port}/public/database.xlsx`);
            logger.info(`Demo Mode: ${config.demoMode ? 'ENABLED' : 'DISABLED'}`);
            logger.info('Five seeded accounts ready:');
            logger.info(' - admin / 123456 (Master Admin)');
            logger.info(' - ghazipur / 123456 (Ghazipur Operator)');
            logger.info(' - okhla / 123456 (Okhla Operator)');
            logger.info(' - bhalaswa / 123456 (Bhalaswa Operator)');
            logger.info(' - monitoring / 123456 (Central Monitoring)');
        });
        // Graceful Shutdown
        const gracefulShutdown = async (signal) => {
            logger.info(`Received ${signal}. Gracefully stopping WheelWash Monitor...`);
            cameraManager.shutdown();
            stopYoloService();
            await db.flush();
            server.close(() => {
                logger.info('HTTP server closed. Exiting process.');
                process.exit(0);
            });
        };
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    }
    catch (err) {
        logger.error('Fatal error during server startup:', err);
        process.exit(1);
    }
}
bootstrap();
