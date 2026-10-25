export type UserRole = 'admin' | 'operator' | 'monitoring';

export interface UserSafe {
  id: number;
  username: string;
  role: UserRole;
  assigned_location_id: number | null;
  assigned_location_name?: string | null;
  active: number;
  must_change_password: number;
  created_at: string;
  last_login: string | null;
}

export interface Location {
  id: number;
  name: string;
  active: number;
}

export interface CameraSettings {
  roi: { x: number; y: number; width: number; height: number };
  sensitivity: number;
  minDurationMs: number;
  cooldownSeconds: number;
}

export interface Camera {
  id: number;
  location_id: number;
  locationName: string;
  connection_configuration: string;
  detection_enabled: number;
  status: 'online' | 'offline' | 'reconnecting' | 'error';
  detection_settings: string;
  parsedSettings?: CameraSettings;
}

export interface LocationCountSummary {
  locationId: number;
  locationName: string;
  todayCount: number;
  automaticCount: number;
  manualAdjustment: number;
  lastDetectionTime: string | null;
  cameraStatus: 'online' | 'offline' | 'reconnecting' | 'error';
  detectionActive: boolean;
}

export interface DashboardSummary {
  date: string;
  totalTrucksToday: number;
  locations: LocationCountSummary[];
  recentEvents: Array<{
    id: number;
    locationName: string;
    timestamp: string;
    source: string;
  }>;
}

export interface CountAdjustment {
  id: number;
  location_id: number;
  locationName?: string;
  report_date: string;
  adjustment: number;
  previous_total: number;
  corrected_total: number;
  reason: string;
  modified_by: number;
  adminUsername?: string;
  created_at: string;
}

export interface AuditLog {
  id: number;
  user_id: number | null;
  username?: string;
  action: string;
  details: string;
  created_at: string;
}

export interface StreamFrame {
  locationId: number;
  cameraId: number;
  timestamp: string;
  frameBase64: string;
  motionScore: number;
  isVehicleDetected: boolean;
  stage: 'IDLE' | 'ENTERED_ZONE' | 'IN_PASSAGE' | 'COOLDOWN';
  classification?: 'NONE' | 'HUMAN_IGNORED' | 'TRUCK_VERIFIED';
  confidence?: number;
  source?: 'synthetic' | 'device' | 'rtsp';
  aiStatus?: 'simulated' | 'online' | 'offline';
  objects?: DetectedObject[];
  roi?: PercentBox;
}

export interface PercentBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DetectedObject {
  label: 'truck' | 'person';
  confidence: number;
  box: PercentBox;
  inRoi: boolean;
}
