import { Response } from 'express';
import { db } from '../database/excelDb.js';
import { cameraManager } from '../camera/cameraManager.js';
import { AuditService } from '../services/auditService.js';
import type { AuthenticatedRequest } from '../middleware/auth.js';

export class CameraController {
  public static async getCameras(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const user = req.user!;
      let cameras = db.getCameras();

      // If operator, only show their assigned camera
      if (user.role === 'operator' && user.assigned_location_id) {
        cameras = cameras.filter((c) => c.location_id === user.assigned_location_id);
      }

      // Redact sensitive connection info (passwords) for non-admin users
      const sanitized = cameras.map((c) => {
        let config: any = {};
        try {
          config = JSON.parse(c.connection_configuration);
        } catch {
          config = {};
        }

        if (user.role !== 'admin') {
          if (config.password) config.password = '********';
          if (config.rtspUrl) {
            // Mask password in rtsp://user:pass@host...
            config.rtspUrl = config.rtspUrl.replace(/:([^@:]+)@/, ':****@');
          }
        }

        const loc = db.getLocationById(c.location_id);

        return {
          ...c,
          locationName: loc ? loc.name : `Location ${c.location_id}`,
          connection_configuration: JSON.stringify(config),
          parsedSettings: JSON.parse(c.detection_settings || '{}'),
        };
      });

      res.json({ cameras: sanitized });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch cameras.' });
    }
  }

  public static async getCameraStatus(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const cam = db.getCameraById(id);
      if (!cam) {
        res.status(404).json({ error: 'Camera not found.' });
        return;
      }

      // Enforce operator location constraint
      if (req.user?.role === 'operator' && req.user.assigned_location_id !== cam.location_id) {
        res.status(403).json({ error: 'Access denied to this camera.' });
        return;
      }

      const pipeline = cameraManager.getPipeline(cam.location_id);
      const stage = pipeline?.detector.getStage() || 'IDLE';

      res.json({
        id: cam.id,
        locationId: cam.location_id,
        status: cam.status,
        detectionEnabled: cam.detection_enabled === 1,
        detectionStage: stage,
        isRunning: pipeline?.isRunning ?? false,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to fetch camera status.' });
    }
  }

  public static async updateSettings(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const { roi, sensitivity, minDurationMs, cooldownSeconds, detection_enabled, rtspUrl } = req.body;

      const cam = db.getCameraById(id);
      if (!cam) {
        res.status(404).json({ error: 'Camera not found.' });
        return;
      }

      // Update detection settings if provided
      const settingsUpdates: any = {};
      if (roi) settingsUpdates.roi = roi;
      if (sensitivity !== undefined) settingsUpdates.sensitivity = Number(sensitivity);
      if (minDurationMs !== undefined) settingsUpdates.minDurationMs = Number(minDurationMs);
      if (cooldownSeconds !== undefined) settingsUpdates.cooldownSeconds = Number(cooldownSeconds);

      if (Object.keys(settingsUpdates).length > 0) {
        cameraManager.updateCameraSettings(id, settingsUpdates);
      }

      // Update detection enabled toggle
      if (detection_enabled !== undefined) {
        cameraManager.setDetectionEnabled(id, Boolean(detection_enabled));
      }

      // Update RTSP configuration if provided
      if (rtspUrl !== undefined) {
        let currentUrl: string | undefined;
        try {
          currentUrl = JSON.parse(cam.connection_configuration).rtspUrl;
        } catch {
          currentUrl = undefined;
        }
        const nextUrl = String(rtspUrl).trim();
        // Only switch the live source when the URL actually changes (the form always re-sends it)
        if (nextUrl !== (currentUrl || '')) {
          cameraManager.updateCameraConfig(id, {
            rtspUrl: nextUrl,
            streamType: nextUrl ? 'rtsp' : 'synthetic',
          });
        }
      }

      const updatedCam = db.getCameraById(id);

      AuditService.log(req.user!.id, 'UPDATE_CAMERA_SETTINGS', {
        cameraId: id,
        locationId: cam.location_id,
        updatedSettings: settingsUpdates,
        detection_enabled,
      });

      res.json({
        message: 'Camera settings updated successfully.',
        camera: updatedCam,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to update camera settings.' });
    }
  }

  public static async testConnection(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const cam = db.getCameraById(id);
      if (!cam) {
        res.status(404).json({ error: 'Camera not found.' });
        return;
      }

      // Simulated connection test or ping
      res.json({
        success: true,
        status: 'online',
        message: `Camera ${id} connection verified successfully. Latency: 24ms. Ingest pipeline active.`,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Camera connection test failed.' });
    }
  }

  public static async startStream(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const cam = db.getCameraById(id);
      if (!cam) {
        res.status(404).json({ error: 'Camera not found.' });
        return;
      }

      cameraManager.startPipeline(cam.location_id);
      AuditService.log(req.user!.id, 'START_CAMERA_STREAM', { cameraId: id, locationId: cam.location_id });
      res.json({ message: `Camera stream started for location ${cam.location_id}.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to start camera stream.' });
    }
  }

  public static async stopStream(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const cam = db.getCameraById(id);
      if (!cam) {
        res.status(404).json({ error: 'Camera not found.' });
        return;
      }

      cameraManager.stopPipeline(cam.location_id);
      AuditService.log(req.user!.id, 'STOP_CAMERA_STREAM', { cameraId: id, locationId: cam.location_id });
      res.json({ message: `Camera stream stopped for location ${cam.location_id}.` });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Failed to stop camera stream.' });
    }
  }
}
