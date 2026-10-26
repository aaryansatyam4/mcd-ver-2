import React, { useState, useEffect, useRef } from 'react';
import { Camera, Bluetooth, Video, Play, Square, RefreshCw, X, Radio, CheckCircle, Smartphone, Cpu, AlertTriangle } from 'lucide-react';
import { useSocket } from '../contexts/SocketContext.js';
import { loadYoloModel, type AiBackend, type YoloModel, type YoloResult } from '../ai/yoloBrowser.js';

type AiState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number | null }
  | { status: 'ready'; backend: AiBackend; inferenceMs: number | null }
  | { status: 'unavailable' };

// Why the live picture is not coming through. USB webcams drop out when Windows suspends the port,
// the cable is loose or another app takes the camera; the browser then shows a black picture.
type CameraIssue = 'disconnected' | 'stalled' | 'black';

const CAMERA_ISSUES: Record<CameraIssue, { title: string; hint: string }> = {
  disconnected: {
    title: 'Camera disconnected. Reconnecting…',
    hint: 'Check the USB cable and plug the camera straight into the PC (no hub or extension).',
  },
  stalled: {
    title: 'Camera stopped sending video. Restarting it…',
    hint: 'Close any other app or tab that uses the camera (Windows Camera, Teams, WhatsApp).',
  },
  black: {
    title: 'Camera is sending a black picture.',
    hint: 'Check the lens cover, the lighting and the USB cable. The camera is restarted automatically.',
  },
};

const RECONNECT_DELAY_MS = 3000;
const STALLED_RESTART_MS = 5000; // no frames from the camera for this long -> restart it
const BLACK_RESTART_MS = 10000; // black picture for this long -> restart the camera
const BLACK_RESTART_GAP_MS = 60000; // at most one black-picture restart a minute (e.g. a dark night)
const BLACK_CHECK_MS = 1000;

/** True when every pixel is close to black (a real scene, even at night, has some light in it) */
function isBlackFrame(source: HTMLCanvasElement, probe: HTMLCanvasElement): boolean {
  probe.width = 32;
  probe.height = 18;
  const ctx = probe.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(source, 0, 0, probe.width, probe.height);
  const pixels = ctx.getImageData(0, 0, probe.width, probe.height).data;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] > 20 || pixels[i + 1] > 20 || pixels[i + 2] > 20) return false;
  }
  return true;
}

interface DeviceCameraConnectorProps {
  isOpen: boolean;
  onClose: () => void;
  locationId: number;
  locationName: string;
}

