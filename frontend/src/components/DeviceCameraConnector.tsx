import React, { useState, useEffect, useRef } from 'react';
import { Camera, Bluetooth, Video, Play, Square, RefreshCw, X, Radio, CheckCircle, Smartphone, Cpu } from 'lucide-react';
import { useSocket } from '../contexts/SocketContext.js';
import { loadYoloModel, type AiBackend, type YoloModel, type YoloResult } from '../ai/yoloBrowser.js';

type AiState =
  | { status: 'idle' }
  | { status: 'loading'; progress: number | null }
  | { status: 'ready'; backend: AiBackend; inferenceMs: number | null }
  | { status: 'unavailable' };

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
    try {
      const constraints: MediaStreamConstraints = {
        video: selectedDeviceId ? { deviceId: { exact: selectedDeviceId }, width: 640, height: 360 } : true,
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      mediaStreamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

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

        if (video.videoWidth > 0 && video.videoHeight > 0 && ctx) {
          canvas.width = 640;
          canvas.height = 360;
          ctx.drawImage(video, 0, 0, 640, 360);

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
                <span className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-mono font-bold">
                  <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                  BEAMING TO {locationName}
                </span>
                <span className="px-2 py-0.5 rounded bg-black/70 text-white text-[10px] font-mono">
                  {fpsCount} frames synced
                </span>
              </div>
            )}
          </div>

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
