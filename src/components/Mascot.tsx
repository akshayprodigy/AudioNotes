import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Ellipse, G, Path, Rect } from 'react-native-svg';
import { useTheme } from '../theme';

export type Mood = 'idle' | 'listening' | 'thinking' | 'happy' | 'asleep';

interface Props {
  mood?: Mood;
  size?: number;
  style?: ViewStyle;
  /** Set false to hold still (e.g. in a dense list where motion would be noise). */
  animated?: boolean;
}

/**
 * "Pip" — the note-taking assistant.
 *
 * A headphoned character rather than a generic blob: the product's whole job is listening, and a
 * character that visibly listens explains the app faster than a caption does. It carries the
 * states the pipeline already has — idle, listening, thinking, happy, asleep — so empty screens
 * and long waits have something to say instead of a spinner.
 *
 * Drawn as vector primitives rather than shipped as an image so it inherits the theme palette and
 * stays crisp at every size, from a 28px list avatar to a 160px empty state, with no asset set to
 * keep in sync.
 *
 * All motion is transform/opacity only and runs on the native driver, so it keeps animating on
 * the UI thread while the JS thread is busy — which it very much is during transcription.
 */
export default function Mascot({ mood = 'idle', size = 120, style, animated = true }: Props) {
  const { colors } = useTheme();
  const bob = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  // Idle breathing. A character that is perfectly still reads as a static image; a slow ~3s bob
  // reads as alive without pulling attention from whatever the user is actually doing.
  useEffect(() => {
    if (!animated) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, {
          toValue: 1,
          duration: 1500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(bob, {
          toValue: 0,
          duration: 1500,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animated, bob]);

  // Listening: the headphone cups pulse outward, echoing the mic meter.
  useEffect(() => {
    if (!animated || mood !== 'listening') {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 620, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 620, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animated, mood, pulse]);

  const translateY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.035] });
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] });

  const body = mood === 'asleep' ? colors.inkFaint : colors.primary;
  const bodyEdge = mood === 'asleep' ? colors.lineStrong : colors.primaryEdge;

  // The face is the whole personality; keep the geometry in one place so moods stay consistent.
  const face = useMemo(() => {
    switch (mood) {
      case 'happy':
        return {
          // Closed, upturned eyes — the "^^" that reads as delight at any size.
          left: <Path d="M31 45 q5 -6 10 0" stroke="#1A2233" strokeWidth={4} strokeLinecap="round" fill="none" />,
          right: <Path d="M59 45 q5 -6 10 0" stroke="#1A2233" strokeWidth={4} strokeLinecap="round" fill="none" />,
          mouth: <Path d="M42 57 q8 9 16 0" stroke="#1A2233" strokeWidth={4} strokeLinecap="round" fill="none" />,
        };
      case 'listening':
        return {
          left: <Circle cx={36} cy={45} r={5.5} fill="#1A2233" />,
          right: <Circle cx={64} cy={45} r={5.5} fill="#1A2233" />,
          // Small open mouth — attentive, mid-listen.
          mouth: <Ellipse cx={50} cy={60} rx={5} ry={6} fill="#1A2233" />,
        };
      case 'thinking':
        return {
          // Eyes up and to one side: the universal "working on it".
          left: <Circle cx={38} cy={42} r={5} fill="#1A2233" />,
          right: <Circle cx={66} cy={42} r={5} fill="#1A2233" />,
          mouth: <Path d="M42 60 q8 -4 16 0" stroke="#1A2233" strokeWidth={4} strokeLinecap="round" fill="none" />,
        };
      case 'asleep':
        return {
          left: <Path d="M31 45 q5 5 10 0" stroke="#1A2233" strokeWidth={4} strokeLinecap="round" fill="none" />,
          right: <Path d="M59 45 q5 5 10 0" stroke="#1A2233" strokeWidth={4} strokeLinecap="round" fill="none" />,
          mouth: <Path d="M45 59 h10" stroke="#1A2233" strokeWidth={4} strokeLinecap="round" fill="none" />,
        };
      default:
        return {
          left: <Circle cx={36} cy={44} r={5} fill="#1A2233" />,
          right: <Circle cx={64} cy={44} r={5} fill="#1A2233" />,
          mouth: <Path d="M43 58 q7 7 14 0" stroke="#1A2233" strokeWidth={4} strokeLinecap="round" fill="none" />,
        };
    }
  }, [mood]);

  return (
    <View style={[{ width: size, height: size }, style]}>
      <Animated.View style={{ transform: [{ translateY }] }}>
        <Svg width={size} height={size} viewBox="0 0 100 100">
          {/* Headband — drawn behind the body so it reads as passing around the head. */}
          <Path
            d="M18 46 A32 32 0 0 1 82 46"
            stroke={bodyEdge}
            strokeWidth={6}
            strokeLinecap="round"
            fill="none"
          />

          {/* Body: a squircle, not a circle. Rounded rectangles feel designed; circles feel default. */}
          <Rect x={16} y={22} width={68} height={62} rx={26} fill={body} />
          {/* Hard bottom edge — the same physical-depth trick the buttons use. */}
          <Path
            d="M18 70 q0 14 15 14 h34 q15 0 15 -14 v6 q0 8 -15 8 h-34 q-15 0 -15 -8 z"
            fill={bodyEdge}
            opacity={0.9}
          />

          {/* Face plate keeps the features legible on a saturated body. */}
          <Rect x={24} y={30} width={52} height={44} rx={20} fill={colors.card} />

          <G>{face.left}</G>
          <G>{face.right}</G>
          {face.mouth}

          {/* Blush — a small amount of warmth goes a long way toward "friendly". */}
          <Circle cx={30} cy={56} r={4} fill={colors.danger} opacity={0.22} />
          <Circle cx={70} cy={56} r={4} fill={colors.danger} opacity={0.22} />

          {/* Ear cups */}
          <Rect x={8} y={40} width={14} height={24} rx={7} fill={bodyEdge} />
          <Rect x={78} y={40} width={14} height={24} rx={7} fill={bodyEdge} />
        </Svg>
      </Animated.View>

      {/* Listening rings, layered over the ear cups. Pointer-events off so they never eat a tap. */}
      {mood === 'listening' && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: size,
            height: size,
            opacity: ringOpacity,
            transform: [{ scale: ringScale }],
          }}>
          <Svg width={size} height={size} viewBox="0 0 100 100">
            <Circle cx={15} cy={52} r={12} stroke={colors.danger} strokeWidth={3} fill="none" />
            <Circle cx={85} cy={52} r={12} stroke={colors.danger} strokeWidth={3} fill="none" />
          </Svg>
        </Animated.View>
      )}
    </View>
  );
}
