import React, { useState, useEffect } from 'react';
import { Video, RefreshCw } from 'lucide-react';
import { dashboardService, demoService } from '../services/api.js';
import { useAuth } from '../contexts/AuthContext.js';
import { useSocket } from '../contexts/SocketContext.js';
import { CameraFeedPlayer } from '../components/CameraFeedPlayer.js';
import type { DashboardSummary } from '../types/index.js';

export const LiveMonitoringPage: React.FC = () => {
  const { user, isOperator } = useAuth();
  const { cameraFrames, latestSummary, watchCameras } = useSocket();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);

  // Only ask the server for camera frames while this page is shown: live video for the cameras on this page
  const watchedIds = summary?.locations.map((l) => l.locationId).join(',') ?? '';
  useEffect(() => {
    if (!watchedIds) return;
    return watchCameras(watchedIds.split(',').map(Number), 'live');
  }, [watchedIds, watchCameras]);

  const fetchSummary = async () => {
    try {
      const data = await dashboardService.getSummary();
      setSummary(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchSummary();
  }, []);

  useEffect(() => {
    if (latestSummary) {
      if (isOperator && user?.assigned_location_id) {
        const filtered = latestSummary.locations.filter(
          (l) => l.locationId === user.assigned_location_id
        );
        setSummary({
          ...latestSummary,
          locations: filtered,
        });
      } else {
        setSummary(latestSummary);
      }
    }
  }, [latestSummary, isOperator, user]);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-slate-200 gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Video className="w-6 h-6 text-blue-600" />
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight uppercase">
              Live CCTV Wheel-Wash Monitoring
            </h1>
          </div>
          <p className="text-xs text-slate-500 font-medium mt-1">
            Zero-latency live video streaming. Open device camera or connect external CCTV to view in real-time.
          </p>
        </div>

        <button
          onClick={fetchSummary}
          className="p-2 text-slate-600 hover:text-slate-900 bg-white border border-slate-200 rounded-lg shadow-2xs hover:bg-slate-50 transition-colors self-start sm:self-auto"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Grid of Cameras */}
      <div
        className={`grid gap-6 ${
          summary?.locations && summary.locations.length === 1
            ? 'grid-cols-1 max-w-3xl mx-auto'
            : 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'
        }`}
      >
        {summary?.locations.map((loc) => (
          <CameraFeedPlayer
            key={loc.locationId}
            locationId={loc.locationId}
            locationName={loc.locationName}
            todayCount={loc.todayCount}
            lastDetectionTime={loc.lastDetectionTime}
            cameraStatus={loc.cameraStatus}
            detectionActive={loc.detectionActive}
            frame={cameraFrames[loc.locationId]}
          />
        ))}
      </div>

      {/* Security & Reliability Banner */}
      <div className="p-4 rounded-xl bg-slate-900 text-slate-300 text-xs flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div>
          <span className="font-bold text-white uppercase tracking-wider block">
            Automatic Control Room Synchronization
          </span>
          <span className="text-slate-400 mt-0.5 block">
            When any operator or admin connects their device/Bluetooth camera, the live stream is immediately shared across all control room screens in real time.
          </span>
        </div>
      </div>
    </div>
  );
};
