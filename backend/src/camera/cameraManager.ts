import { db } from '../database/excelDb.js';
import { logger } from '../utils/logger.js';
import { getKolkataTimestamp, getKolkataDateString } from '../utils/dateUtils.js';
import { MotionDetector } from '../detection/motionDetector.js';
import { analyzeDetections } from '../detection/sceneClassifier.js';
import { detectObjects } from '../services/yoloDetector.js';
import { config as appConfig } from '../config/index.js';
import { SyntheticStreamer } from './syntheticStreamer.js';
import { FFmpegStreamer } from './ffmpegStreamer.js';
import { CountService } from '../services/countService.js';
import {
  broadcastCameraFrame,
  broadcastVehicleDetected,
  broadcastCountUpdated,
  broadcastCameraStatus,
  registerDeviceCameraHandlers,
} from '../sockets/socketServer.js';
import type { Camera, CameraSettings, CameraConfig } from '../models/types.js';
import type { AiStatus, DetectedObject } from './types.js';

// A live source (device / RTSP) is considered active while frames keep arriving within this window
const LIVE_SOURCE_TIMEOUT_MS = 3000;
const RTSP_SOURCE_TIMEOUT_MS = 5000;

interface CameraPipeline {
  camera: Camera;
  locationName: string;
  detector: MotionDetector;
  syntheticStreamer: SyntheticStreamer;
  ffmpegStreamer?: FFmpegStreamer;
  streamInterval?: NodeJS.Timeout;
  isRunning: boolean;
  activeSource: 'synthetic' | 'device' | 'rtsp';
  lastDeviceFrameTime: number;
  lastRtspFrameTime: number;
  detectionInFlight: boolean;
  aiStatus: AiStatus;
  lastObjects: DetectedObject[];
}

export class CameraManager {
  private pipelines: Map<number, CameraPipeline> = new Map();

  public async init(): Promise<void> {
    logger.info('Initializing Camera Manager for 3 CCTV wheel-wash locations...');
    const cameras = db.getCameras();
    const locations = db.getLocations();

    for (const cam of cameras) {
      const loc = locations.find((l) => l.id === cam.location_id);
      const locName = loc ? loc.name : `Location ${cam.location_id}`;
      this.setupPipeline(cam, locName);
    }

    // Register handlers to receive real-time device camera frames (Webcam / USB / Bluetooth)
    registerDeviceCameraHandlers(
      (locationId, frameBase64) => this.handleDeviceFrame(locationId, frameBase64),
      (locationId) => this.handleDeviceDisconnect(locationId)
    );
  }

  private setupPipeline(cam: Camera, locName: string): void {
    let settings: CameraSettings;
    try {
      settings = JSON.parse(cam.detection_settings);
    } catch {
      settings = {
        roi: { x: 20, y: 35, width: 60, height: 45 },
        sensitivity: 65,
        minDurationMs: 1200,
        cooldownSeconds: 5,
      };
    }

    let config: CameraConfig;
    try {
      config = JSON.parse(cam.connection_configuration);
    } catch {
      config = {};
    }

    const detector = new MotionDetector(
      cam.location_id,
      locName,
      {
        roi: settings.roi,
        sensitivity: settings.sensitivity,
        minDurationMs: settings.minDurationMs,
        cooldownSeconds: settings.cooldownSeconds,
      },
      (locId) => this.handleVehiclePassage(locId, cam.id)
    );

    const syntheticStreamer = new SyntheticStreamer(cam.location_id, locName);

    const pipeline: CameraPipeline = {
      camera: cam,
      locationName: locName,
      detector,
      syntheticStreamer,
      isRunning: false,
      activeSource: 'synthetic',
      lastDeviceFrameTime: 0,
      lastRtspFrameTime: 0,
      detectionInFlight: false,
      aiStatus: 'simulated',
      lastObjects: [],
    };

    this.pipelines.set(cam.location_id, pipeline);
    this.configureRtsp(pipeline, config);
    this.startPipeline(cam.location_id);
  }

