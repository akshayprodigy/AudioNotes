import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, DeviceEventEmitter, NativeEventEmitter, NativeModules } from 'react-native';
import Importer from '../native/NativeImport';

export interface ImportState {
  /** True while a file is being decoded. Long enough on an hour of audio to need saying. */
  busy: boolean;
  /** 0..1, or null when the container declared no duration — common for a streamed voice note. */
  progress: number | null;
}

/**
 * Bringing in audio somebody else recorded.
 *
 * Two ways in, both ending at the same native import: the user picks a file, or another app shares
 * one to us. The second is the interesting one — it is how a WhatsApp voice note, a lecture
 * recording or an interview gets in without the user ever having opened this app first.
 *
 * A share is CONFIRMED rather than imported on arrival. Being handed a file by the share sheet
 * says the user wants to do something with it here, not that they want a transcription started on
 * a two-hour audiobook they tapped by mistake; and transcription costs real battery.
 */
export function useImport(onDone: (meetingId: string) => void) {
  const [state, setState] = useState<ImportState>({ busy: false, progress: null });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (start: () => Promise<string | null>) => {
      setState({ busy: true, progress: null });
      try {
        const meetingId = await start();
        if (meetingId) onDone(meetingId);
      } catch (e: any) {
        // The message comes from AudioImport and is written to be read by a person: "There is no
        // audio in that file", "That recording is longer than four hours".
        Alert.alert('Could not import that', String(e?.message ?? e));
      } finally {
        if (alive.current) setState({ busy: false, progress: null });
      }
    },
    [onDone],
  );

  const pick = useCallback(() => run(() => Importer.pick()), [run]);

  const importUri = useCallback(
    (uri: string) => run(() => Importer.importUri(uri)),
    [run],
  );

  /** Ask first, then import. Shared by the cold-start and warm-share paths. */
  const confirmAndImport = useCallback(
    (uri: string, name?: string | null) => {
      Alert.alert(
        'Transcribe this recording?',
        name
          ? `“${name}” will be transcribed on this phone. Nothing is uploaded.`
          : 'This recording will be transcribed on this phone. Nothing is uploaded.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Transcribe', onPress: () => importUri(uri) },
        ],
      );
    },
    [importUri],
  );

  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.Import);
    const sub = emitter.addListener(
      'onImportProgress',
      (e: { doneMs: number; totalMs: number }) => {
        if (!alive.current) return;
        setState(s => ({
          ...s,
          progress: e.totalMs > 0 ? Math.min(1, e.doneMs / e.totalMs) : null,
        }));
      },
    );
    return () => sub.remove();
  }, []);

  // Cold start: another app shared a file before we were running, and MainActivity stashed it.
  useEffect(() => {
    Importer.consumePendingImport()
      .then(p => {
        if (p?.uri) confirmAndImport(p.uri, p.name);
      })
      .catch(() => {});
  }, [confirmAndImport]);

  // Warm share: we were already open, so MainActivity.onNewIntent emits instead.
  useEffect(() => {
    const sub = DeviceEventEmitter.addListener('onSharedAudio', (e: { uri?: string }) => {
      if (e?.uri) confirmAndImport(e.uri);
    });
    return () => sub.remove();
  }, [confirmAndImport]);

  return { ...state, pick };
}
