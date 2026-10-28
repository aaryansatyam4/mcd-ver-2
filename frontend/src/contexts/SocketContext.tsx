import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './AuthContext.js';
import type { StreamFrame, DashboardSummary } from '../types/index.js';

interface PassageNotification {
  locationId: number;
  locationName: string;
  timestamp: string;
  todayCount: number;
}

/** 'live': a few frames a second (Live Monitoring); 'preview': a picture every few seconds (Dashboard) */
export type CameraWatchMode = 'live' | 'preview';
interface CameraWatch {
  locationIds: number[];
  mode: CameraWatchMode;
}

// Camera frames are what the hosting bills for, so they stop while nobody is looking
const IDLE_PAUSE_MS = 15 * 60_000;

interface SocketContextType {
  socket: Socket | null;
  isConnected: boolean;
  cameraFrames: Record<number, StreamFrame>;
  lastPassage: PassageNotification | null;
  latestSummary: DashboardSummary | null;
  /** Ask for these cameras' frames while the page is shown; returns a function that stops it */
  watchCameras: (locationIds: number[], mode: CameraWatchMode) => () => void;
}

const SocketContext = createContext<SocketContextType | undefined>(undefined);

export const SocketProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { token } = useAuth();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [cameraFrames, setCameraFrames] = useState<Record<number, StreamFrame>>({});
  const [lastPassage, setLastPassage] = useState<PassageNotification | null>(null);
  const [latestSummary, setLatestSummary] = useState<DashboardSummary | null>(null);
  const [watch, setWatch] = useState<CameraWatch | null>(null);
  const [isTabVisible, setIsTabVisible] = useState<boolean>(() => document.visibilityState !== 'hidden');
  const [isIdlePaused, setIsIdlePaused] = useState<boolean>(false);
  const lastActivityRef = useRef<number>(Date.now());

  const watchCameras = useCallback((locationIds: number[], mode: CameraWatchMode) => {
    const requested: CameraWatch = { locationIds, mode };
    setWatch(requested);
    return () => setWatch((current) => (current === requested ? null : current));
  }, []);

  // Pause frames while the tab is hidden or nobody has used the page for a while
  useEffect(() => {
    const onVisibility = () => setIsTabVisible(document.visibilityState !== 'hidden');
    const onActivity = () => {
      lastActivityRef.current = Date.now();
      setIsIdlePaused(false);
    };
    const activityEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;
    document.addEventListener('visibilitychange', onVisibility);
    activityEvents.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    const idleCheck = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= IDLE_PAUSE_MS) setIsIdlePaused(true);
    }, 30_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      activityEvents.forEach((e) => window.removeEventListener(e, onActivity));
      clearInterval(idleCheck);
    };
  }, []);

  // Tell the server which camera frames this browser needs right now (none when paused)
  const watchKey =
    watch && isTabVisible && !isIdlePaused ? `${watch.mode}:${[...watch.locationIds].sort((a, b) => a - b).join(',')}` : '';
  useEffect(() => {
    if (!socket) return;
    const [mode, ids] = watchKey ? watchKey.split(':') : ['preview', ''];
    const payload = { mode, locationIds: ids ? ids.split(',').map(Number) : [] };
    const send = () => socket.emit('camera:watch', payload);
    send();
    socket.on('connect', send); // rooms are lost on reconnect
    return () => {
      socket.off('connect', send);
    };
  }, [socket, watchKey]);

  useEffect(() => {
    // Connect to VITE_API_URL if configured, otherwise connect to backend port in dev or same origin in production
    const envUrl = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
    const socketUrl = envUrl || (window.location.port === '5173' ? 'http://127.0.0.1:5001' : undefined);

    const socketInstance = io(socketUrl, {
      transports: ['websocket', 'polling'],
      auth: { token: token ? `Bearer ${token}` : undefined },
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });

    socketInstance.on('connect', () => {
      setIsConnected(true);
    });

    socketInstance.on('disconnect', () => {
      setIsConnected(false);
    });

    // Receive live in-memory camera video frame
    socketInstance.on('camera:frame', (frame: StreamFrame) => {
      setCameraFrames((prev) => ({
        ...prev,
        [frame.locationId]: frame,
      }));
    });

    // Receive vehicle detection event
    socketInstance.on('vehicle:detected', (data: PassageNotification) => {
      setLastPassage(data);
      // Auto-clear notification after 4 seconds
      setTimeout(() => {
        setLastPassage((curr) => (curr?.timestamp === data.timestamp ? null : curr));
      }, 4000);
    });

    // Receive updated count / summary
    socketInstance.on('count:updated', (data: DashboardSummary) => {
      setLatestSummary(data);
    });

    socketInstance.on('count:adjusted', (data: any) => {
      // Real-time toast or trigger
    });

    setSocket(socketInstance);

    return () => {
      socketInstance.disconnect();
    };
  }, [token]);

  return (
    <SocketContext.Provider
      value={{
        socket,
        isConnected,
        cameraFrames,
        lastPassage,
        latestSummary,
        watchCameras,
      }}
    >
      {children}
      {watch && isIdlePaused && isTabVisible && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-slate-900 text-white text-xs shadow-lg flex items-center gap-3">
          <span>Live video paused to save data. Counting continues.</span>
          <button
            onClick={() => {
              lastActivityRef.current = Date.now();
              setIsIdlePaused(false);
            }}
            className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 font-bold"
          >
            Resume
          </button>
        </div>
      )}
    </SocketContext.Provider>
  );
};

export const useSocket = () => {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
};
