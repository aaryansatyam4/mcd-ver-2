import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { config } from './config/index.js';
import { errorHandler } from './middleware/errorHandler.js';

// Route imports
import authRoutes from './routes/authRoutes.js';
import dashboardRoutes from './routes/dashboardRoutes.js';
import cameraRoutes from './routes/cameraRoutes.js';
import countRoutes from './routes/countRoutes.js';
import reportRoutes from './routes/reportRoutes.js';
import userRoutes from './routes/userRoutes.js';
import auditRoutes from './routes/auditRoutes.js';
import demoRoutes from './routes/demoRoutes.js';

export function createApp() {
  const app = express();

  // Middleware
  app.use(cors({
    origin: '*',
    credentials: true,
  }));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Serve static files from backend public directory (including database.xlsx)
  app.use('/public', express.static(config.publicDir));

  // Health check endpoint
  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({
      status: 'healthy',
      time: new Date().toISOString(),
      service: 'WheelWash Monitor API',
      database: 'Excel Storage (backend/public/database.xlsx)',
      demoMode: config.demoMode,
    });
  });

  // REST API Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/cameras', cameraRoutes);
  app.use('/api/counts', countRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/audit-logs', auditRoutes);
  app.use('/api/demo', demoRoutes);

  // Production Frontend Static File Serving
  const possibleDistPaths = [
    path.resolve(process.cwd(), '../frontend/dist'),
    path.resolve(process.cwd(), 'frontend/dist'),
    path.resolve(process.cwd(), 'dist/frontend'),
  ];
  const distDir = possibleDistPaths.find((p) => fs.existsSync(p));

  if (distDir) {
    app.use(express.static(distDir));
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/public') || req.path.startsWith('/socket.io')) {
        return next();
      }
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Centralized Error Handling
  app.use(errorHandler);

  return app;
}
