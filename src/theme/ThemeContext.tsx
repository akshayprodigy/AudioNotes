import React, { createContext, useContext } from 'react';
import { lightColors, type Colors } from './palette';

/**
 * Light-only theme.
 *
 * The dark palette was never tuned against the light one and looked wrong beside it, so rather
 * than ship two mediocre themes the app commits to one. The provider and hook stay because every
 * screen consumes `useTheme()`; only the choice went away.
 *
 * `mode`/`setMode` are retained as no-ops so the Settings screen and any stored 'theme' setting
 * keep compiling. If a real dark theme is wanted later it belongs here — designed against the
 * light one, not bolted on.
 */
export type ThemeMode = 'light';

interface ThemeValue {
  colors: Colors;
  isDark: boolean;
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
}

const value: ThemeValue = {
  colors: lightColors,
  isDark: false,
  mode: 'light',
  setMode: () => {},
};

const ThemeContext = createContext<ThemeValue>(value);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
