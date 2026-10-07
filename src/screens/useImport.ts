import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, DeviceEventEmitter, NativeEventEmitter, NativeModules } from 'react-native';
import Importer from '../native/NativeImport';
import { isExhausted, refreshAllowance, useAllowanceStore } from '../billing/allowance';
import { explainer, importErrorCopy, statusLine } from '../billing/allowanceCopy';

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
 *
 * An import takes one of the month's Free meetings, like a recording (native decides: AudioImport).
 * What that means is said where it is decided: the picker does not open when the month is spent,
 * the share confirmation carries the line, and a refusal from native is worded here, not shown raw.
 */
export function useImport(onDone: (meetingId: string) => void, onUpgrade?: () => void) {
  const [state, setState] = useState<ImportState>({ busy: false, progress: null });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** A refusal the allowance owns: the sentence, and Pro when Pro is the way past it. */
  const refuse = useCallback(
    ({ text, upgrade }: { text: string; upgrade: boolean }) => {
      Alert.alert(
        'Could not import that',
        text,
        upgrade && onUpgrade
          ? [{ text: 'Not now', style: 'cancel' }, { text: 'Get Pro', onPress: onUpgrade }]
          : [{ text: 'OK' }],
      );
    },
    [onUpgrade],
  );

  const run = useCallback(
    async (start: () => Promise<string | null>) => {
      setState({ busy: true, progress: null });
      try {
        const meetingId = await start();
        if (meetingId) onDone(meetingId);
      } catch (e: any) {
        const message = String(e?.message ?? e);
        const known = importErrorCopy(e?.code, message);
        if (known) {
          refuse(known);
          // A refused import may have changed what the line should say (a slot given back).
          refreshAllowance();
        } else {
          // The message comes from AudioImport and is written to be read by a person: "There is no
          // audio in that file", "That recording is longer than four hours".
          Alert.alert('Could not import that', message);
        }
      } finally {
        if (alive.current) setState({ busy: false, progress: null });
      }
    },
    [onDone, refuse],
  );

  const pick = useCallback(async () => {
    // Asked again rather than trusted: a slot may have been given back since the screen last looked,
    // and refusing the picker on a stale zero would be the app being wrong about its own limit.
    await refreshAllowance();
    const status = useAllowanceStore.getState().status;
    if (isExhausted(status)) {
      const known = importErrorCopy('allowance_exhausted', status.resetsOn);
      if (known) refuse(known);
      return;
    }
    return run(() => Importer.pick());
  }, [run, refuse]);

  const importUri = useCallback(
    (uri: string) => run(() => Importer.importUri(uri)),
    [run],
  );

  /** Ask first, then import. Shared by the cold-start and warm-share paths. */
  const confirmAndImport = useCallback(
    async (uri: string, name?: string | null) => {
      await refreshAllowance();
      // A Free phone is told what this will cost; Pro is told nothing about meetings (null line).
      const line = statusLine(useAllowanceStore.getState().status);
      const body = name
        ? `“${name}” will be transcribed on this phone. Nothing is uploaded.`
        : 'This recording will be transcribed on this phone. Nothing is uploaded.';
      Alert.alert('Transcribe this recording?', line ? `${body} ${line} ${explainer}` : body, [
        { text: 'Not now', style: 'cancel' },
        { text: 'Transcribe', onPress: () => importUri(uri) },
      ]);
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
