import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export interface YoloDetection {
  class_id: number;
  class_name: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] in pixels
}

export interface YoloResult {
  detections: YoloDetection[];
  inference_ms: number;
  width: number;
  height: number;
}

let lastFailureLoggedAt = 0;

/**
 * Health-check the YOLO26 sidecar.
 */
export async function isYoloAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${config.yoloUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Run object detection on a base64 / data-URL JPEG or PNG frame.
 * Returns null when the sidecar is unreachable or errors, so callers can refuse to count.
 */
export async function detectObjects(imageBase64: string): Promise<YoloResult | null> {
  try {
    const res = await fetch(`${config.yoloUrl}/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageBase64 }),
      signal: AbortSignal.timeout(config.yoloTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    }
    return (await res.json()) as YoloResult;
  } catch (err) {
    // Throttle the warning so a down sidecar doesn't flood the logs at 6 fps x 3 cameras
    const now = Date.now();
    if (now - lastFailureLoggedAt > 30000) {
      lastFailureLoggedAt = now;
      logger.warn(
        `YOLO detection unavailable at ${config.yoloUrl} (${(err as Error).message}). Automatic counting paused for live cameras.`
      );
    }
    return null;
  }
}
