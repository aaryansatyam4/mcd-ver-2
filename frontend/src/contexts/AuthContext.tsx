import React, { createContext, useContext, useState, useEffect } from 'react';
import { authService } from '../services/api.js';
import type { UserSafe } from '../types/index.js';

interface AuthContextType {
  user: UserSafe | null;
  token: string | null;
  isLoading: boolean;
  isAdmin: boolean;
  isMonitoring: boolean;
  isOperator: boolean;
  login: (credentials: { username: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  updateUserPassword: (passwords: { currentPassword?: string; newPassword: string }) => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

// Swap the token for a fresh one this often while a page is open (tokens last 24 h), so a camera PC
// that streams for days stays signed in and can still reconnect after the server restarts
const TOKEN_REFRESH_MS = 60 * 60_000;

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<UserSafe | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('ww_token'));
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const fetchProfile = async () => {
    try {
      if (!token) {
        setIsLoading(false);
        return;
      }
      const data = await authService.me();
      setUser(data.user);
    } catch {
      setUser(null);
      setToken(null);
      localStorage.removeItem('ww_token');
      localStorage.removeItem('ww_user');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchProfile();
  }, [token]);

  const isLoggedIn = token !== null;
  useEffect(() => {
    if (!isLoggedIn) return;
    const refresh = async () => {
      try {
        const data = await authService.refresh();
        // Logged out while the request was running
        if (!localStorage.getItem('ww_token')) return;
        localStorage.setItem('ww_token', data.token);
        setToken(data.token);
      } catch {
        // Server unreachable: keep the current token and try again next time
      }
    };
    refresh();
    const timer = setInterval(refresh, TOKEN_REFRESH_MS);
    return () => clearInterval(timer);
  }, [isLoggedIn]);

  const login = async (credentials: { username: string; password: string }) => {
    const data = await authService.login(credentials);
    setToken(data.token);
    setUser(data.user);
    localStorage.setItem('ww_token', data.token);
    localStorage.setItem('ww_user', JSON.stringify(data.user));
  };

  const logout = async () => {
    try {
      await authService.logout();
    } catch {
      // Ignore error during logout
    } finally {
      setToken(null);
      setUser(null);
      localStorage.removeItem('ww_token');
      localStorage.removeItem('ww_user');
    }
  };

  const updateUserPassword = async (passwords: { currentPassword?: string; newPassword: string }) => {
    await authService.changePassword(passwords);
    if (user) {
      setUser({ ...user, must_change_password: 0 });
    }
  };

  const refreshProfile = async () => {
    await fetchProfile();
  };

  const isAdmin = user?.role === 'admin';
  const isMonitoring = user?.role === 'monitoring';
  const isOperator = user?.role === 'operator';

  return (
    <AuthContext.Provider
      value={{
        user,
        token,
        isLoading,
        isAdmin,
        isMonitoring,
        isOperator,
        login,
        logout,
        updateUserPassword,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
