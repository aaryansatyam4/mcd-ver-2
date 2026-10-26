import React, { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Video,
  BarChart3,
  Sliders,
  Users,
  ScrollText,
  LogOut,
  KeyRound,
  Menu,
  X,
  Truck,
  Clock,
  Shield,
  FileSpreadsheet,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext.js';
import { useSocket } from '../contexts/SocketContext.js';
import { ChangePasswordModal } from '../components/ChangePasswordModal.js';
import { BACKEND_URL, api } from '../services/api.js';

export const MainLayout: React.FC = () => {
  const { user, logout, isAdmin } = useAuth();
  const { lastPassage } = useSocket();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [currentTime, setCurrentTime] = useState('');
  const [spreadsheetUrl, setSpreadsheetUrl] = useState<string | null>(null);

  // When the backend stores data in a Google Sheet, link to it instead of the Excel file
  useEffect(() => {
    api
      .get('/health')
      .then((res) => setSpreadsheetUrl(res.data?.database?.spreadsheetUrl ?? null))
      .catch(() => setSpreadsheetUrl(null));
  }, []);

  // Live Asia/Kolkata clock
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      const timeStr = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
      }).format(now);
      setCurrentTime(`${timeStr} IST`);
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  // Navigation Links based on role (Edit Counts removed)
  const navItems = [
    {
      to: '/',
      label: 'Dashboard',
      icon: LayoutDashboard,
      show: true,
    },
    {
      to: '/monitoring',
      label: 'Live Monitoring',
      icon: Video,
      show: true,
    },
    {
      to: '/reports',
      label: 'Reports & Export',
      icon: BarChart3,
      show: true,
    },
    {
      to: '/camera-settings',
      label: 'Camera Settings',
      icon: Sliders,
      show: isAdmin,
    },
    {
      to: '/users',
      label: 'User Management',
      icon: Users,
      show: isAdmin,
    },
    {
      to: '/audit-logs',
      label: 'Audit History',
      icon: ScrollText,
      show: isAdmin,
    },
  ];

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col">
      {/* Global Vehicle Detection Toast Banner */}
      {lastPassage && (
        <div className="bg-gradient-to-r from-blue-700 via-indigo-700 to-blue-800 text-white px-4 py-2 shadow-lg flex items-center justify-between animate-fade-in z-50">
          <div className="max-w-7xl mx-auto w-full flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="w-3 h-3 rounded-full bg-emerald-400 animate-ping" />
              <div className="flex items-center gap-2">
                <Truck className="w-5 h-5 text-white" />
                <span className="text-sm font-black uppercase tracking-wide">
                  PASSAGE DETECTED: {lastPassage.locationName}
                </span>
              </div>
              <span className="hidden sm:inline text-xs text-blue-200">
                New Today Total: <strong className="text-white font-mono">{lastPassage.todayCount}</strong>
              </span>
            </div>
            <span className="text-xs font-mono text-blue-200">{lastPassage.timestamp}</span>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar for Desktop */}
        <aside
          className={`fixed inset-y-0 left-0 z-40 w-64 bg-slate-900 text-slate-300 flex flex-col transition-transform duration-300 ease-in-out md:static md:translate-x-0 ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          {/* Logo / Brand Header */}
          <div className="h-16 px-6 bg-slate-950 flex items-center justify-between border-b border-slate-800/80">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center text-white font-black text-lg shadow-md shadow-blue-900/40">
                <Truck className="w-5 h-5" />
              </div>
              <div>
                <h1 className="font-extrabold text-sm text-white tracking-tight uppercase leading-none">
                  WheelWash
                </h1>
                <span className="text-[10px] text-blue-400 font-mono tracking-wider font-semibold">
                  MONITOR SYSTEM
                </span>
              </div>
            </div>
            <button
              onClick={() => setSidebarOpen(false)}
              className="md:hidden text-slate-400 hover:text-white"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* User Profile Mini Badge */}
          <div className="p-4 mx-3 my-3 rounded-xl bg-slate-800/60 border border-slate-700/60 flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-blue-950 border border-blue-700 flex items-center justify-center text-blue-300 font-bold uppercase text-sm">
              {user?.username.slice(0, 2)}
            </div>
            <div className="overflow-hidden">
              <div className="font-bold text-xs text-white truncate">{user?.username}</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400" />
                <span className="text-[11px] font-semibold text-slate-300 uppercase">
                  {user?.role === 'admin'
                    ? 'Master Admin'
                    : user?.role === 'monitoring'
                    ? 'Monitoring'
                    : `${user?.assigned_location_name || 'Location'} Op`}
                </span>
              </div>
            </div>
          </div>

          {/* Nav Items */}
          <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
            {navItems
              .filter((item) => item.show)
              .map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setSidebarOpen(false)}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-xs font-semibold tracking-wide transition-all ${
                      isActive
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`
                  }
                >
                  <item.icon className="w-4 h-4 shrink-0" />
                  <span>{item.label}</span>
                </NavLink>
              ))}
          </nav>

          {/* Footer Actions */}
          <div className="p-3 border-t border-slate-800/80 space-y-1">
            <button
              onClick={() => setShowPasswordModal(true)}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
            >
              <KeyRound className="w-4 h-4 text-slate-400" />
              <span>Change Password</span>
            </button>

            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-xs font-semibold text-rose-400 hover:bg-rose-950/40 hover:text-rose-300 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span>Log Out</span>
            </button>
          </div>
        </aside>

        {/* Backdrop for mobile */}
        {sidebarOpen && (
          <div
            onClick={() => setSidebarOpen(false)}
            className="fixed inset-0 z-30 bg-black/50 md:hidden backdrop-blur-xs"
          />
        )}

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
          {/* Top Bar */}
          <header className="h-16 bg-white border-b border-slate-200 px-4 sm:px-6 flex items-center justify-between sticky top-0 z-20">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setSidebarOpen(true)}
                className="md:hidden p-2 rounded-lg text-slate-600 hover:bg-slate-100"
              >
                <Menu className="w-5 h-5" />
              </button>
              <div className="hidden sm:flex items-center gap-2 text-xs font-semibold text-slate-500 font-mono">
                <Clock className="w-4 h-4 text-slate-400" />
                <span>{currentTime}</span>
              </div>
            </div>

            {/* Top Right Badges */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5 px-3 py-1 bg-slate-100 rounded-full border border-slate-200 text-xs font-mono font-medium text-slate-700">
                <Shield className="w-3.5 h-3.5 text-blue-600" />
                <span>3 SITES ACTIVE</span>
              </div>

              {/* Direct database quick link: the Google Sheet when connected, otherwise the Excel file */}
              {spreadsheetUrl ? (
                <a
                  href={spreadsheetUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-300 hover:bg-emerald-100 transition-colors shadow-xs"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                  Google Sheet
                </a>
              ) : (
                <a
                  href={`${BACKEND_URL}/public/database.xlsx`}
                  download="wheelwash_database.xlsx"
                  className="hidden md:inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-300 hover:bg-emerald-100 transition-colors shadow-xs"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-600" />
                  Excel Database
                </a>
              )}
            </div>
          </header>

          {/* Page Outlet */}
          <main className="flex-1 p-4 sm:p-6 lg:p-8 max-w-7xl mx-auto w-full">
            <Outlet />
          </main>
        </div>
      </div>

      {/* Optional Voluntary Change Password Modal only if clicked */}
      <ChangePasswordModal
        isOpen={showPasswordModal}
        canDismiss={true}
        onDismiss={() => setShowPasswordModal(false)}
        onSuccess={() => setShowPasswordModal(false)}
      />
    </div>
  );
};
