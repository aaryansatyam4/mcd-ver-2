/**
 * On-device YOLO26 truck detection (onnxruntime-web).
 *
 * The phone / laptop that streams a camera runs the model itself and sends only the raw detections
 * to the backend, which still decides what counts (ROI, thresholds, passage state machine).
 *
 * - The model and the onnxruntime WASM binary download automatically on first use and are kept
 *   in Cache Storage, so later visits load in about a second (and work without re-downloading).
 * - WebGPU is used when the browser has it; otherwise the plain CPU (WASM) build is loaded.
 */
import type * as OrtNamespace from 'onnxruntime-web';
import wasmCpuUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import wasmGpuUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';

type Ort = typeof OrtNamespace;

// Bump the file name when the model changes so every device downloads the new one
export const MODEL_URL = '/models/yolo26n-v1.onnx';
const CACHE_NAME = 'wheelwash-ai';

// The model was exported for 640x384; camera frames are 640x360 and get 12px of padding top and bottom
const INPUT_W = 640;
const INPUT_H = 384;
const FRAME_W = 640;
const FRAME_H = 360;
const PAD_Y = (INPUT_H - FRAME_H) / 2;
const MIN_CONFIDENCE = 0.25;

const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
  'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard',
  'cell phone', 'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase',
  'scissors', 'teddy bear', 'hair drier', 'toothbrush',
];

/** Same shape as the backend's YoloResult (backend/src/services/yoloDetector.ts). */
export interface YoloDetection {
  class_id: number;
  class_name: string;
  confidence: number;
  bbox: [number, number, number, number]; // [x1, y1, x2, y2] in frame pixels
}

export interface YoloResult {
  detections: YoloDetection[];
  inference_ms: number;
  width: number;
  height: number;
}

export type AiBackend = 'webgpu' | 'wasm';

/** Download progress 0..1, or null while the total size is unknown. */
export type LoadProgress = (fraction: number | null) => void;

export interface YoloModel {
  backend: AiBackend;
  /** Detect objects on a 640x360 frame (canvas, video or image). Call one at a time. */
  detect(source: CanvasImageSource): Promise<YoloResult>;
}

let modelPromise: Promise<YoloModel> | null = null;

/** Load (and cache) the model once per page. A failed load can be retried. */
export function loadYoloModel(onProgress?: LoadProgress): Promise<YoloModel> {
  if (!modelPromise) {
    modelPromise = createModel(onProgress).catch((err) => {
      modelPromise = null;
      throw err;
    });
  }
  return modelPromise;
}

async function hasWebGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) != null;
  } catch {
    return false;
  }
}

async function createModel(onProgress?: LoadProgress): Promise<YoloModel> {
  const useWebGpu = await hasWebGpu();
  const backend: AiBackend = useWebGpu ? 'webgpu' : 'wasm';
  const wasmUrl = useWebGpu ? wasmGpuUrl : wasmCpuUrl;

  // Combined progress over both downloads
  const loaded = [0, 0];
  const totals: Array<number | null> = [null, null];
  const report = () => {
    if (!onProgress) return;
    if (totals[0] === null || totals[1] === null) return onProgress(null);
    onProgress(Math.min(1, (loaded[0] + loaded[1]) / (totals[0] + totals[1])));
  };
  const tracker = (i: number) => (bytes: number, total: number | null) => {
    loaded[i] = bytes;
    totals[i] = total;
    report();
  };

  const [ort, modelBytes, wasmBytes] = await Promise.all([
    (useWebGpu ? import('onnxruntime-web/webgpu') : import('onnxruntime-web/wasm')) as Promise<Ort>,
    fetchCached(MODEL_URL, tracker(0)),
    fetchCached(wasmUrl, tracker(1)),
  ]);
  pruneCache([MODEL_URL, wasmUrl]);

  ort.env.wasm.wasmBinary = wasmBytes;
  // Multi-threading needs cross-origin isolation (COOP/COEP), which this site does not enable
  ort.env.wasm.numThreads = 1;

  const session = await ort.InferenceSession.create(new Uint8Array(modelBytes), {
    executionProviders: useWebGpu ? ['webgpu', 'wasm'] : ['wasm'],
    graphOptimizationLevel: 'all',
  });

  const canvas = document.createElement('canvas');
  canvas.width = INPUT_W;
  canvas.height = INPUT_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Canvas 2D is not available');

  const detect = async (source: CanvasImageSource): Promise<YoloResult> => {
    // Synchronous part: copy the frame before the caller draws the next one
    const input = new ort.Tensor('float32', preprocess(ctx, source), [1, 3, INPUT_H, INPUT_W]);

    const t0 = performance.now();
    const outputs = await session.run({ [session.inputNames[0]]: input });
    const inferenceMs = performance.now() - t0;

    const output = outputs[session.outputNames[0]];
    const detections = postprocess(output.data as Float32Array, output.dims);
    input.dispose();
    output.dispose();

    return { detections, inference_ms: Math.round(inferenceMs * 10) / 10, width: FRAME_W, height: FRAME_H };
  };

  // Warm-up so the first real frame is not slow (shader / kernel compilation)
  await detect(canvas);

  return { backend, detect };
}

