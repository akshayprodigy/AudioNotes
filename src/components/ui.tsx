import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Icon, { type IconName } from './Icon';
import { motion, radius, spacing, type, useTheme, type Colors } from '../theme';

/**
 * Shared UI primitives.
 *
 * The defining move here is PRESSABLE DEPTH: solid surfaces sit on a 3px darker bottom edge, and
 * pressing translates the surface down onto it. That is what makes the reference design feel
 * physical and friendly, and unlike Android elevation it costs no extra layer, never renders as a
 * grey blur over a warm palette, and reads identically on every device.
 */

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

type TypeKey = keyof typeof type;

export function Txt({
  variant = 'body',
  color,
  style,
  children,
  numberOfLines,
}: {
  variant?: TypeKey;
  color?: string;
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  numberOfLines?: number;
}) {
  const { colors } = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[type[variant] as TextStyle, { color: color ?? colors.ink }, style]}>
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------------------------

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const DEPTH = 3;

export function Button({
  label,
  icon,
  onPress,
  variant = 'primary',
  disabled,
  full,
  style,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  full?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const press = useRef(new Animated.Value(0)).current;

  const tone = {
    primary: { fill: colors.primary, edge: colors.primaryEdge, label: colors.onPrimary },
    danger: { fill: colors.danger, edge: colors.dangerEdge, label: colors.onPrimary },
    secondary: { fill: colors.card, edge: colors.lineStrong, label: colors.ink },
    ghost: { fill: 'transparent', edge: 'transparent', label: colors.inkSoft },
  }[variant];

  const translateY = press.interpolate({ inputRange: [0, 1], outputRange: [0, DEPTH] });

  const to = (v: number) =>
    Animated.timing(press, {
      toValue: v,
      duration: motion.fast,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => to(1)}
      onPressOut={() => to(0)}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[full && { alignSelf: 'stretch' }, { opacity: disabled ? 0.45 : 1 }, style]}>
      {/* The edge is a sibling underneath, not a border: the surface slides onto it when pressed,
          which is what sells the depth. A bottom border would just move with the surface. */}
      <View style={{ borderRadius: radius.md, backgroundColor: tone.edge, paddingBottom: DEPTH }}>
        <Animated.View
          style={[
            styles.btn,
            { backgroundColor: tone.fill, transform: [{ translateY }] },
            variant === 'secondary' && { borderWidth: 1, borderColor: colors.line },
          ]}>
          {icon && <Icon name={icon} size={18} color={tone.label} />}
          <Text style={[type.label as TextStyle, { color: tone.label }]}>{label}</Text>
        </Animated.View>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------------------------

export function Card({
  children,
  onPress,
  style,
  accent,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  /** Left accent stripe — used to carry status colour without adding another badge. */
  accent?: string;
}) {
  const { colors } = useTheme();
  const press = useRef(new Animated.Value(0)).current;
  const translateY = press.interpolate({ inputRange: [0, 1], outputRange: [0, 2] });

  const inner = (
    <View style={{ borderRadius: radius.lg, backgroundColor: colors.lineStrong, paddingBottom: 2 }}>
      <Animated.View
        style={[
          styles.card,
          { backgroundColor: colors.card, borderColor: colors.line },
          onPress ? { transform: [{ translateY }] } : null,
          style,
        ]}>
        {accent && <View style={[styles.accent, { backgroundColor: accent }]} />}
        {children}
      </Animated.View>
    </View>
  );

  if (!onPress) return inner;
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() =>
        Animated.timing(press, { toValue: 1, duration: motion.fast, useNativeDriver: true }).start()
      }
      onPressOut={() =>
        Animated.timing(press, { toValue: 0, duration: motion.fast, useNativeDriver: true }).start()
      }>
      {inner}
    </Pressable>
  );
}

// ---------------------------------------------------------------------------------------------
// Chip / Pill
// ---------------------------------------------------------------------------------------------

export function Chip({
  label,
  color,
  soft,
  icon,
  style,
}: {
  label: string;
  color: string;
  soft: string;
  icon?: IconName;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[styles.chip, { backgroundColor: soft }, style]}>
      {icon && <Icon name={icon} size={13} color={color} />}
      <Text style={[type.caption as TextStyle, { color }]}>{label}</Text>
    </View>
  );
}

/** A small pulsing dot — used wherever something is genuinely live or in progress. */
export function LiveDot({ color, size = 8 }: { color: string; size?: number }) {
  const p = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(p, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(p, { toValue: 0, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [p]);
  const opacity = p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] });
  return (
    <Animated.View
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity }}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

export function ProgressBar({ pct, color }: { pct: number; color?: string }) {
  const { colors } = useTheme();
  const w = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(w, {
      toValue: Math.max(0, Math.min(100, pct)),
      duration: motion.base,
      easing: Easing.out(Easing.quad),
      // Width cannot be driven natively; this is a single short tween on a tiny view, which is
      // the one place a JS-driven animation is cheaper than restructuring to a scale transform.
      useNativeDriver: false,
    }).start();
  }, [pct, w]);
  return (
    <View style={[styles.track, { backgroundColor: colors.cardAlt }]}>
      <Animated.View
        style={[
          styles.fill,
          {
            backgroundColor: color ?? colors.primary,
            width: w.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
          },
        ]}
      />
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------------------------

export function SectionLabel({ children }: { children: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <Text style={[type.overline as TextStyle, { color: colors.inkFaint, marginBottom: spacing.sm }]}>
      {children}
    </Text>
  );
}

/**
 * Fades and lifts children in on mount, staggered by `index`.
 *
 * Capped at 6 steps: beyond that the last row waits long enough that the list feels slow rather
 * than considered.
 */
export function FadeIn({
  index = 0,
  children,
  style,
}: {
  index?: number;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(a, {
      toValue: 1,
      duration: motion.slow,
      delay: Math.min(index, 6) * 55,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [a, index]);
  return (
    <Animated.View
      style={[
        {
          opacity: a,
          transform: [{ translateY: a.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
        },
        style,
      ]}>
      {children}
    </Animated.View>
  );
}

export function makeCommon(c: Colors) {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: c.canvas },
    pad: { paddingHorizontal: spacing.lg },
    row: { flexDirection: 'row', alignItems: 'center' },
  });
}

const styles = StyleSheet.create({
  btn: {
    borderRadius: radius.md,
    paddingVertical: 13,
    paddingHorizontal: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
  },
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: spacing.lg,
    overflow: 'hidden',
  },
  accent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  track: { height: 10, borderRadius: radius.pill, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: radius.pill },
});
