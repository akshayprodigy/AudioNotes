import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import Icon from './Icon';
import { motion, radius, useTheme } from '../theme';

interface Props {
  /** Live 0..1 mic level, sampled on our own clock rather than re-rendering per frame. */
  levelRef: { current: number };
  active: boolean;
  onPress: () => void;
  size?: number;
}

const BARS = 5;
/** Centre-weighted so the bars form a waveform silhouette rather than a flat block. */
const WEIGHT = [0.5, 0.78, 1, 0.78, 0.5];
/** Resting height as a fraction of full — bars stay visible, and silence still reads as calm. */
const FLOOR = 0.16;
const TICK_MS = 80;

/**
 * The record button, with the level meter living INSIDE it.
 *
 * Previously the button showed a static mic while a separate strip of 27 bars scrolled underneath.
 * That split the one thing the user looks at into two competing elements, and left a wide band of
 * chrome doing nothing at all when idle. Now the button IS the meter: at rest it shows a mic icon;
 * while recording the icon gives way to five bars that move with the voice, and the whole control
 * stays a single tap target.
 *
 * Driving the bars:
 *  - A timer samples `levelRef` every 80ms. Re-rendering on every level event (20/s) would rebuild
 *    the tree constantly for something purely visual.
 *  - Each bar has a fixed centre weight plus a per-bar sine phase, so a steady voice still ripples
 *    instead of freezing into a flat shape — real meters are never perfectly still.
 *  - Bars animate `scaleY` only, on the native driver. Animating `height` would relayout five
 *    views twelve times a second on the JS thread, which is already busy running the pipeline.
 *    Scale runs entirely on the UI thread, so the meter stays smooth even during transcription.
 */
export default function MicVisualizer({ levelRef, active, onPress, size = 168 }: Props) {
  const { colors } = useTheme();

  const bars = useRef([...Array(BARS)].map(() => new Animated.Value(FLOOR))).current;
  const halo = useRef(new Animated.Value(0)).current;
  const press = useRef(new Animated.Value(0)).current;
  // Cross-fades the mic icon out and the bars in, so the swap reads as one object changing state
  // rather than two things trading places.
  const morph = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(morph, {
      toValue: active ? 1 : 0,
      duration: motion.base,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [active, morph]);

  // Sample the level and retarget every bar.
  useEffect(() => {
    if (!active) {
      bars.forEach(b =>
        Animated.timing(b, {
          toValue: FLOOR,
          duration: motion.base,
          useNativeDriver: true,
        }).start(),
      );
      return;
    }
    let t = 0;
    const id = setInterval(() => {
      t += 1;
      const level = Math.max(0, Math.min(1, levelRef.current || 0));
      bars.forEach((b, i) => {
        const ripple = 1 + 0.3 * Math.sin(t * 0.55 + i * 1.25);
        const target = FLOOR + level * WEIGHT[i] * ripple * (1 - FLOOR);
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

  // Slow halo breathing while live — visible from across a table without being a flashing light.
  useEffect(() => {
    if (!active) {
      halo.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(halo, {
          toValue: 1,
          duration: 1300,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(halo, {
          toValue: 0,
          duration: 1300,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, halo]);

  const fill = active ? colors.danger : colors.primary;
  const edge = active ? colors.dangerEdge : colors.primaryEdge;

  const barW = Math.round(size * 0.055);
  const barH = Math.round(size * 0.42);
  const gap = Math.round(size * 0.042);

  return (
    <View
      style={{
        width: size * 1.5,
        height: size * 1.5,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      {/* Halo — rendered ONLY while live. The breathing interpolation runs 0.28 -> 0 opacity, so
          parking the driver at 0 would leave a permanent coral ring around an idle blue button. */}
      {active && (
        <Animated.View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            {
              alignItems: 'center',
              justifyContent: 'center',
              opacity: halo.interpolate({ inputRange: [0, 1], outputRange: [0.28, 0] }),
              transform: [
                { scale: halo.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.25] }) },
              ],
            },
          ]}>
          <View
            style={{
              width: size * 1.18,
              height: size * 1.18,
              borderRadius: size,
              backgroundColor: colors.danger,
            }}
          />
        </Animated.View>
      )}

      <Pressable
        onPress={onPress}
        onPressIn={() =>
          Animated.timing(press, {
            toValue: 1,
            duration: motion.fast,
            useNativeDriver: true,
          }).start()
        }
        onPressOut={() =>
          Animated.timing(press, {
            toValue: 0,
            duration: motion.fast,
            useNativeDriver: true,
          }).start()
        }
        accessibilityRole="button"
        accessibilityLabel={active ? 'Stop recording' : 'Start recording'}>
        <View style={{ borderRadius: size, backgroundColor: edge, paddingBottom: 5 }}>
          <Animated.View
            style={[
              styles.btn,
              {
                width: size,
                height: size,
                borderRadius: size,
                backgroundColor: fill,
                transform: [
                  { translateY: press.interpolate({ inputRange: [0, 1], outputRange: [0, 5] }) },
                ],
              },
            ]}>
            {/* Mic icon — fades and shrinks away as recording starts. */}
            <Animated.View
              pointerEvents="none"
              style={{
                position: 'absolute',
                opacity: morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
                transform: [
                  { scale: morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0.6] }) },
                ],
              }}>
              <Icon name="mic" size={Math.round(size * 0.34)} color={colors.onPrimary} />
            </Animated.View>

            {/* Bars — the meter, inside the button. */}
            <Animated.View
              pointerEvents="none"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap,
                height: barH,
                opacity: morph,
                transform: [
                  { scale: morph.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1] }) },
                ],
              }}>
              {bars.map((b, i) => (
                <Animated.View
                  key={i}
                  style={{
                    width: barW,
                    height: barH,
                    borderRadius: radius.pill,
                    backgroundColor: colors.onPrimary,
                    // Scales about the centre, which is exactly how a symmetric level meter reads.
                    transform: [{ scaleY: b }],
                  }}
                />
              ))}
            </Animated.View>
          </Animated.View>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  btn: { alignItems: 'center', justifyContent: 'center' },
});