  /**
   * (Re)create the FFmpeg RTSP ingest for a pipeline. RTSP is only used when the camera
   * is explicitly configured with streamType 'rtsp' and a URL.
   */
  private configureRtsp(pipeline: CameraPipeline, config: CameraConfig): void {
    if (pipeline.ffmpegStreamer) {
      pipeline.ffmpegStreamer.stop();
      pipeline.ffmpegStreamer = undefined;
      pipeline.lastRtspFrameTime = 0;
    }

    if (!config.rtspUrl || config.streamType !== 'rtsp') return;

    const locationId = pipeline.camera.location_id;
    pipeline.ffmpegStreamer = new FFmpegStreamer(
      locationId,
      pipeline.locationName,
      config.rtspUrl,
      (frameBuffer) => {
        pipeline.lastRtspFrameTime = Date.now();
        // Device camera (operator webcam) takes priority over RTSP while it is streaming
        if (pipeline.activeSource === 'device' && Date.now() - pipeline.lastDeviceFrameTime < LIVE_SOURCE_TIMEOUT_MS) {
          return;
        }
        if (pipeline.activeSource !== 'rtsp') {
          pipeline.detector.reset();
          pipeline.lastObjects = [];
        }
        pipeline.activeSource = 'rtsp';
        this.handleLiveFrame(pipeline, `data:image/jpeg;base64,${frameBuffer.toString('base64')}`, 'rtsp');
      },
      (status) => {
        if (pipeline.camera.status === status) return;
        pipeline.camera.status = status;
        db.updateCamera(pipeline.camera.id, { status });
        broadcastCameraStatus({ cameraId: pipeline.camera.id, locationId, status, source: 'rtsp' });
      }
    );

    if (pipeline.isRunning) {
      pipeline.ffmpegStreamer.start();
    }
  }

  /**
   * Start stream ticking for a location
   */
  public startPipeline(locationId: number): void {
    const pipeline = this.pipelines.get(locationId);
    if (!pipeline || pipeline.isRunning) return;

    pipeline.isRunning = true;
    pipeline.ffmpegStreamer?.start();
    const fps = 6;
    const intervalMs = Math.round(1000 / fps);

    pipeline.streamInterval = setInterval(() => {
      if (!pipeline.isRunning) return;

      // If a live camera (device webcam/bluetooth or RTSP) is actively streaming, don't overwrite with synthetic
      const now = Date.now();
      if (pipeline.activeSource === 'device') {
        if (now - pipeline.lastDeviceFrameTime < LIVE_SOURCE_TIMEOUT_MS) {
          return;
        }
        logger.info(`Device camera stream for ${pipeline.locationName} timed out. Reverting to virtual feed.`);
        this.revertToVirtualFeed(pipeline);
      } else if (pipeline.activeSource === 'rtsp') {
        if (now - pipeline.lastRtspFrameTime < RTSP_SOURCE_TIMEOUT_MS) {
          return;
        }
        logger.info(`RTSP stream for ${pipeline.locationName} stalled. Showing virtual feed until it recovers.`);
        this.revertToVirtualFeed(pipeline);
      }

      const stage = pipeline.detector.getStage();
      const detConfig = pipeline.detector.getConfig();
      const classification = pipeline.detector.getClassification();
      const confidence = pipeline.detector.getConfidence();

      const { frameBase64, motionScore, spatialMassPercent, isHumanProfile } =
        pipeline.syntheticStreamer.getNextFrame(
          stage,
          classification,
          confidence,
          detConfig.roi
        );

      if (pipeline.camera.detection_enabled === 1) {
        pipeline.detector.processMotion(motionScore, spatialMassPercent, isHumanProfile);
      }

      const currentStage = pipeline.detector.getStage();
      const currentClassification = pipeline.detector.getClassification();
      const currentConfidence = pipeline.detector.getConfidence();

      broadcastCameraFrame({
        locationId: pipeline.camera.location_id,
        cameraId: pipeline.camera.id,
        timestamp: getKolkataTimestamp(),
        frameBase64,
        motionScore,
        isVehicleDetected: currentStage === 'IN_PASSAGE' || currentClassification === 'TRUCK_VERIFIED',
        stage: currentStage,
        classification: currentClassification,
        confidence: currentConfidence,
        source: 'synthetic',
        aiStatus: 'simulated',
      });
    }, intervalMs);

    logger.info(`Camera pipeline started for ${pipeline.locationName} (Location ID ${locationId})`);
  }

