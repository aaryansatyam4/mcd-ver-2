import React, { useState } from 'react';
import { Camera as CameraIcon, ShieldCheck, AlertCircle, Zap, Clock, Smartphone, UserX, CheckCircle2 } from 'lucide-react';
import { StatusBadge } from './StatusBadge.js';
import { DeviceCameraConnector } from './DeviceCameraConnector.js';
import type { StreamFrame } from '../types/index.js';

interface CameraFeedPlayerProps {
  locationId: number;
  locationName: string;
  todayCount: number;
  lastDetectionTime: string | null;
  cameraStatus: 'online' | 'offline' | 'reconnecting' | 'error';
  detectionActive: boolean;
  frame?: StreamFrame;
}

export const CameraFeedPlayer: React.FC<CameraFeedPlayerProps> = ({
  locationId,
  locationName,
  todayCount,
  lastDetectionTime,
  cameraStatus,
  detectionActive,
  frame,
}) => {
  const [showDeviceModal, setShowDeviceModal] = useState(false);

  const isTruckVerified = frame?.classification === 'TRUCK_VERIFIED' || frame?.stage === 'IN_PASSAGE';
  const isHumanIgnored = frame?.classification === 'HUMAN_IGNORED';
  const isLiveSource = frame?.source === 'device' || frame?.source === 'rtsp';
  const isAiOffline = isLiveSource && detectionActive && frame?.aiStatus === 'offline';

  return (
    <div
      className={`bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm flex flex-col transition-all duration-300 ${
        isTruckVerified
          ? 'ring-2 ring-emerald-500 shadow-emerald-100'
          : isHumanIgnored
          ? 'ring-2 ring-amber-400 shadow-amber-50'
          : ''
      }`}
    >
      {/* Header Bar */}
      <div className="px-4 py-3 bg-slate-900 text-white flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center font-bold text-xs text-white">
            0{locationId}
          </div>
          <div>
            <h3 className="font-bold text-sm tracking-wide text-white">{locationName}</h3>
            <span className="text-[10px] text-slate-400 uppercase font-mono">WHEEL WASH BAY #1</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <StatusBadge status={cameraStatus} />
          {detectionActive ? (
            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-950/60 border border-emerald-800/80 px-2 py-0.5 rounded">
              <ShieldCheck className="w-3 h-3 text-emerald-400" />
              AI CLASSIFIER
            </span>
          ) : (
            <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold text-slate-400 bg-slate-800 border border-slate-700 px-2 py-0.5 rounded">
              <AlertCircle className="w-3 h-3 text-slate-400" />
              STANDBY
            </span>
          )}
        </div>
      </div>

      {/* Video Viewport */}
      <div className="relative aspect-video bg-slate-950 flex items-center justify-center overflow-hidden">
        {frame?.frameBase64 ? (
          <img
            src={frame.frameBase64}
            alt={`${locationName} Camera Stream`}
            className="w-full h-full object-contain select-none"
          />
        ) : (
          <div className="flex flex-col items-center justify-center text-slate-500 p-6 text-center">
            <CameraIcon className="w-12 h-12 mb-2 stroke-[1.5] animate-pulse text-slate-600" />
            <p className="text-sm font-semibold text-slate-400">CONNECTING TO FEED...</p>
            <p className="text-xs text-slate-600 mt-1">In-Memory Low-Latency Gateway</p>
          </div>
        )}

        {/* Live HUD Overlays */}
        <div className="absolute top-2.5 left-2.5 flex items-center gap-2 pointer-events-none">
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-black/75 backdrop-blur-sm text-[10px] font-mono text-white border border-white/10">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
            LIVE REC
          </div>
          {frame && !isLiveSource && (
            <div className="px-2 py-0.5 rounded bg-black/75 backdrop-blur-sm text-[10px] font-mono text-emerald-400 border border-white/10">
              MOTION: {frame.motionScore}%
            </div>
          )}
          {isLiveSource && frame?.aiStatus === 'online' && (
            <div className="px-2 py-0.5 rounded bg-black/75 backdrop-blur-sm text-[10px] font-mono text-emerald-400 border border-white/10">
              YOLO26 AI ACTIVE
            </div>
          )}
        </div>

        {/* Live camera: wheel-wash ROI and AI detections (virtual feed draws its own) */}
        {isLiveSource && frame?.roi && (
          <div
            className="absolute border-2 border-dashed border-sky-400/80 rounded pointer-events-none"
            style={{
              left: `${frame.roi.x}%`,
              top: `${frame.roi.y}%`,
              width: `${frame.roi.width}%`,
              height: `${frame.roi.height}%`,
            }}
          />
        )}
        {isLiveSource &&
          frame?.objects?.map((obj, i) => (
            <div
              key={i}
              className={`absolute border-2 rounded-sm pointer-events-none ${
                obj.label === 'truck'
                  ? obj.inRoi
                    ? 'border-emerald-400'
                    : 'border-emerald-400/40'
                  : 'border-amber-400'
              }`}
              style={{
                left: `${obj.box.x}%`,
                top: `${obj.box.y}%`,
                width: `${obj.box.width}%`,
                height: `${obj.box.height}%`,
              }}
            >
              <span
                className={`absolute -top-4 left-0 px-1 text-[9px] font-mono font-bold text-white whitespace-nowrap ${
                  obj.label === 'truck' ? 'bg-emerald-600' : 'bg-amber-500'
                }`}
              >
                {obj.label === 'truck' ? 'TRUCK' : 'PERSON (IGNORED)'} {obj.confidence}%
              </span>
            </div>
          ))}

        {isAiOffline && (
          <div className="absolute bottom-3 left-3 right-3 bg-rose-600/95 text-white text-xs font-bold px-3 py-1.5 rounded shadow-lg flex items-center justify-center gap-1.5 pointer-events-none">
            <AlertCircle className="w-4 h-4" />
            <span>AI DETECTOR OFFLINE — AUTOMATIC COUNTING PAUSED</span>
          </div>
        )}

        {/* Dynamic AI Classification Overlay */}
        {isTruckVerified && (
          <div className="absolute inset-0 bg-emerald-500/15 pointer-events-none flex items-center justify-center">
            <div className="bg-emerald-600 text-white font-extrabold text-sm px-4 py-2 rounded-lg shadow-xl uppercase tracking-wider flex items-center gap-2 animate-bounce">
              <CheckCircle2 className="w-4 h-4 fill-white" />
              HEAVY TRUCK CONFIRMED (+1 COUNT)
            </div>
          </div>
        )}

        {isHumanIgnored && !isAiOffline && (
          <div className="absolute bottom-3 left-3 right-3 bg-amber-500/95 text-white text-xs font-bold px-3 py-1.5 rounded shadow-lg flex items-center justify-center gap-1.5 pointer-events-none">
            <UserX className="w-4 h-4" />
            <span>PEDESTRIAN / WORKER DETECTED (FILTERED — NO COUNT)</span>
          </div>
        )}
      </div>

      {/* Metrics & Control Footer */}
      <div className="p-4 bg-white border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
            Today's Truck Count
          </span>
          <div className="flex items-baseline gap-2 mt-0.5">
            <span className="text-2xl font-black text-slate-900 font-mono tracking-tight">
              {todayCount.toLocaleString()}
            </span>
            <span className="text-xs font-semibold text-slate-500">TRUCKS</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-500 mt-1 font-mono">
            <Clock className="w-3.5 h-3.5 text-slate-400" />
            <span>Last Passage: {lastDetectionTime ? lastDetectionTime.split(' ')[1] : 'No events yet'}</span>
          </div>
        </div>

        {/* Connect Device / Bluetooth Camera button */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowDeviceModal(true)}
            className="px-3 py-1.5 text-xs font-bold text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 rounded-lg flex items-center gap-1.5 transition-colors shadow-2xs"
            title="Connect laptop webcam, USB camera, or Bluetooth camera directly"
          >
            <Smartphone className="w-3.5 h-3.5 text-blue-600" />
            <span>Open Camera</span>
          </button>
        </div>
      </div>

      {/* Device Camera Modal */}
      <DeviceCameraConnector
        isOpen={showDeviceModal}
        onClose={() => setShowDeviceModal(false)}
        locationId={locationId}
        locationName={locationName}
      />
    </div>
  );
};
