import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type { YoloDetection, YoloResult } from '../src/services/yoloDetector.js';

// Mock the YOLO26 sidecar: each test decides what "the model sees" in the next frame
const yolo = vi.hoisted(() => ({ next: null as YoloResult | null }));
vi.mock('../src/services/yoloDetector.js', () => ({
  detectObjects: vi.fn(async () => yolo.next),
  isYoloAvailable: vi.fn(async () => yolo.next !== null),
}));

import { analyzeDetections } from '../src/detection/sceneClassifier.js';
import { MotionDetector } from '../src/detection/motionDetector.js';
import { CameraManager } from '../src/camera/cameraManager.js';
import { CountService } from '../src/services/countService.js';
import { db } from '../src/database/excelDb.js';
import { canIngestCamera } from '../src/sockets/socketServer.js';

const ROI = { x: 20, y: 35, width: 60, height: 45 }; // 128..512 x 126..288 on a 640x360 frame
const OPTS = { vehicleClasses: ['truck', 'bus'], truckMinConfidence: 0.45, personMinConfidence: 0.35 };
const FRAME = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

const person = (bbox: YoloDetection['bbox'], confidence = 0.88): YoloDetection => ({
  class_id: 0,
  class_name: 'person',
  confidence,
  bbox,
});
const truck = (bbox: YoloDetection['bbox'], confidence = 0.82): YoloDetection => ({
  class_id: 7,
  class_name: 'truck',
  confidence,
  bbox,
});
const scene = (...detections: YoloDetection[]): YoloResult => ({
  detections,
  inference_ms: 20,
  width: 640,
  height: 360,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('YOLO scene classifier (Truck vs Human)', () => {
  it('a person in the wheel-wash zone is human, never a truck', () => {
    const res = analyzeDetections(scene(person([300, 150, 360, 330])), ROI, OPTS);
    expect(res.truckDetected).toBe(false);
    expect(res.humanDetected).toBe(true);
  });

  it('a person standing right in front of the camera (filling the frame) is still human', () => {
    const res = analyzeDetections(scene(person([60, 0, 600, 360], 0.93)), ROI, OPTS);
    expect(res.truckDetected).toBe(false);
    expect(res.humanDetected).toBe(true);
  });

  it('a "truck" box that is really the same box as a more confident person is rejected', () => {
    const res = analyzeDetections(scene(person([100, 20, 560, 350], 0.9), truck([110, 30, 550, 350], 0.5)), ROI, OPTS);
    expect(res.truckDetected).toBe(false);
    expect(res.humanDetected).toBe(true);
  });

  it('a truck in the zone is detected, even with the driver / washer also visible', () => {
    const res = analyzeDetections(scene(truck([100, 120, 560, 330]), person([520, 160, 560, 300])), ROI, OPTS);
    expect(res.truckDetected).toBe(true);
    expect(res.humanDetected).toBe(false);
    expect(res.confidence).toBe(82);
  });

  it('a truck outside the zone, or a low-confidence truck, is ignored', () => {
    expect(analyzeDetections(scene(truck([0, 0, 120, 100])), ROI, OPTS).truckDetected).toBe(false);
    expect(analyzeDetections(scene(truck([100, 120, 560, 330], 0.3)), ROI, OPTS).truckDetected).toBe(false);
  });

  it('cars and other classes never count', () => {
    const car: YoloDetection = { class_id: 2, class_name: 'car', confidence: 0.95, bbox: [100, 120, 560, 330] };
    const res = analyzeDetections(scene(car), ROI, OPTS);
    expect(res.truckDetected).toBe(false);
    expect(res.humanDetected).toBe(false);
  });
});

describe('MotionDetector.processDetection (AI-driven passage counting)', () => {
  const makeDetector = (onCount: () => void) =>
    new MotionDetector(1, 'GHAZIPUR', { roi: ROI, sensitivity: 65, minDurationMs: 40, cooldownSeconds: 0.2 }, onCount);

  it('people lingering in the zone for a long time never increment the counter', async () => {
    let count = 0;
    const det = makeDetector(() => count++);
    for (let i = 0; i < 20; i++) {
      const r = det.processDetection({ truckDetected: false, humanDetected: true, confidence: 90 });
      expect(r.classification).toBe('HUMAN_IGNORED');
      await sleep(10);
    }
    expect(count).toBe(0);
    expect(det.getStage()).toBe('IDLE');
  });

  it('a truck that stays in the bay with missed frames is counted exactly once', async () => {
    let count = 0;
    const det = makeDetector(() => count++);
    const T = { truckDetected: true, humanDetected: false, confidence: 85 };
    const EMPTY = { truckDetected: false, humanDetected: false, confidence: 0 };

    det.processDetection(T);
    await sleep(50);
    det.processDetection(T); // confirmed: +1
    expect(count).toBe(1);

    // Truck keeps being washed; YOLO occasionally misses it and sees only the washer
    for (let i = 0; i < 10; i++) {
      await sleep(30);
      det.processDetection(i % 3 === 0 ? { truckDetected: false, humanDetected: true, confidence: 80 } : T);
    }
    expect(count).toBe(1);

    // Truck leaves; zone clears for longer than the cooldown
    await sleep(450);
    det.processDetection(EMPTY);
    await sleep(250);
    det.processDetection(EMPTY);
    expect(det.getStage()).toBe('IDLE');

    // Next truck: +1
    det.processDetection(T);
    await sleep(50);
    det.processDetection(T);
    expect(count).toBe(2);
  });

  it('a single false-positive truck frame does not count', async () => {
    let count = 0;
    const det = makeDetector(() => count++);
    det.processDetection({ truckDetected: true, humanDetected: false, confidence: 60 });
    await sleep(900);
    det.processDetection({ truckDetected: false, humanDetected: false, confidence: 0 });
    expect(count).toBe(0);
    expect(det.getStage()).toBe('IDLE');
  });
});

describe('CameraManager live camera pipeline (YOLO26)', () => {
  let manager: CameraManager;

  beforeAll(async () => {
    await db.init();
    for (const cam of db.getCameras()) {
      db.updateCamera(cam.id, {
        detection_settings: JSON.stringify({ roi: ROI, sensitivity: 65, minDurationMs: 40, cooldownSeconds: 0.2 }),
      });
    }
    manager = new CameraManager();
    await manager.init();
  });

  afterAll(() => {
    manager.shutdown();
  });

  beforeEach(() => {
    manager.handleDeviceDisconnect(2);
  });

  // Push a frame and wait for the async YOLO round-trip to complete
  const pushFrame = async (result: YoloResult | null) => {
    yolo.next = result;
    manager.handleDeviceFrame(2, FRAME);
    await sleep(60);
  };

  it('a worker walking through a webcam feed never increments the count', async () => {
    const before = CountService.getLocationCount(2).total;
    for (let i = 0; i < 10; i++) {
      await pushFrame(scene(person([250 + i * 10, 140, 320 + i * 10, 330])));
    }
    // even standing very close to the camera
    for (let i = 0; i < 5; i++) {
      await pushFrame(scene(person([40, 0, 620, 360], 0.95)));
    }
    expect(manager.getPipeline(2)!.detector.getClassification()).toBe('HUMAN_IGNORED');
    expect(CountService.getLocationCount(2).total).toBe(before);
  });

  it('a truck driving through a webcam feed increments the count by exactly 1', async () => {
    const before = CountService.getLocationCount(2).total;
    for (let i = 0; i < 6; i++) {
      await pushFrame(scene(truck([100, 110, 560, 330]), person([530, 150, 560, 290])));
    }
    expect(CountService.getLocationCount(2).total).toBe(before + 1);
    expect(db.getLatestEventByLocation(2)?.detection_source).toBe('automatic');
  });

  it('never counts when the YOLO detector is offline (no guessing from pixels)', async () => {
    const before = CountService.getLocationCount(2).total;
    for (let i = 0; i < 6; i++) {
      await pushFrame(null);
    }
    expect(manager.getPipeline(2)!.aiStatus).toBe('offline');
    expect(CountService.getLocationCount(2).total).toBe(before);
  });

  it('does not count when detection is disabled for the camera', async () => {
    const cam = db.getCameras().find((c) => c.location_id === 2)!;
    manager.setDetectionEnabled(cam.id, false);
    const before = CountService.getLocationCount(2).total;
    for (let i = 0; i < 6; i++) {
      await pushFrame(scene(truck([100, 110, 560, 330])));
    }
    expect(CountService.getLocationCount(2).total).toBe(before);
    manager.setDetectionEnabled(cam.id, true);
  });

  it('only admins and the assigned operator may stream a camera into a location', () => {
    const tokenFor = (username: string) => {
      const u = db.getUsers().find((x) => x.username === username)!;
      return { userId: u.id, username: u.username, role: u.role, assignedLocationId: u.assigned_location_id };
    };
    expect(canIngestCamera(undefined, 2)).toBe(false);
    expect(canIngestCamera(tokenFor('admin'), 2)).toBe(true);
    expect(canIngestCamera(tokenFor('okhla'), 2)).toBe(true);
    expect(canIngestCamera(tokenFor('ghazipur'), 2)).toBe(false);
    expect(canIngestCamera(tokenFor('monitoring'), 2)).toBe(false);
  });
});
