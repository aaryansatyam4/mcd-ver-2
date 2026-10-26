import axios from 'axios';
import type {
  UserSafe,
  DashboardSummary,
  Camera,
  CountAdjustment,
  AuditLog,
} from '../types/index.js';

// Base URL configured from .env (VITE_API_URL) or fallback to relative '/api'
export const BACKEND_URL = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');
const API_BASE_URL = BACKEND_URL ? `${BACKEND_URL}/api` : '/api';

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach JWT token to every request if present
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('ww_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Intercept 401 unauthorized errors
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      localStorage.removeItem('ww_token');
      localStorage.removeItem('ww_user');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

// Auth Service
export const authService = {
  login: async (credentials: { username: string; password: string }) => {
    const res = await api.post('/auth/login', credentials);
    return res.data;
  },
  logout: async () => {
    const res = await api.post('/auth/logout');
    return res.data;
  },
  me: async (): Promise<{ user: UserSafe }> => {
    const res = await api.get('/auth/me');
    return res.data;
  },
  changePassword: async (passwords: { currentPassword?: string; newPassword: string }) => {
    const res = await api.post('/auth/change-password', passwords);
    return res.data;
  },
};

// Dashboard Service
export const dashboardService = {
  getSummary: async (date?: string): Promise<DashboardSummary> => {
    const res = await api.get('/dashboard/summary', { params: { date } });
    return res.data;
  },
  getHourly: async (date?: string, locationId?: number) => {
    const res = await api.get('/dashboard/hourly', { params: { date, locationId } });
    return res.data;
  },
  getLocations: async () => {
    const res = await api.get('/dashboard/locations');
    return res.data;
  },
};

// Camera Service
export const cameraService = {
  getCameras: async (): Promise<{ cameras: Camera[] }> => {
    const res = await api.get('/cameras');
    return res.data;
  },
  getStatus: async (id: number) => {
    const res = await api.get(`/cameras/${id}/status`);
    return res.data;
  },
  updateSettings: async (id: number, data: any) => {
    const res = await api.put(`/cameras/${id}/settings`, data);
    return res.data;
  },
  testConnection: async (id: number) => {
    const res = await api.post(`/cameras/${id}/test`);
    return res.data;
  },
  startStream: async (id: number) => {
    const res = await api.post(`/cameras/${id}/start`);
    return res.data;
  },
  stopStream: async (id: number) => {
    const res = await api.post(`/cameras/${id}/stop`);
    return res.data;
  },
};

// Counts Service
export const countService = {
  getToday: async () => {
    const res = await api.get('/counts/today');
    return res.data;
  },
  getByLocation: async (locationId: number, date?: string) => {
    const res = await api.get(`/counts/${locationId}`, { params: { date } });
    return res.data;
  },
  adjustCount: async (data: {
    locationId: number;
    reportDate: string;
    newCount: number;
    reason: string;
  }) => {
    const res = await api.post('/counts/adjust', data);
    return res.data;
  },
  getAdjustments: async (): Promise<{ adjustments: CountAdjustment[] }> => {
    const res = await api.get('/counts/adjustments');
    return res.data;
  },
};

// Reports Service
/** Which page of the truck passage log a report should include */
export interface PassagePageParams {
  page: number;
  pageSize: number;
  sort: 'newest' | 'oldest';
}

export interface ReportExportParams {
  format: 'csv' | 'excel';
  type: string;
  date?: string;
  startDate?: string;
  endDate?: string;
  month?: string;
  year?: string;
  locationId?: number;
}

export const reportService = {
  getDaily: async (date?: string, locationId?: number, paging?: PassagePageParams) => {
    const res = await api.get('/reports/daily', { params: { date, locationId, ...paging } });
    return res.data;
  },
  getWeekly: async (startDate?: string, endDate?: string, locationId?: number, paging?: PassagePageParams) => {
    const res = await api.get('/reports/weekly', { params: { startDate, endDate, locationId, ...paging } });
    return res.data;
  },
  getMonthly: async (month?: string, locationId?: number, paging?: PassagePageParams) => {
    const res = await api.get('/reports/monthly', { params: { month, locationId, ...paging } });
    return res.data;
  },
  getYearly: async (year?: string, locationId?: number, paging?: PassagePageParams) => {
    const res = await api.get('/reports/yearly', { params: { year, locationId, ...paging } });
    return res.data;
  },
  /** Download the export through the API so the login token is sent along, then save it */
  downloadExport: async (params: ReportExportParams): Promise<void> => {
    let res;
    try {
      res = await api.get('/reports/export', { params, responseType: 'blob' });
    } catch (err: any) {
      // With responseType 'blob' the JSON error body arrives as a Blob
      const body = err.response?.data;
      if (body instanceof Blob) {
        const message = await body
          .text()
          .then((text) => JSON.parse(text).error)
          .catch(() => null);
        if (message) throw new Error(message);
      }
      throw err;
    }

    const disposition: string = res.headers['content-disposition'] || '';
    const filename =
      /filename="?([^";]+)"?/.exec(disposition)?.[1] ||
      `WheelWash_${params.type}_report.${params.format === 'excel' ? 'xlsx' : 'csv'}`;
    const url = URL.createObjectURL(res.data);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  },
};

// User Management Service
export const userService = {
  getUsers: async (): Promise<{ users: UserSafe[] }> => {
    const res = await api.get('/users');
    return res.data;
  },
  createUser: async (userData: any) => {
    const res = await api.post('/users', userData);
    return res.data;
  },
  updateUser: async (id: number, updates: any) => {
    const res = await api.patch(`/users/${id}`, updates);
    return res.data;
  },
  resetPassword: async (id: number, newPassword?: string) => {
    const res = await api.post(`/users/${id}/reset-password`, { newPassword });
    return res.data;
  },
};

// Audit Service
export const auditService = {
  getLogs: async (): Promise<{ logs: AuditLog[] }> => {
    const res = await api.get('/audit-logs');
    return res.data;
  },
};

// Demo Service
export const demoService = {
  triggerPassage: async (locationId: number) => {
    const res = await api.post('/demo/trigger-passage', { locationId });
    return res.data;
  },
  triggerHumanWalk: async (locationId: number) => {
    const res = await api.post('/demo/trigger-human-walk', { locationId });
    return res.data;
  },
  reloadDatabase: async () => {
    const res = await api.post('/demo/reload-database');
    return res.data;
  },
};
