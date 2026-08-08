import React, { useEffect, useRef, useState } from 'react';
import { NativeEventEmitter, NativeModules, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme';
import { Txt } from './ui';
import LiveWaveform from './LiveWaveform';
import { useRecordingStore } from '../state/recordingStore';

function fmt(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/** Compact recorder shown while the app is in the PiP window. Buttons are native PiP actions. */
export default function PipRecorder() {
  const { colors } = useTheme();
  const { isRecording, paused, startedAt, elapsedMs } = useRecordingStore();
  const levelRef = useRef(0);
  const [elapsed, setElapsed] = useState(elapsedMs);

  // Feed the waveform the same way RecordScreen does — LiveWaveform samples this ref on a timer
  // rather than re-rendering per level event, so PiP shows the real microphone level.
  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.AudioPipeline);
    const sub = emitter.addListener('onCaptureLevel', (e: { level: number }) => {
      levelRef.current = e.level ?? 0;
    });
    return () => sub.remove();
  }, []);

  // Live timer, anchored to native's start time and frozen while paused — the exact derivation the
  // Record screen uses, so the PiP clock and the full recorder never disagree.
  useEffect(() => {
    if (!isRecording) {
      setElapsed(0);
      return;
    }
    if (paused) {
      setElapsed(elapsedMs);
      return;
    }
    const anchor = startedAt ?? Date.now();
    setElapsed(Date.now() - anchor);
    const id = setInterval(() => setElapsed(Date.now() - anchor), 500);
    return () => clearInterval(id);
  }, [isRecording, paused, startedAt, elapsedMs]);

  return (
    <View style={[styles.root, { backgroundColor: colors.canvas }]}>
      <View style={styles.row}>
        <View style={[styles.dot, { backgroundColor: paused ? colors.inkFaint : colors.danger }]} />
        <Txt variant="display">{fmt(elapsed)}</Txt>
      </View>
      <View style={styles.meter}>
        <LiveWaveform levelRef={levelRef} active={isRecording && !paused} height={44} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 12, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  meter: { alignSelf: 'stretch', alignItems: 'center' },
});
