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
 * LIGHT is the default, not 'system'. The palette this product is designed in is the light one —
 * it is what the store listing, the screenshots and every design decision were made against — and
 * a first launch that lands in dark on a phone set to dark shows a new user a version of the app
 * nobody chose to present. 'system' remains one tap away in Settings for people who want the
 * phone-wide answer, and once chosen it follows the OS live.
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
  mode: 'light',
  scheme: 'light',
  setMode: () => {},
};

const ThemeContext = createContext<ThemeValue>(fallback);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>('light');
  const [system, setSystem] = useState<ColorSchemeName>(() => Appearance.getColorScheme() ?? 'light');

  // The stored choice is read once, after the database opens. Until it arrives the app shows
  // light, which is both the default and the least jarring thing to show for the frame or two it
  // takes — the alternative, holding the whole UI back on a settings read, makes every cold start
  // slower to serve a preference most people never change. Somebody who HAS chosen dark sees one
  // brief light frame; that is the cost of not blocking launch on a database read, and it is paid
  // by the smaller group.
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
