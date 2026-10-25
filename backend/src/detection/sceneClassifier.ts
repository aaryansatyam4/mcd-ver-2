import type { DetectedObject, Roi } from '../camera/types.js';
import type { YoloResult } from '../services/yoloDetector.js';

export interface SceneClassifierOptions {
  vehicleClasses: string[];
  truckMinConfidence: number;
  personMinConfidence: number;
  minRoiOverlap?: number; // fraction of the smaller of (box, ROI) that must overlap
  minTruckRoiCoverage?: number; // truck box must cover at least this fraction of the ROI
}

export interface SceneAnalysis {
  truckDetected: boolean;
  humanDetected: boolean;
  confidence: number; // 0-100, of the strongest object that decided the scene
  objects: DetectedObject[];
}

interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const area = (b: Box) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1);

function intersection(a: Box, b: Box): number {
  return area({
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
    x2: Math.min(a.x2, b.x2),
    y2: Math.min(a.y2, b.y2),
  });
}

function iou(a: Box, b: Box): number {
  const inter = intersection(a, b);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

/**
 * Turn raw YOLO detections into a Truck vs Human decision for the wheel-wash ROI.
 *
 * - Only boxes that overlap the ROI matter.
 * - A person NEVER counts. A person alone in the ROI is reported as human (ignored).
 * - A truck counts even if people (driver, washer) are also in the ROI.
 * - If a "truck" box is essentially the same box as a more confident "person" box,
 *   it is a misclassified person standing close to the camera, so it is dropped.
 */
export function analyzeDetections(
  result: YoloResult,
  roi: Roi,
  opts: SceneClassifierOptions
): SceneAnalysis {
  const minOverlap = opts.minRoiOverlap ?? 0.3;
  const minCoverage = opts.minTruckRoiCoverage ?? 0.1;
  const { width, height } = result;

  const roiBox: Box = {
    x1: (roi.x / 100) * width,
    y1: (roi.y / 100) * height,
    x2: ((roi.x + roi.width) / 100) * width,
    y2: ((roi.y + roi.height) / 100) * height,
  };
  const roiArea = area(roiBox);

  const overlapsRoi = (b: Box) => {
    const smaller = Math.min(area(b), roiArea);
    return smaller > 0 && intersection(b, roiBox) / smaller >= minOverlap;
  };

  const people: Array<{ box: Box; confidence: number }> = [];
  const trucks: Array<{ box: Box; confidence: number }> = [];

  for (const d of result.detections) {
    const [x1, y1, x2, y2] = d.bbox;
    const box = { x1, y1, x2, y2 };
    const name = d.class_name.toLowerCase();
    if (name === 'person' && d.confidence >= opts.personMinConfidence) {
      people.push({ box, confidence: d.confidence });
    } else if (opts.vehicleClasses.includes(name) && d.confidence >= opts.truckMinConfidence) {
      trucks.push({ box, confidence: d.confidence });
    }
  }

  const objects: DetectedObject[] = [];
  const toPercentBox = (b: Box) => ({
    x: (b.x1 / width) * 100,
    y: (b.y1 / height) * 100,
    width: ((b.x2 - b.x1) / width) * 100,
    height: ((b.y2 - b.y1) / height) * 100,
  });

  let bestTruck = 0;
  for (const t of trucks) {
    const isReallyPerson = people.some((p) => p.confidence >= t.confidence && iou(p.box, t.box) >= 0.5);
    const inRoi = overlapsRoi(t.box) && intersection(t.box, roiBox) / roiArea >= minCoverage;
    const counted = inRoi && !isReallyPerson;
    if (counted) bestTruck = Math.max(bestTruck, t.confidence);
    objects.push({ label: 'truck', confidence: Math.round(t.confidence * 100), box: toPercentBox(t.box), inRoi: counted });
  }

  let bestPerson = 0;
  for (const p of people) {
    const inRoi = overlapsRoi(p.box);
    if (inRoi) bestPerson = Math.max(bestPerson, p.confidence);
    objects.push({ label: 'person', confidence: Math.round(p.confidence * 100), box: toPercentBox(p.box), inRoi });
  }

  const truckDetected = bestTruck > 0;
  const humanDetected = !truckDetected && bestPerson > 0;

  return {
    truckDetected,
    humanDetected,
    confidence: Math.round((truckDetected ? bestTruck : bestPerson) * 100),
    objects,
  };
}
