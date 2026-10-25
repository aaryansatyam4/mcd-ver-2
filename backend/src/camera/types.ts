export type CameraStatus = 'online' | 'offline' | 'reconnecting' | 'error';

export type DetectionStage = 'IDLE' | 'ENTERED_ZONE' | 'IN_PASSAGE' | 'COOLDOWN';

export type ObjectClassification = 'NONE' | 'HUMAN_IGNORED' | 'TRUCK_VERIFIED';

export interface Roi {
  x: number; // percentage 0-100
  y: number; // percentage 0-100
  width: number; // percentage 0-100
  height: number; // percentage 0-100
}

export interface DetectedObject {
  label: 'truck' | 'person';
  confidence: number; // 0-100
  box: Roi; // percentage of frame
  inRoi: boolean; // true when this object influenced the wheel-wash zone decision
}

// 'simulated' = virtual demo feed, 'online'/'offline' = YOLO26 state for live camera frames
export type AiStatus = 'simulated' | 'online' | 'offline';

export interface MotionDetectionConfig {
  roi: Roi;
  sensitivity: number; // 1-100 (threshold for pixel difference)
  minDurationMs: number; // minimum time inside ROI to qualify as vehicle
  cooldownSeconds: number; // minimum wait after passage before next event
  minTruckAreaPercent?: number; // Minimum spatial mass (e.g. 35% of ROI) to distinguish truck from human
}

export interface StreamFrame {
  locationId: number;
  cameraId: number;
  timestamp: string;
  frameBase64: string;
  motionScore: number;
  isVehicleDetected: boolean;
  stage: DetectionStage;
  classification: ObjectClassification;
  confidence?: number;
  source?: 'synthetic' | 'device' | 'rtsp';
  aiStatus?: AiStatus;
  objects?: DetectedObject[];
  roi?: Roi;
}
