import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Appearance, type ColorSchemeName } from 'react-native';
import { db } from '../db/queries';
import { darkColors, lightColors, type Colors } from './palette';

/**
 * Light, dark, or whatever the phone is set to.
 *
 * Dark mode was removed once because the palette had never been tuned against the light one and
 * looked wrong beside it. What comes back is the palette (see darkColors), not a switch bolted
 * over an inversion — the provider here only chooses between two designed sets.
 *
 * 'system' is the default and follows the OS live, because a note-taker gets opened at both ends
 * of the day and a phone-wide setting is the answer most people already gave.
 */
export type ThemeMode = 'light' | 'dark' | 'system';

const SETTING_KEY = 'theme';

interface ThemeValue {
  colors: Colors;
  isDark: boolean;
  /** What the user chose — 'system' included. */
  mode: ThemeMode;
  /** What that resolves to right now. */
  scheme: 'light' | 'dark';
  setMode: (m: ThemeMode) => void;
}

function isMode(v: string | null): v is ThemeMode {
  return v === 'light' || v === 'dark' || v === 'system';
}

const fallback: ThemeValue = {
  colors: lightColors,
  isDark: false,
  mode: 'system',
  scheme: 'light',
  setMode: () => {},
};

const ThemeContext = createContext<ThemeValue>(fallback);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('system');
  const [system, setSystem] = useState<ColorSchemeName>(() => Appearance.getColorScheme() ?? 'light');

  // The stored choice is read once, after the database opens. Until it arrives the app follows
  // the system scheme, which is both the default and the least jarring thing to show for the
  // frame or two it takes — the alternative, holding the whole UI back on a settings read, makes
  // every cold start slower to serve a preference most people never change.
  useEffect(() => {
    let alive = true;
    db.getSetting(SETTING_KEY)
      .then(v => {
        if (alive && isMode(v)) setModeState(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Follows the OS live rather than only at launch, so a phone on an automatic day/night schedule
  // changes under the app without needing a restart.
  useEffect(() => {
    const sub = Appearance.addChangeListener(({ colorScheme }) => setSystem(colorScheme));
    return () => sub.remove();
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    db.setSetting(SETTING_KEY, m).catch(() => {});
  }, []);

  const value = useMemo<ThemeValue>(() => {
    const scheme: 'light' | 'dark' = mode === 'system' ? (system === 'dark' ? 'dark' : 'light') : mode;
    const isDark = scheme === 'dark';
    return { colors: isDark ? darkColors : lightColors, isDark, mode, scheme, setMode };
  }, [mode, system, setMode]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
