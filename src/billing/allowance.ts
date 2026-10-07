import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { create } from 'zustand';
import Licence, { type AllowanceStatus } from '../native/NativeLicence';
import { useRecordingStore } from '../state/recordingStore';

/**
 * The Free allowance, as the screens read it.
 *
 * Native owns the ledger and the verdicts (Allowance.kt); this file only fetches the answer and
 * keeps one copy of it, so Library, Record, Settings, import and the paywall all show the same
 * numbers. Nothing here decides whether a recording may start.
 */
export type { AllowanceStatus };

/** Free, answered, and nothing left. Pro and "not known yet" are never exhausted. */
export function isExhausted(status: AllowanceStatus | null): status is AllowanceStatus {
  return !!status && !status.paid && status.remaining <= 0;
}

/** Whether a value from native is the shape this file promises. */
function isStatus(v: unknown): v is AllowanceStatus {
  const s = v as Partial<AllowanceStatus> | null;
  return (
    !!s &&
    typeof s.limit === 'number' &&
    typeof s.used === 'number' &&
    typeof s.remaining === 'number' &&
    typeof s.period === 'string' &&
    typeof s.resetsOn === 'string' &&
    typeof s.paid === 'boolean'
  );
}

/** Ask native. Null when it cannot say, so a screen shows nothing rather than a guessed number. */
export async function fetchAllowance(): Promise<AllowanceStatus | null> {
  try {
    const s = await Licence.allowance();
    return isStatus(s) ? s : null;
  } catch {
    return null;
  }
}

interface AllowanceState {
  status: AllowanceStatus | null;
}

export const useAllowanceStore = create<AllowanceState>(() => ({ status: null }));

/**
 * Re-read and store. A failed read keeps the last good answer: a number that is a few seconds old
 * is better than a line that vanishes.
 */
export async function refreshAllowance(): Promise<void> {
  const status = await fetchAllowance();
  if (status) useAllowanceStore.setState({ status });
}

/**
 * The allowance, kept fresh: read on mount, when the app returns to the foreground, and when a
 * recording ends (the slot settles then). Screens that run an import call [refreshAllowance]
 * themselves when it finishes, and screens that come back into focus do the same.
 */
export function useAllowance(): AllowanceStatus | null {
  const status = useAllowanceStore(s => s.status);
  const isRecording = useRecordingStore(s => s.isRecording);
  const wasRecording = useRef(isRecording);

  useEffect(() => {
    refreshAllowance();
    const sub = AppState.addEventListener('change', a => {
      if (a === 'active') refreshAllowance();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (wasRecording.current && !isRecording) refreshAllowance();
    wasRecording.current = isRecording;
  }, [isRecording]);

  return status;
}
