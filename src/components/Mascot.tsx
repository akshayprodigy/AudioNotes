import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View, type ViewStyle } from 'react-native';
import Svg, { Circle, Ellipse, Path, Rect } from 'react-native-svg';
import { useTheme } from '../theme';

export type Mood = 'idle' | 'listening' | 'thinking' | 'happy' | 'asleep';

interface Props {
  mood?: Mood;
  size?: number;
  style?: ViewStyle;
  animated?: boolean;
}

/**
 * "Pip", the note-taking assistant — geometry transcribed from the design's SVG.
 *
 * The exact numbers matter here: a headphoned character built from a body circle at r=38, ear
 * cups as 18x30 rounded rects at x=12/90, and a face circle at r=27 reads as the reference
 * character. Re-proportioning any of them (as the first pass did, using a squircle body and a
 * rounded-rect face plate) produces something recognisably different.
 *
 *   body      circle  cx60 cy58 r38          #4A56D2
 *   ear cups  rect    x12/x90 y46 18x30 r9   #3A45B4
 *   headband  path    M20 50 a40 40 0 0 1 80 0, stroke 7
 *   face      circle  cx60 cy63 r27          #fff
 *   eyes      circle  cx51/69 cy60 r4.6      #16192C
 *   blush     circle  cx40/80 cy68 r5        #FFC9CE
 *
 * Motion is the design's `bob` keyframe (translateY + a slight counter-rotation) on the native
 * driver, so the character keeps moving while the JS thread is busy transcribing.
 */
export default function Mascot({ mood = 'idle', size = 120, style, animated = true }: Props) {
  const { colors } = useTheme();
  const bob = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animated) return;
    // Slower while thinking, livelier while listening — matches the design's per-screen timings
    // (3.4s on consent, 2.6s on recording, 3s on processing).
    const dur = mood === 'listening' ? 1300 : mood === 'thinking' ? 1500 : 1700;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(bob, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(bob, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [animated, mood, bob]);

  const translateY = bob.interpolate({ inputRange: [0, 1], outputRange: [0, -size * 0.067] });
  const rotate = bob.interpolate({ inputRange: [0, 1], outputRange: ['-2deg', '2deg'] });

  const body = mood === 'asleep' ? '#9AA1BC' : colors.primary;
  const cups = mood === 'asleep' ? '#7C84A6' : colors.primaryEdge;

  // Eyes and mouth per mood. Everything else is constant, which is what keeps the character
  // reading as the same character across states.
  const face = (() => {
    switch (mood) {
      case 'listening':
        return (
          <>
            <Circle cx={51} cy={59} r={4.6} fill="#16192C" />
            <Circle cx={69} cy={59} r={4.6} fill="#16192C" />
            <Ellipse cx={60} cy={73} rx={5} ry={6} fill="#16192C" />
          </>
        );
      case 'happy':
        return (
          <>
            <Path d="M46 60q5-6 10 0" stroke="#16192C" strokeWidth={3.4} strokeLinecap="round" fill="none" />
            <Path d="M64 60q5-6 10 0" stroke="#16192C" strokeWidth={3.4} strokeLinecap="round" fill="none" />
            <Path d="M50 70q10 10 20 0" stroke="#16192C" strokeWidth={3.4} strokeLinecap="round" fill="none" />
          </>
        );
      case 'thinking':
        return (
          <>
            <Circle cx={53} cy={57} r={4.6} fill="#16192C" />
            <Circle cx={71} cy={57} r={4.6} fill="#16192C" />
            <Path d="M52 71q8 7 16 0" stroke="#16192C" strokeWidth={3.4} strokeLinecap="round" fill="none" />
          </>
        );
      case 'asleep':
        return (
          <>
            <Path d="M46 60q5 5 10 0" stroke="#16192C" strokeWidth={3.4} strokeLinecap="round" fill="none" />
            <Path d="M64 60q5 5 10 0" stroke="#16192C" strokeWidth={3.4} strokeLinecap="round" fill="none" />
            <Path d="M55 72h10" stroke="#16192C" strokeWidth={3.4} strokeLinecap="round" fill="none" />
          </>
        );
      default:
        return (
          <>
            <Circle cx={51} cy={60} r={4.6} fill="#16192C" />
            <Circle cx={69} cy={60} r={4.6} fill="#16192C" />
            <Path d="M52 72q8 8 16 0" stroke="#16192C" strokeWidth={3.4} strokeLinecap="round" fill="none" />
          </>
        );
    }
  })();

  return (
    <View style={[{ width: size, height: size }, style]}>
      <Animated.View style={{ transform: [{ translateY }, { rotate }] }}>
        <Svg width={size} height={size} viewBox="0 0 120 120">
          <Circle cx={60} cy={58} r={38} fill={body} />
          <Rect x={12} y={46} width={18} height={30} rx={9} fill={cups} />
          <Rect x={90} y={46} width={18} height={30} rx={9} fill={cups} />
          <Path d="M20 50a40 40 0 0 1 80 0" fill="none" stroke={body} strokeWidth={7} strokeLinecap="round" />
          <Circle cx={60} cy={63} r={27} fill="#fff" />
          {face}
          <Circle cx={40} cy={68} r={5} fill={colors.blush} />
          <Circle cx={80} cy={68} r={5} fill={colors.blush} />
        </Svg>
      </Animated.View>
    </View>
  );
}