  /**
   * Handle incoming device camera frame from browser webcam / USB / Bluetooth camera.
   * Any client-side "metrics" are deliberately ignored: classification is done server-side by YOLO26.
   */
  public handleDeviceFrame(locationId: number, frameBase64: string): void {
    const pipeline = this.pipelines.get(locationId);
    if (!pipeline) return;

    if (pipeline.activeSource !== 'device') {
      // Switching from virtual/RTSP feed: start the passage state machine from a clean slate
      pipeline.detector.reset();
      pipeline.lastObjects = [];
    }
    pipeline.activeSource = 'device';
    pipeline.lastDeviceFrameTime = Date.now();

    this.handleLiveFrame(pipeline, frameBase64, 'device');
  }

  /**
   * Shared path for every real camera frame (device or RTSP):
   * 1) broadcast immediately so the control room sees a low-latency feed
   * 2) run YOLO26 (one request in flight per camera) and feed the passage state machine
   */
  private handleLiveFrame(pipeline: CameraPipeline, frameBase64: string, source: 'device' | 'rtsp'): void {
    this.broadcastLiveFrame(pipeline, frameBase64, source);

    if (pipeline.camera.detection_enabled !== 1 || pipeline.detectionInFlight) return;

    pipeline.detectionInFlight = true;
    this.runAiDetection(pipeline, frameBase64)
      .catch((err) => logger.error(`AI detection failed for ${pipeline.locationName}:`, err))
      .finally(() => {
        pipeline.detectionInFlight = false;
      });
  }

  private async runAiDetection(pipeline: CameraPipeline, frameBase64: string): Promise<void> {
    const result = await detectObjects(frameBase64);

    // The source may have switched back to the virtual feed while YOLO was running
    if (pipeline.activeSource === 'synthetic') return;

    if (!result) {
      // Detector offline: NEVER guess. Feed an empty scene so any pending entry decays without counting.
      pipeline.aiStatus = 'offline';
      pipeline.lastObjects = [];
      pipeline.detector.processDetection({ truckDetected: false, humanDetected: false, confidence: 0 });
      return;
    }

    const scene = analyzeDetections(result, pipeline.detector.getConfig().roi, {
      vehicleClasses: appConfig.yoloVehicleClasses,
      truckMinConfidence: appConfig.yoloTruckMinConfidence,
      personMinConfidence: appConfig.yoloPersonMinConfidence,
    });

    pipeline.aiStatus = 'online';
    pipeline.lastObjects = scene.objects;
    pipeline.detector.processDetection(scene);
  }

  private broadcastLiveFrame(pipeline: CameraPipeline, frameBase64: string, source: 'device' | 'rtsp'): void {
    const currentStage = pipeline.detector.getStage();
    const currentClassification = pipeline.detector.getClassification();

    // Broadcast frame to ALL connected users (Admin, Monitoring, Operators)
    broadcastCameraFrame({
      locationId: pipeline.camera.location_id,
      cameraId: pipeline.camera.id,
      timestamp: getKolkataTimestamp(),
      frameBase64,
      motionScore: 0,
      isVehicleDetected: currentStage === 'IN_PASSAGE' || currentClassification === 'TRUCK_VERIFIED',
      stage: currentStage,
      classification: currentClassification,
      confidence: pipeline.detector.getConfidence(),
      source,
      aiStatus: pipeline.aiStatus,
      objects: pipeline.lastObjects,
      roi: pipeline.detector.getConfig().roi,
    });
  }

  private revertToVirtualFeed(pipeline: CameraPipeline): void {
    pipeline.activeSource = 'synthetic';
    pipeline.lastDeviceFrameTime = 0;
    pipeline.aiStatus = 'simulated';
    pipeline.lastObjects = [];
    pipeline.detector.reset();
  }

  public handleDeviceDisconnect(locationId: number): void {
    const pipeline = this.pipelines.get(locationId);
    if (!pipeline || pipeline.activeSource !== 'device') return;

    this.revertToVirtualFeed(pipeline);
    logger.info(`Device camera disconnected for ${pipeline.locationName}. Reverted to virtual feed.`);
  }

  public stopPipeline(locationId: number): void {
    const pipeline = this.pipelines.get(locationId);
    if (!pipeline || !pipeline.isRunning) return;

    pipeline.isRunning = false;
    if (pipeline.streamInterval) {
      clearInterval(pipeline.streamInterval);
      pipeline.streamInterval = undefined;
    }
    if (pipeline.ffmpegStreamer) {
      pipeline.ffmpegStreamer.stop();
    }
    logger.info(`Camera pipeline stopped for ${pipeline.locationName}`);
  }