/** Letterbox the frame into 640x384 (grey 114 padding) and convert RGBA to a normalised CHW tensor. */
function preprocess(ctx: CanvasRenderingContext2D, source: CanvasImageSource): Float32Array {
  ctx.fillStyle = 'rgb(114,114,114)';
  ctx.fillRect(0, 0, INPUT_W, INPUT_H);
  ctx.drawImage(source, 0, PAD_Y, FRAME_W, FRAME_H);
  const { data } = ctx.getImageData(0, 0, INPUT_W, INPUT_H);

  const plane = INPUT_W * INPUT_H;
  const tensor = new Float32Array(3 * plane);
  for (let i = 0, p = 0; p < plane; i += 4, p++) {
    tensor[p] = data[i] / 255;
    tensor[p + plane] = data[i + 1] / 255;
    tensor[p + 2 * plane] = data[i + 2] / 255;
  }
  return tensor;
}

/**
 * The exported model has NMS built in (backend/yolo/export_onnx.py) and returns [1, N, 6] rows of
 * x1, y1, x2, y2, score, class in input-image pixels. Undo the letterbox to get 640x360 frame pixels.
 */
function postprocess(data: Float32Array, dims: readonly number[]): YoloDetection[] {
  if (dims.length !== 3 || dims[2] !== 6) {
    throw new Error(`Unexpected YOLO output shape [${dims.join(', ')}]`);
  }
  const clamp = (v: number, max: number) => Math.round(Math.min(Math.max(v, 0), max) * 10) / 10;

  const detections: YoloDetection[] = [];
  for (let i = 0; i < dims[1]; i++) {
    const o = i * 6;
    const confidence = data[o + 4];
    if (confidence < MIN_CONFIDENCE) continue;
    const classId = Math.round(data[o + 5]);
    detections.push({
      class_id: classId,
      class_name: COCO_CLASSES[classId] ?? String(classId),
      confidence: Math.round(confidence * 10000) / 10000,
      bbox: [
        clamp(data[o], FRAME_W),
        clamp(data[o + 1] - PAD_Y, FRAME_H),
        clamp(data[o + 2], FRAME_W),
        clamp(data[o + 3] - PAD_Y, FRAME_H),
      ],
    });
  }
  return detections;
}

/** Fetch a static file through Cache Storage, reporting download progress. */
async function fetchCached(
  url: string,
  onBytes: (bytes: number, total: number | null) => void
): Promise<ArrayBuffer> {
  let cache: Cache | null = null;
  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) {
      const buffer = await hit.arrayBuffer();
      onBytes(buffer.byteLength, buffer.byteLength);
      return buffer;
    }
  } catch {
    // Cache Storage unavailable (private mode, insecure origin): download every time
    cache = null;
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to download ${url} (HTTP ${res.status})`);

  // Content-Length is the compressed size when the server compresses, so only trust it otherwise
  const length = Number(res.headers.get('Content-Length'));
  const total = !res.headers.get('Content-Encoding') && length > 0 ? length : null;
  const contentType = res.headers.get('Content-Type') || 'application/octet-stream';

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  onBytes(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onBytes(received, total);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  onBytes(received, received);

  cache?.put(url, new Response(bytes, { headers: { 'Content-Type': contentType } })).catch(() => {});
  return bytes.buffer;
}

/** Drop cached files from older model / runtime versions. */
function pruneCache(keep: string[]): void {
  const keepUrls = new Set(keep.map((u) => new URL(u, location.href).href));
  caches
    .open(CACHE_NAME)
    .then(async (cache) => {
      for (const req of await cache.keys()) {
        if (!keepUrls.has(req.url)) await cache.delete(req);
      }
    })
    .catch(() => {});
}
