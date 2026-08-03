import React, { useEffect, useRef } from 'react';
import { Animated, Pressable, View, StyleSheet, Easing } from 'react-native';
import Icon from './Icon';
import type { Colors } from '../theme';

interface Props {
  level: Animated.Value; // 0..1, driven by onCaptureLevel while recording
  levelRef?: { current: number }; // same signal as a plain number, for the scrolling bars
  active: boolean; // recording?
  colors: Colors;
  onPress: () => void;
  size?: number;
}

/**
 * Record button whose pulse rings track the live mic level, above a scrolling waveform.
 *
 * The waveform is a ring buffer, not a single shared value: every ~70 ms the newest level is
 * pushed onto the right and every bar shifts one slot left, so the shape travels across the
 * screen the way it does in Claude's recorder. Driving all bars from one scalar (the previous
 * approach) makes them rise and fall in lockstep, which reads as a pulse and gives no sense of
 * speech rhythm — you cannot see a pause, and you cannot tell a loud room from actual talking.
 */
const BARS = 27;
const FRAME_MS = 70;
const MIN_SCALE = 0.08;

export default function MicVisualizer({ level, levelRef, active, colors, onPress, size = 190 }: Props) {
  const btn = size * 0.52;
  const fill = active ? colors.danger : colors.primary;

  // One Animated.Value per bar; index 0 is the oldest sample (left), BARS-1 the newest (right).
  const bars = useRef<Animated.Value[]>(
    Array.from({ length: BARS }, () => new Animated.Value(MIN_SCALE)),
  ).current;
  const history = useRef<number[]>(new Array(BARS).fill(0)).current;

  useEffect(() => {
    if (!active) {
      // Collapse back to a flat line when not recording.
      history.fill(0);
      Animated.parallel(
        bars.map(b =>
          Animated.timing(b, { toValue: MIN_SCALE, duration: 220, useNativeDriver: true }),
        ),
      ).start();
      return;
    }

    const id = setInterval(() => {
      // Shift left, append the newest level. A tiny floor keeps silent bars visible.
      history.shift();
      history.push(levelRef?.current ?? 0);
      for (let i = 0; i < BARS; i++) {
        // Slight taper at the edges so the waveform fades in/out instead of clipping.
        const edge = Math.min(i, BARS - 1 - i) / 3;
        const taper = Math.min(1, 0.35 + edge);
        const target = Math.max(MIN_SCALE, Math.min(1, history[i] * 1.25) * taper);
        Animated.timing(bars[i], {
          toValue: target,
          duration: FRAME_MS,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start();
      }
    }, FRAME_MS);
    return () => clearInterval(id);
  }, [active, bars, history, levelRef]);

  const ringStyle = (base: number, maxOpacity: number) => ({
    position: 'absolute' as const,
    width: size * base,
    height: size * base,
    borderRadius: (size * base) / 2,
    backgroundColor: fill,
    opacity: active
      ? level.interpolate({ inputRange: [0, 1], outputRange: [0.04, maxOpacity] })
      : 0,
    transform: [{ scale: level.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.15] }) }],
  });

  const iconScale = active
    ? level.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.12] })
    : 1;

  return (
    <View style={styles.wrap}>
      <View style={[styles.stage, { width: size, height: size }]}>
        <Animated.View style={ringStyle(0.92, 0.14)} />
        <Animated.View style={ringStyle(0.72, 0.22)} />
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={active ? 'Stop recording' : 'Start recording'}
          style={[
            styles.btn,
            { width: btn, height: btn, borderRadius: btn / 2, backgroundColor: fill },
          ]}>
          <Animated.View style={{ transform: [{ scale: iconScale }] }}>
            <Icon name={active ? 'stop' : 'mic'} size={btn * 0.42} color={colors.onPrimary} strokeWidth={2.2} />
          </Animated.View>
        </Pressable>
      </View>

      <View style={styles.eq}>
        {bars.map((b, i) => (
          <Animated.View
            key={i}
            style={[
              styles.bar,
              {
                backgroundColor: active ? colors.primary : colors.border,
                transform: [{ scaleY: b }],
              },
            ]}
          />
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  stage: { alignItems: 'center', justifyContent: 'center' },
  btn: { alignItems: 'center', justifyContent: 'center', elevation: 4 },
  eq: { flexDirection: 'row', alignItems: 'center', height: 56, marginTop: 24 },
  bar: { width: 4, height: 52, marginHorizontal: 2, borderRadius: 2 },
});