  private handleVehiclePassage(locationId: number, cameraId: number): void {
    const timestamp = getKolkataTimestamp();
    const pipeline = this.pipelines.get(locationId);
    const locName = pipeline ? pipeline.locationName : `Location ${locationId}`;

    const event = db.recordVehicleEvent({
      location_id: locationId,
      camera_id: cameraId,
      event_timestamp: timestamp,
      detection_source: 'automatic',
    });

    const countData = CountService.getLocationCount(locationId);
    const dashboardSummary = CountService.getDashboardSummary();

    logger.info(
      `[PASSAGE SAVED] Location: ${locName}, Event ID: ${event.id}, New Today Count: ${countData.total}`
    );

    broadcastVehicleDetected({
      locationId,
      locationName: locName,
      timestamp,
      todayCount: countData.total,
    });

    broadcastCountUpdated(dashboardSummary);
  }

  public triggerSimulatedPassage(locationId: number): boolean {
    const pipeline = this.pipelines.get(locationId);
    if (!pipeline) return false;

    pipeline.syntheticStreamer.triggerPassage();
    logger.info(`Simulated passage animation triggered for ${pipeline.locationName}`);
    return true;
  }

  public triggerSimulatedHumanWalk(locationId: number): boolean {
    const pipeline = this.pipelines.get(locationId);
    if (!pipeline) return false;

    pipeline.syntheticStreamer.triggerHumanWalk();
    logger.info(`Simulated pedestrian walk animation triggered for ${pipeline.locationName}`);
    return true;
  }

  public updateCameraSettings(cameraId: number, settings: Partial<CameraSettings>): Camera | undefined {
    const cam = db.getCameraById(cameraId);
    if (!cam) return undefined;

    let currentSettings: CameraSettings;
    try {
      currentSettings = JSON.parse(cam.detection_settings);
    } catch {
      currentSettings = {
        roi: { x: 20, y: 35, width: 60, height: 45 },
        sensitivity: 65,
        minDurationMs: 1200,
        cooldownSeconds: 5,
      };
    }

    const mergedSettings = { ...currentSettings, ...settings };
    const updated = db.updateCamera(cameraId, {
      detection_settings: JSON.stringify(mergedSettings),
    });

    const pipeline = this.pipelines.get(cam.location_id);
    if (pipeline) {
      pipeline.camera = updated!;
      pipeline.detector.updateConfig({
        roi: mergedSettings.roi,
        sensitivity: mergedSettings.sensitivity,
        minDurationMs: mergedSettings.minDurationMs,
        cooldownSeconds: mergedSettings.cooldownSeconds,
      });
    }

    return updated;
  }

  public setDetectionEnabled(cameraId: number, enabled: boolean): Camera | undefined {
    const cam = db.getCameraById(cameraId);
    if (!cam) return undefined;

    const updated = db.updateCamera(cameraId, {
      detection_enabled: enabled ? 1 : 0,
    });

    const pipeline = this.pipelines.get(cam.location_id);
    if (pipeline && updated) {
      pipeline.camera = updated;
    }

    return updated;
  }

  public updateCameraConfig(cameraId: number, config: Partial<CameraConfig>): Camera | undefined {
    const cam = db.getCameraById(cameraId);
    if (!cam) return undefined;

    let currentConfig: CameraConfig;
    try {
      currentConfig = JSON.parse(cam.connection_configuration);
    } catch {
      currentConfig = {};
    }

    const merged = { ...currentConfig, ...config };
    const updated = db.updateCamera(cameraId, {
      connection_configuration: JSON.stringify(merged),
    });

    const pipeline = this.pipelines.get(cam.location_id);
    const rtspChanged =
      merged.rtspUrl !== currentConfig.rtspUrl || merged.streamType !== currentConfig.streamType;
    if (pipeline && updated) {
      pipeline.camera = updated;
      if (rtspChanged) {
        this.configureRtsp(pipeline, merged);
        if (pipeline.activeSource === 'rtsp') this.revertToVirtualFeed(pipeline);
      }
    }

    return updated;
  }

  public getPipeline(locationId: number): CameraPipeline | undefined {
    return this.pipelines.get(locationId);
  }

  public shutdown(): void {
    logger.info('Shutting down all camera pipelines...');
    for (const [locId] of this.pipelines) {
      this.stopPipeline(locId);
    }
  }
}

export const cameraManager = new CameraManager();