export const DeviceCameraConnector: React.FC<DeviceCameraConnectorProps> = ({
  isOpen,
  onClose,
  locationId,
  locationName,
}) => {
  const { socket } = useSocket();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [fpsCount, setFpsCount] = useState<number>(0);
  const [aiState, setAiState] = useState<AiState>({ status: 'idle' });
  const [cameraIssue, setCameraIssue] = useState<CameraIssue | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const streamIntervalRef = useRef<any>(null);
  const isStreamingRef = useRef<boolean>(false);
  const modelRef = useRef<YoloModel | null>(null);
  const inferenceBusyRef = useRef<boolean>(false);
  // Newest on-device result not yet sent; each result rides along with exactly one frame
  const pendingDetectionsRef = useRef<YoloResult | null>(null);
  const lastInferenceUiUpdateRef = useRef<number>(0);

  // Camera health: the device being streamed, so it can be reopened after it drops out
  const activeDeviceRef = useRef<{ deviceId: string; label: string } | null>(null);
  const cameraIssueRef = useRef<CameraIssue | null>(null);
  const restartingRef = useRef<boolean>(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stalledTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const blackSinceRef = useRef<number | null>(null);
  const lastBlackCheckRef = useRef<number>(0);
  const lastBlackRestartRef = useRef<number>(0);
  const probeCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Enumerate cameras (webcams, USB cams, Bluetooth cams, phone/continuity cams)
  const enumerateCameras = async () => {
    try {
      // Request initial permission to expose device labels
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      tempStream.getTracks().forEach((track) => track.stop());

      const allDevices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = allDevices.filter((d) => d.kind === 'videoinput');
      setDevices(videoInputs);
      if (videoInputs.length > 0 && !selectedDeviceId) {
        setSelectedDeviceId(videoInputs[0].deviceId);
      }
    } catch (err: any) {
      setStreamError('Camera access permission denied or device not found.');
    }
  };

  useEffect(() => {
    if (isOpen) {
      enumerateCameras();
    } else {
      stopStreaming();
    }
  }, [isOpen]);

  // No reconnect attempts after the dialog is gone
  useEffect(() => {
    return () => {
      isStreamingRef.current = false;
      clearCameraTimers();
    };
  }, []);

  const showCameraIssue = (issue: CameraIssue | null) => {
    cameraIssueRef.current = issue;
    setCameraIssue(issue);
  };

  const clearCameraTimers = () => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    if (stalledTimerRef.current) clearTimeout(stalledTimerRef.current);
    reconnectTimerRef.current = null;
    stalledTimerRef.current = null;
  };

  /** Open the selected camera and show it in the preview. Throws when the camera cannot be opened. */
  const openCamera = async (deviceId: string): Promise<MediaStream> => {
    const constraints: MediaStreamConstraints = {
      video: deviceId ? { deviceId: { exact: deviceId }, width: 640, height: 360 } : true,
      audio: false,
    };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    mediaStreamRef.current = stream;

    const track = stream.getVideoTracks()[0];
    if (track) {
      activeDeviceRef.current = { deviceId: track.getSettings().deviceId || deviceId, label: track.label };
      // The camera was unplugged, suspended by Windows or taken by another app
      track.addEventListener('ended', () => {
        if (mediaStreamRef.current === stream) restartCamera('disconnected');
      });
      // No frames arriving; give the camera a moment before restarting it
      track.addEventListener('mute', () => {
        if (mediaStreamRef.current !== stream || stalledTimerRef.current) return;
        stalledTimerRef.current = setTimeout(() => {
          stalledTimerRef.current = null;
          if (mediaStreamRef.current === stream && track.muted) restartCamera('stalled');
        }, STALLED_RESTART_MS);
      });
      track.addEventListener('unmute', () => {
        if (stalledTimerRef.current) clearTimeout(stalledTimerRef.current);
        stalledTimerRef.current = null;
      });
    }

    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
    return stream;
  };

  /** Release the current camera and open it again, retrying every few seconds until it is back */
  const restartCamera = async (issue: CameraIssue) => {
    if (!isStreamingRef.current || restartingRef.current) return;
    restartingRef.current = true;
    showCameraIssue(issue);
    clearCameraTimers();
    blackSinceRef.current = null;

    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;

    try {
      const device = activeDeviceRef.current;
      let stream: MediaStream;
      try {
        stream = await openCamera(device?.deviceId ?? selectedDeviceId);
      } catch (err) {
        // After a replug the camera can come back under a new id; find it again by name
        const cameras = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        const same = device?.label ? cameras.find((d) => d.label === device.label) : undefined;
        if (!same || same.deviceId === device?.deviceId) throw err;
        stream = await openCamera(same.deviceId);
        setSelectedDeviceId(same.deviceId);
      }
      // Streaming was stopped while the camera was reopening
      if (!isStreamingRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        if (mediaStreamRef.current === stream) mediaStreamRef.current = null;
        return;
      }
      // A black picture keeps its warning until the picture is back; the frame check clears it
      if (issue !== 'black') showCameraIssue(null);
    } catch (err) {
      console.warn('Camera restart failed, trying again:', err);
      showCameraIssue('disconnected');
      if (isStreamingRef.current) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          restartCamera('disconnected');
        }, RECONNECT_DELAY_MS);
      }
    } finally {
      restartingRef.current = false;
    }
  };

  /** Called about once a second with the frame just captured: restart the camera if it stays black */
  const checkForBlackPicture = (canvas: HTMLCanvasElement) => {
    if (!probeCanvasRef.current) probeCanvasRef.current = document.createElement('canvas');
    const now = Date.now();

    if (!isBlackFrame(canvas, probeCanvasRef.current)) {
      blackSinceRef.current = null;
      if (cameraIssueRef.current === 'black') showCameraIssue(null);
      return;
    }

    blackSinceRef.current ??= now;
    if (now - blackSinceRef.current < BLACK_RESTART_MS) return;
    if (cameraIssueRef.current !== 'black') showCameraIssue('black');
    if (now - lastBlackRestartRef.current >= BLACK_RESTART_GAP_MS) {
      lastBlackRestartRef.current = now;
      restartCamera('black');
    }
  };

  // Server refuses frames from users who may not stream to this location
  useEffect(() => {
    if (!socket) return;
    const onRejected = (data: { locationId: number; reason: string }) => {
      if (data.locationId !== locationId) return;
      setStreamError(data.reason);
      stopStreaming();
    };
    socket.on('camera:ingest_rejected', onRejected);
    return () => {
      socket.off('camera:ingest_rejected', onRejected);
    };
  }, [socket, locationId]);

  const startStreaming = async () => {
    setStreamError(null);
    showCameraIssue(null);
    blackSinceRef.current = null;
    lastBlackRestartRef.current = 0;
    try {
      await openCamera(selectedDeviceId);

      setIsStreaming(true);
      isStreamingRef.current = true;
      loadOnDeviceAi();

      // Canvas frame pump to backend via WebSockets.
      // YOLO26 runs on this device; its raw detections ride along with the frames and the
      // backend decides what counts (truck vs human, ROI, passage). Frames sent before the model
      // is ready (or on devices that cannot run it) fall back to server-side detection.
      const fps = 6;
      let framesSent = 0;
      const intervalMs = Math.round(1000 / fps);

      streamIntervalRef.current = setInterval(() => {
        if (!videoRef.current || !canvasRef.current || !socket) return;

        const video = videoRef.current;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');

        // Skip while the camera is being reopened or has no picture yet
        if (restartingRef.current || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;

        if (video.videoWidth > 0 && video.videoHeight > 0 && ctx) {
          canvas.width = 640;
          canvas.height = 360;
          ctx.drawImage(video, 0, 0, 640, 360);

          const now = Date.now();
          if (now - lastBlackCheckRef.current >= BLACK_CHECK_MS) {
            lastBlackCheckRef.current = now;
            checkForBlackPicture(canvas);
          }

          const detections = pendingDetectionsRef.current;
          pendingDetectionsRef.current = null;
          socket.emit('camera:ingest_frame', {
            locationId,
            frameBase64: canvas.toDataURL('image/jpeg', 0.7),
            ...(detections ? { detections } : {}),
          });

          runDetection(canvas);

          framesSent++;
          setFpsCount(framesSent);
        }
      }, intervalMs);
    } catch (err: any) {
      setStreamError(err.message || 'Failed to start camera device.');
      setIsStreaming(false);
    }
  };

  // Download (first time) or load from cache the YOLO26 model; streaming continues meanwhile
  const loadOnDeviceAi = () => {
    if (modelRef.current) {
      setAiState({ status: 'ready', backend: modelRef.current.backend, inferenceMs: null });
      return;
    }
    setAiState({ status: 'loading', progress: null });
    loadYoloModel((progress) => {
      if (isStreamingRef.current) setAiState({ status: 'loading', progress });
    })
      .then((model) => {
        modelRef.current = model;
        if (isStreamingRef.current) setAiState({ status: 'ready', backend: model.backend, inferenceMs: null });
      })
      .catch((err) => {
        console.warn('On-device AI unavailable, falling back to server-side detection:', err);
        if (isStreamingRef.current) setAiState({ status: 'unavailable' });
      });
  };

  // At most one inference in flight; the frame is copied synchronously so the canvas can be redrawn
  const runDetection = (canvas: HTMLCanvasElement) => {
    const model = modelRef.current;
    if (!model || inferenceBusyRef.current) return;

    inferenceBusyRef.current = true;
    model
      .detect(canvas)
      .then((result) => {
        if (!isStreamingRef.current) return;
        pendingDetectionsRef.current = result;
        const now = Date.now();
        if (now - lastInferenceUiUpdateRef.current > 1000) {
          lastInferenceUiUpdateRef.current = now;
          setAiState({ status: 'ready', backend: model.backend, inferenceMs: result.inference_ms });
        }
      })
      .catch((err) => console.warn('On-device detection failed:', err))
      .finally(() => {
        inferenceBusyRef.current = false;
      });
  };

  const stopStreaming = () => {
    clearCameraTimers();
    showCameraIssue(null);
    blackSinceRef.current = null;
    activeDeviceRef.current = null;

    if (streamIntervalRef.current) {
      clearInterval(streamIntervalRef.current);
      streamIntervalRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    if (socket && isStreamingRef.current) {
      socket.emit('camera:disconnect_device', { locationId });
    }

    isStreamingRef.current = false;
    pendingDetectionsRef.current = null;
    setIsStreaming(false);
    setFpsCount(0);
    setAiState({ status: 'idle' });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 max-w-xl w-full overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center text-white">
              <Camera className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-white">Connect Device Camera ({locationName})</h3>
              <p className="text-xs text-slate-400">
                Stream live from laptop webcam, USB, Bluetooth, or wireless camera
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              stopStreaming();
              onClose();
            }}
            className="text-slate-400 hover:text-white p-1 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-4">
          {streamError && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs">
              {streamError}
            </div>
          )}

          {/* Device Selector */}
          <div>
            <label className="block text-xs font-bold text-slate-700 uppercase tracking-wider mb-1.5 flex items-center justify-between">
              <span>Select Video Source (Webcam / Bluetooth / USB)</span>
              <button
                type="button"
                onClick={enumerateCameras}
                className="text-[11px] text-blue-600 hover:text-blue-700 font-semibold flex items-center gap-1"
              >
                <RefreshCw className="w-3 h-3" />
                Scan Devices
              </button>
            </label>
            <select
              value={selectedDeviceId}
              disabled={isStreaming}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              className="w-full text-xs rounded-lg border border-slate-300 p-2.5 bg-slate-50 font-medium focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:opacity-60"
            >
              {devices.length > 0 ? (
                devices.map((d, index) => (
                  <option key={d.deviceId || index} value={d.deviceId}>
                    {d.label || `Camera Device #${index + 1}`}
                  </option>
                ))
              ) : (
                <option value="">No cameras detected yet</option>
              )}
            </select>
          </div>

          {/* Live Video Preview Box */}
          <div className="relative aspect-video bg-slate-950 rounded-xl overflow-hidden border border-slate-800 flex items-center justify-center">
            <video
              ref={videoRef}
              playsInline
              muted
              className={`w-full h-full object-cover ${!isStreaming ? 'hidden' : ''}`}
            />

            {!isStreaming && (
              <div className="text-center text-slate-500 p-6">
                <Video className="w-10 h-10 mx-auto mb-2 text-slate-600" />
                <p className="text-xs font-semibold text-slate-400">CAMERA PREVIEW READY</p>
                <p className="text-[11px] text-slate-600 mt-1">
                  Click 'Start Live Stream' to beam this camera to {locationName}
                </p>
              </div>
            )}

            {isStreaming && (
              <div className="absolute top-2.5 left-2.5 flex items-center gap-2">
                {cameraIssue ? (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500 text-white text-[10px] font-mono font-bold">
                    <AlertTriangle className="w-3 h-3" />
                    {cameraIssue === 'black' ? 'NO PICTURE' : 'RECONNECTING'}
                  </span>
                ) : (
                  <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-mono font-bold">
                    <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                    BEAMING TO {locationName}
                  </span>
                )}
                <span className="px-2 py-0.5 rounded bg-black/70 text-white text-[10px] font-mono">
                  {fpsCount} frames synced
                </span>
              </div>
            )}
          </div>

          {/* Camera health */}
          {isStreaming && cameraIssue && (
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
              <div className="font-bold flex items-center gap-1.5 mb-0.5">
                <AlertTriangle className="w-4 h-4 text-amber-600" />
                {CAMERA_ISSUES[cameraIssue].title}
              </div>
              {CAMERA_ISSUES[cameraIssue].hint}
            </div>
          )}

          {/* On-device AI status */}
          {aiState.status === 'loading' && (
            <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700">
              <div className="flex items-center justify-between font-semibold mb-1.5">
                <span className="flex items-center gap-1.5">
                  <Cpu className="w-4 h-4 text-blue-600" />
                  Loading AI model…
                </span>
                {aiState.progress !== null && <span className="font-mono">{Math.round(aiState.progress * 100)}%</span>}
              </div>
              <div className="h-1.5 rounded-full bg-slate-200 overflow-hidden">
                <div
                  className={`h-full bg-blue-600 transition-all ${aiState.progress === null ? 'w-1/3 animate-pulse' : ''}`}
                  style={aiState.progress !== null ? { width: `${Math.round(aiState.progress * 100)}%` } : undefined}
                />
              </div>
              <p className="text-[11px] text-slate-500 mt-1.5">One-time download; next time it loads instantly from this device.</p>
            </div>
          )}
          {aiState.status === 'ready' && (
            <div className="px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-800 flex items-center justify-between">
              <span className="flex items-center gap-1.5 font-semibold">
                <Cpu className="w-4 h-4" />
                On-device AI active ({aiState.backend === 'webgpu' ? 'GPU' : 'CPU'})
              </span>
              {aiState.inferenceMs !== null && <span className="font-mono">{Math.round(aiState.inferenceMs)} ms / frame</span>}
            </div>
          )}
          {aiState.status === 'unavailable' && (
            <div className="px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800">
              AI is unavailable on this device. The stream continues and counting uses the server detector if one is running.
            </div>
          )}

          {/* Hidden Canvas for Frame Processing */}
          <canvas ref={canvasRef} className="hidden" />

          {/* Informational Banner */}
          <div className="p-3 bg-blue-50/80 border border-blue-200 rounded-lg text-xs text-blue-900">
            <div className="font-bold flex items-center gap-1.5 mb-0.5">
              <CheckCircle className="w-4 h-4 text-blue-600" />
              Live Control Room Synchronization
            </div>
            As soon as you start streaming, Master Admin and all monitoring dashboards will see your live camera view in <strong className="font-semibold">{locationName}</strong> automatically, and the YOLO26 AI running on this device will count passing trucks. People and workers are never counted.
          </div>

          {/* Buttons */}
          <div className="flex items-center justify-end gap-3 pt-2">
            {!isStreaming ? (
              <button
                type="button"
                onClick={startStreaming}
                className="px-5 py-2.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-lg shadow-sm flex items-center gap-1.5 transition-colors"
              >
                <Play className="w-4 h-4 fill-white" />
                Start Live Stream
              </button>
            ) : (
              <button
                type="button"
                onClick={stopStreaming}
                className="px-5 py-2.5 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-lg shadow-sm flex items-center gap-1.5 transition-colors"
              >
                <Square className="w-4 h-4 fill-white" />
                Stop Streaming (Revert to Virtual)
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
