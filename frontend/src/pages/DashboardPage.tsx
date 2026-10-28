import React, { useState, useEffect } from 'react';
import {
  Truck,
  MapPin,
  RefreshCw,
  Layers,
} from 'lucide-react';
import { dashboardService, demoService } from '../services/api.js';
import { useAuth } from '../contexts/AuthContext.js';
import { useSocket } from '../contexts/SocketContext.js';
import { StatCard } from '../components/StatCard.js';
import { CameraFeedPlayer } from '../components/CameraFeedPlayer.js';
import { HourlyChart } from '../components/HourlyChart.js';
import type { DashboardSummary } from '../types/index.js';

export const DashboardPage: React.FC = () => {
  const { user, isOperator } = useAuth();
  const { cameraFrames, latestSummary, watchCameras } = useSocket();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);

  // Only ask the server for camera frames while this page is shown: a picture every few seconds on the camera tiles
  const watchedIds = summary?.locations.map((l) => l.locationId).join(',') ?? '';
  useEffect(() => {
    if (!watchedIds) return;
    return watchCameras(watchedIds.split(',').map(Number), 'preview');
  }, [watchedIds, watchCameras]);
  const [hourlyData, setHourlyData] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const fetchDashboardData = async () => {
    try {
      setIsLoading(true);
      const [sumData, hrData] = await Promise.all([
        dashboardService.getSummary(),
        dashboardService.getHourly(),
      ]);
      setSummary(sumData);
      setHourlyData(hrData.hourly || []);
    } catch (err) {
      console.error('Failed to fetch dashboard data:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchDashboardData();
  }, []);

  useEffect(() => {
    if (latestSummary) {
      if (isOperator && user?.assigned_location_id) {
        const filteredLocations = latestSummary.locations.filter(
          (l) => l.locationId === user.assigned_location_id
        );
        const operatorTotal = filteredLocations.reduce((sum, l) => sum + l.todayCount, 0);
        setSummary({
          ...latestSummary,
          totalTrucksToday: operatorTotal,
          locations: filteredLocations,
        });
      } else {
        setSummary(latestSummary);
      }
    }
  }, [latestSummary, isOperator, user]);

  const handleTriggerSimulatedPassage = async (locId: number) => {
    await demoService.triggerPassage(locId);
  };

  const ghazipur = summary?.locations.find((l) => l.locationId === 1);
  const okhla = summary?.locations.find((l) => l.locationId === 2);
  const bhalaswa = summary?.locations.find((l) => l.locationId === 3);

  return (
    <div className="space-y-6">
      {/* Page Title & Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-black text-slate-900 tracking-tight uppercase">
              Control Room Dashboard
            </h1>
            <span className="text-xs px-2.5 py-0.5 rounded-full font-bold bg-blue-100 text-blue-800">
              LIVE
            </span>
          </div>
          <p className="text-xs text-slate-500 font-medium mt-1">
            Real-time automatic wheel wash truck counter and CCTV surveillance
          </p>
        </div>

        <button
          onClick={fetchDashboardData}
          title="Refresh statistics"
          className="p-2 text-slate-600 hover:text-slate-900 bg-white border border-slate-200 rounded-lg shadow-2xs hover:bg-slate-50 transition-colors self-start sm:self-auto"
        >
          <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Top 4 Stat Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Total Trucks Today */}
        <StatCard
          title="Total Trucks Today"
          count={summary?.totalTrucksToday || 0}
          subtitle="Combined across active sites"
          icon={Truck}
          badge="3 LOCATIONS"
          badgeColor="blue"
        />

        {/* Ghazipur Trucks Today */}
        {(!isOperator || user?.assigned_location_id === 1) && (
          <StatCard
            title="Ghazipur Trucks Today"
            count={ghazipur?.todayCount || 0}
            subtitle={
              ghazipur?.lastDetectionTime
                ? `Last: ${ghazipur.lastDetectionTime.split(' ')[1]}`
                : 'No movement yet'
            }
            icon={MapPin}
            badge="SITE #1"
            badgeColor="blue"
          />
        )}

        {/* Okhla Trucks Today */}
        {(!isOperator || user?.assigned_location_id === 2) && (
          <StatCard
            title="Okhla Trucks Today"
            count={okhla?.todayCount || 0}
            subtitle={
              okhla?.lastDetectionTime
                ? `Last: ${okhla.lastDetectionTime.split(' ')[1]}`
                : 'No movement yet'
            }
            icon={MapPin}
            badge="SITE #2"
            badgeColor="emerald"
          />
        )}

        {/* Bhalaswa Trucks Today */}
        {(!isOperator || user?.assigned_location_id === 3) && (
          <StatCard
            title="Bhalaswa Trucks Today"
            count={bhalaswa?.todayCount || 0}
            subtitle={
              bhalaswa?.lastDetectionTime
                ? `Last: ${bhalaswa.lastDetectionTime.split(' ')[1]}`
                : 'No movement yet'
            }
            icon={MapPin}
            badge="SITE #3"
            badgeColor="amber"
          />
        )}
      </div>

      {/* Camera Surveillance Grid */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-bold uppercase tracking-wider text-slate-700 flex items-center gap-2">
            <Layers className="w-4 h-4 text-blue-600" />
            Live Camera Surveillance & Detection Bays
          </h2>
          <span className="text-[11px] font-mono text-slate-500">
            {isOperator ? 'Assigned Location View' : 'All 3 Location Feeds'}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
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
      </div>

      {/* Hourly Truck Movement Analytics Chart */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <HourlyChart
            data={hourlyData}
            title="Today's Hourly Vehicle Movement"
            singleLocationName={isOperator ? user?.assigned_location_name || 'Assigned Site' : undefined}
          />
        </div>

        {/* Recent Valid Passage Activity Feed */}
        <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm flex flex-col">
          <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-100">
            <h3 className="font-bold text-slate-900 text-sm">Recent Vehicle Passages</h3>
            <span className="text-[10px] font-mono font-bold bg-slate-100 px-2 py-0.5 rounded text-slate-600">
              AUTOMATIC
            </span>
          </div>

          <div className="flex-1 overflow-y-auto space-y-2.5 max-h-64">
            {summary?.recentEvents && summary.recentEvents.length > 0 ? (
              summary.recentEvents.map((evt) => (
                <div
                  key={evt.id}
                  className="p-2.5 rounded-lg bg-slate-50 border border-slate-100 flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-500" />
                    <div>
                      <span className="font-bold text-slate-800">{evt.locationName}</span>
                      <span className="block text-[10px] text-slate-400 font-mono">
                        {evt.source === 'automatic' ? 'AI CCTV Detection' : 'Demo Trigger'}
                      </span>
                    </div>
                  </div>
                  <span className="font-mono text-slate-600 text-[11px]">
                    {evt.timestamp.split(' ')[1]}
                  </span>
                </div>
              ))
            ) : (
              <div className="py-8 text-center text-xs text-slate-400">
                No truck passages recorded today yet.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
