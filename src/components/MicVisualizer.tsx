import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { GradientFill } from './ui';
import Icon from './Icon';
import { motion, s, sv, useTheme } from '../theme';

interface Props {
  active: boolean;
  paused?: boolean;
  onPress: () => void;
  /** Diameter in design units. The design's recording button is 148. */
  size?: number;
}

/**
 * The record button: 148pt, gradient fill, 10pt hard shadow, expanding ring.
 *
 * Idle it is indigo with a mic; recording it is coral with a white rounded stop square (the
 * design draws a 10x10 rx3 rect in a 24 viewBox, i.e. a square with generously rounded corners,
 * not a circle and not a sharp square). The meter lives above it — the button stays a single
 * unambiguous target, which is what you want on a control reached for without looking.
 */
export default function MicVisualizer({ active, paused, onPress, size = 148 }: Props) {
  const { colors } = useTheme();
  const press = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const morph = useRef(new Animated.Value(0)).current;

  // `size` arrives in DESIGN units and is scaled here — height-aware, so the button still fits a
  // short screen. Callers must pass the raw design number (148); passing an already-scaled value
  // double-scales the button and everything derived from it (ring, stop glyph, container).
  const D = sv(size);
  const depth = s(10);

  useEffect(() => {
    Animated.timing(morph, {
      toValue: active ? 1 : 0,
      duration: motion.base,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [active, morph]);

  // The design's `ring` keyframe: scale .85 -> 1.5 while fading out. Held still when paused —
  // a pulsing "live" ring over a paused recorder would misstate whether the mic is running.
  useEffect(() => {
    if (!active || paused) {
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
  }, [active, paused, ring]);

  const from = active ? colors.dangerLight : '#5A66DE';
  const to = active ? colors.danger : colors.primary;
  const edge = active ? colors.dangerEdge : colors.primaryEdge;
  // The design draws a 52pt SVG on a 148pt button (0.351 of the diameter) whose rect occupies
  // 10 of 24 viewBox units — so the visible white square is ~0.146 of the button. Sizing the SVG
  // by anything else silently resizes the square.
  const stop = Math.round(D * 0.351);

  return (
    <View
      style={{
        width: D + s(40),
        height: D + depth + s(40),
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      {active && !paused ? (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              alignItems: 'center',
              justifyContent: 'center',
              opacity: ring.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
              transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.5] }) }],
            },
          ]}>
          <View
            style={{
              width: D + s(28),
              height: D + s(28),
              borderRadius: D,
              backgroundColor: colors.danger,
              opacity: 0.36,
            }}
          />
        </Animated.View>
      ) : null}

      <Pressable
        onPress={onPress}
        onPressIn={() =>
          Animated.timing(press, { toValue: 1, duration: motion.fast, useNativeDriver: true }).start()
        }
        onPressOut={() =>
          Animated.timing(press, { toValue: 0, duration: motion.fast, useNativeDriver: true }).start()
        }
        accessibilityRole="button"
        accessibilityLabel={active ? 'Finish recording' : 'Start recording'}>
        <View style={{ borderRadius: D, backgroundColor: edge, paddingBottom: depth }}>
          <Animated.View
            style={{
              width: D,
              height: D,
              borderRadius: D,
              overflow: 'hidden',
              alignItems: 'center',
              justifyContent: 'center',
              transform: [
                { translateY: press.interpolate({ inputRange: [0, 1], outputRange: [0, depth] }) },
              ],
            }}>
            <GradientFill from={from} to={to} />

            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute',
                opacity: morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
                transform: [{ scale: morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0.5] }) }],
              }}>
              <Icon name="mic" size={Math.round(D * 0.35)} color={colors.onPrimary} strokeWidth={2.6} />
            </Animated.View>

            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute',
                opacity: morph,
                transform: [{ scale: morph.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] }) }],
              }}>
              <Svg width={stop} height={stop} viewBox="0 0 24 24">
                <Rect x={7} y={7} width={10} height={10} rx={3} fill={colors.onPrimary} />
              </Svg>
            </Animated.View>
          </Animated.View>
        </View>
      </Pressable>
    </View>
  );
}
