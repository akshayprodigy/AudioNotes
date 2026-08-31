import { useCallback, useEffect, useRef, useState } from 'react';
import { NativeEventEmitter, NativeModules } from 'react-native';
import Player from '../../native/NativePlayer';

export interface PlayerState {
  /** Whether this meeting still has audio on disk. False hides the transport entirely. */
  available: boolean;
  playing: boolean;
  positionMs: number;
  durationMs: number;
  /** Set when the device refused — recording in progress, audio gone, another app holding focus. */
  error: string | null;
}

const IDLE: PlayerState = {
  available: false,
  playing: false,
  positionMs: 0,
  durationMs: 0,
  error: null,
};

/**
 * Playing a meeting back.
 *
 * Every recording that still has audio can be played; the transport is hidden rather than
 * disabled when it cannot, because "you deleted this a week ago" is a fact about the past and a
 * greyed-out play button invites the user to keep pressing it.
 *
 * Position comes from the native tick rather than from a JS timer. A timer would drift against
 * the audio within a minute, and drift is precisely what makes a highlighted transcript line feel
 * wrong — the whole point of playback here is checking a word against the moment it was said.
 *
 * The native side owns the audio device, so this hook's real obligation is releasing it: on
 * unmount, and whenever the meeting changes. Playback holds audio focus, and a screen that goes
 * away without saying so leaves the user's meeting audible over whatever they opened next.
 */
export function usePlayer(meetingId: string) {
  const [state, setState] = useState<PlayerState>(IDLE);
  // Whether native has a file open for us. Kept in a ref because play() and seek() need to know
  // synchronously whether to open first, and a state read there would be a render behind.
  const opened = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    opened.current = false;
    setState(IDLE);

    Player.hasAudio(meetingId)
      .then(has => {
        if (alive.current) setState(s => ({ ...s, available: has }));
      })
      .catch(() => {});

    const emitter = new NativeEventEmitter(NativeModules.Player);
    const onTick = emitter.addListener(
      'onPlayerTick',
      (e: { positionMs: number; durationMs: number; playing: boolean }) => {
        if (!alive.current) return;
        setState(s => ({
          ...s,
          positionMs: e.positionMs,
          durationMs: e.durationMs || s.durationMs,
          playing: e.playing,
        }));
      },
    );
    const onEnd = emitter.addListener('onPlayerEnd', () => {
      if (alive.current) setState(s => ({ ...s, playing: false }));
    });

    return () => {
      alive.current = false;
      onTick.remove();
      onEnd.remove();
      // Unconditional: opened.current can be false while an open() is still in flight, and the
      // device must come back either way. A stop with nothing open is a no-op natively.
      opened.current = false;
      Player.stop().catch(() => {});
    };
  }, [meetingId]);

  /** Open on first use rather than on mount, so merely visiting a meeting takes no audio device. */
  const ensureOpen = useCallback(async () => {
    if (opened.current) return true;
    try {
      const { durationMs } = await Player.open(meetingId);
      opened.current = true;
      if (alive.current) setState(s => ({ ...s, durationMs, error: null }));
      return true;
    } catch (e: any) {
      if (alive.current) {
        setState(s => ({ ...s, error: String(e?.message ?? e), playing: false }));
      }
      return false;
    }
  }, [meetingId]);

  const play = useCallback(async () => {
    if (!(await ensureOpen())) return;
    try {
      await Player.play();
      if (alive.current) setState(s => ({ ...s, playing: true, error: null }));
    } catch (e: any) {
      if (alive.current) setState(s => ({ ...s, error: String(e?.message ?? e) }));
    }
  }, [ensureOpen]);

  const pause = useCallback(async () => {
    // Optimistic, and safe to be: the next tick carries native's own answer, and a play/pause
    // button that waits for a round trip before moving reads as a dropped tap.
    setState(s => ({ ...s, playing: false }));
    await Player.pause().catch(() => {});
  }, []);

  const toggle = useCallback(() => {
    if (state.playing) pause();
    else play();
  }, [state.playing, play, pause]);

  /** Move without changing whether we are playing — the scrubber. */
  const seek = useCallback(
    async (ms: number) => {
      if (!(await ensureOpen())) return;
      setState(s => ({ ...s, positionMs: ms }));
      await Player.seek(ms).catch(() => {});
    },
    [ensureOpen],
  );

  /** Move and play — tapping a transcript turn, which always means "let me hear this". */
  const playFrom = useCallback(
    async (ms: number) => {
      if (!(await ensureOpen())) return;
      setState(s => ({ ...s, positionMs: ms }));
      await Player.seek(ms).catch(() => {});
      await play();
    },
    [ensureOpen, play],
  );

  const dismissError = useCallback(() => setState(s => ({ ...s, error: null })), []);

  return { ...state, toggle, seek, playFrom, dismissError };
}
