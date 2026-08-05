import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import { radius, s, useTheme } from '../theme';

interface Props {
  levelRef: { current: number };
  active: boolean;
  /** Container height in design units (the design uses 70). */
  height?: number;
}

/**
 * The recording meter — 14 bars, 5pt wide, 4pt apart, in a 70pt band above the record button.
 *
 * Bar heights and colours are the design's: a fixed silhouette of alternating tall/short bars
 * tinted across three shades of the coral. In the design those heights are baked in and merely
 * animate on a loop; here the same silhouette is MODULATED by the real microphone level, so the
 * shape is the design's but the movement is the actual voice.
 *
 *  - Sampled on a timer, not re-rendered per level event (20/s), which would rebuild the tree
 *    constantly for something purely decorative.
 *  - scaleY only, on the native driver: animating height would relayout fourteen views twelve
 *    times a second on a JS thread that is also running the pipeline.
 *  - The level is expanded with a 0.65 power curve because the capture level is already dBFS
 *    mapped, putting ordinary speech at 0.3-0.5 — linear, that barely moves anything.
 */
const HEIGHTS = [26, 42, 60, 34, 52, 22, 66, 38, 56, 28, 46, 62, 32, 24];
// The design cycles the three coral shades 1,2,3 straight across the 14 bars rather than using a
// bespoke pattern — keeping the cycle is what makes the band read as one continuous gradient.
const SHADE = HEIGHTS.map((_, i) => (i % 3) + 1);
const TICK_MS = 70;
const FLOOR = 0.22;

export default function LiveWaveform({ levelRef, active, height = 70 }: Props) {
  const { colors } = useTheme();
  const bars = useRef(HEIGHTS.map(() => new Animated.Value(FLOOR))).current;
  const phase = useRef(0);

  useEffect(() => {
    if (!active) {
      bars.forEach(b =>
        Animated.timing(b, { toValue: FLOOR, duration: 220, useNativeDriver: true }).start(),
      );
      return;
    }
    const id = setInterval(() => {
      phase.current += 1;
      const raw = Math.max(0, Math.min(1, levelRef.current || 0));
      const level = Math.pow(raw, 0.65);
      bars.forEach((b, i) => {
        // A travelling ripple keeps the band alive at a steady speaking volume — real meters are
        // never perfectly still — while `level` still governs the overall amplitude.
        const ripple = 1 + 0.28 * Math.sin(phase.current * 0.5 + i * 0.55);
        const target = FLOOR + level * ripple * (1 - FLOOR);
        Animated.timing(b, {
          toValue: Math.max(FLOOR, Math.min(1, target)),
          duration: TICK_MS + 30,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true,
        }).start();
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [active, bars, levelRef]);

  const shades = [colors.wave1, colors.wave2, colors.wave3];

  return (
    <View
      style={{
        height: s(height),
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: s(4),
      }}>
      {bars.map((b, i) => (
        <Animated.View
          key={i}
          style={{
            width: s(5),
            height: s(HEIGHTS[i]),
            borderRadius: radius.pill,
            backgroundColor: shades[SHADE[i] - 1],
            transform: [{ scaleY: b }],
          }}
        />
      ))}
    </View>
  );
}
