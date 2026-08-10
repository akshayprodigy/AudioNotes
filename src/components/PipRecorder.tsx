import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  NativeEventEmitter,
  NativeModules,
  StyleSheet,
  View,
} from 'react-native';
import { GradientFill, Txt } from './ui';
import Mascot from './Mascot';
import Icon from './Icon';
import { useTheme } from '../theme';
import { useRecordingStore } from '../state/recordingStore';

// Fixed dp sizes tuned for the small PiP window (a landscape ~16:9 pane). We deliberately do NOT
// scale these by the full screen width (the `s()` helper): inside PiP the window is a fraction of
// the screen, so screen-relative sizing would blow the composition out of the pane.
const MIC = 80;
const RING = MIC + 22;

function fmt(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

/**
 * The live level meter drawn INSIDE the mic button — the "speaking" animation. Seven white bars
 * modulated by the real microphone level (same 0.65 power curve + travelling ripple the full
 * recorder's LiveWaveform uses, so PiP and the Record screen move alike), animated with scaleY on
 * the native driver so the JS thread stays free for the pipeline.
 */
function MicWave({
  levelRef,
  active,
  color,
}: {
  levelRef: { current: number };
  active: boolean;
  color: string;
}) {
  const bars = useRef(Array.from({ length: 7 }, () => new Animated.Value(0.34))).current;
  const phase = useRef(0);

  useEffect(() => {
    if (!active) {
      bars.forEach(b =>
        Animated.timing(b, { toValue: 0.34, duration: 200, useNativeDriver: true }).start(),
      );
      return;
    }
    const id = setInterval(() => {
      phase.current += 1;
      const raw = Math.max(0, Math.min(1, levelRef.current || 0));
      const level = Math.pow(raw, 0.65);
      bars.forEach((b, i) => {
        const ripple = 1 + 0.3 * Math.sin(phase.current * 0.5 + i * 0.7);
        const target = 0.32 + level * ripple * 0.68;
        Animated.timing(b, {
          toValue: Math.max(0.32, Math.min(1, target)),
          duration: 90,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start();
      });
    }, 80);
    return () => clearInterval(id);
  }, [active, bars, levelRef]);

  return (
    <View style={styles.wave}>
      {bars.map((b, i) => (
        <Animated.View
          key={i}
          style={[styles.bar, { backgroundColor: color, transform: [{ scaleY: b }] }]}
        />
      ))}
    </View>
  );
}

/**
 * Compact recorder shown in the Picture-in-Picture window: Pip (the mascot) listening beside a
 * coral mic button that holds the live wave, a pulsing "live" ring, the elapsed clock, and a
 * corner cross. PiP content is not touchable on Android — pause/stop are the native PiP action
 * buttons and the system close — so this is the look; the controls are native.
 */
export default function PipRecorder() {
  const { colors } = useTheme();
  const { isRecording, paused, startedAt, elapsedMs } = useRecordingStore();
  const levelRef = useRef(0);
  const [elapsed, setElapsed] = useState(elapsedMs);
  const ring = useRef(new Animated.Value(0)).current;
  const active = isRecording && !paused;

  // Feed the wave the mic level the same way the Record screen does — sample a ref on a timer
  // rather than re-render per level event.
  useEffect(() => {
    const emitter = new NativeEventEmitter(NativeModules.AudioPipeline);
    const sub = emitter.addListener('onCaptureLevel', (e: { level: number }) => {
      levelRef.current = e.level ?? 0;
    });
    return () => sub.remove();
  }, []);

  // Live clock, anchored to native's start and frozen while paused.
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

  // Expanding ring — a slow scale-out + fade while live, held still when paused (a pulsing ring
  // over a paused recorder would misstate whether the mic is running).
  useEffect(() => {
    if (!active) {
      ring.stopAnimation();
      ring.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(ring, {
        toValue: 1,
        duration: 2200,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, ring]);

  const from = active ? colors.dangerLight : colors.inkFaint;
  const to = active ? colors.danger : colors.inkDim;
  const edge = active ? colors.dangerEdge : '#7C84A6';

  return (
    <View style={[styles.root, { backgroundColor: colors.canvas }]}>
      {/* Corner cross. PiP content is not touchable, so this mirrors (and hints at) the system's
          own close control rather than being its own button. */}
      <View style={[styles.close, { backgroundColor: colors.card }]}>
        <Icon name="x" size={13} color={colors.inkSoft} strokeWidth={2.6} />
      </View>

      <View style={styles.stage}>
        <Mascot mood={paused ? 'asleep' : 'listening'} size={54} />

        <View style={styles.micArea}>
          {active ? (
            <Animated.View
              pointerEvents="none"
              style={[
                styles.ring,
                {
                  opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.5, 0] }),
                  transform: [
                    { scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.45] }) },
                  ],
                },
              ]}>
              <View
                style={{
                  width: RING,
                  height: RING,
                  borderRadius: RING,
                  backgroundColor: colors.danger,
                  opacity: 0.3,
                }}
              />
            </Animated.View>
          ) : null}

          <View style={{ borderRadius: MIC, backgroundColor: edge, paddingBottom: 5 }}>
            <View style={styles.mic}>
              <GradientFill from={from} to={to} />
              {paused ? (
                <Icon name="pause" size={26} color={colors.onPrimary} strokeWidth={2.4} />
              ) : (
                <MicWave levelRef={levelRef} active={active} color={colors.onPrimary} />
              )}
            </View>
          </View>
        </View>
      </View>

      <View style={styles.footer}>
        <View style={[styles.dot, { backgroundColor: paused ? colors.inkFaint : colors.danger }]} />
        <Txt variant="display" color={colors.ink}>
          {fmt(elapsed)}
        </Txt>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 8 },
  close: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stage: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  micArea: { width: RING, height: RING, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  mic: {
    width: MIC,
    height: MIC,
    borderRadius: MIC,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  wave: { flexDirection: 'row', alignItems: 'center', gap: 3, height: MIC * 0.42 },
  bar: { width: 4, height: MIC * 0.42, borderRadius: 4 },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
