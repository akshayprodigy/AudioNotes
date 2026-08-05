import React, { useEffect, useId, useRef } from 'react';
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
import Svg, { Circle, Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import Icon, { type IconName } from './Icon';
import { motion, radius, s, spacing, text, useTheme, type Colors, type TypeKey } from '../theme';

/**
 * Shared primitives, built to the design's two defining devices:
 *
 *  - HARD OFFSET SHADOW. A raised surface sits on a solid, unblurred block of colour 4-10px below
 *    it. Implemented as a sibling View behind the surface rather than Android `elevation`, which
 *    renders as a soft grey blur, costs a composite layer, and cannot be tinted — the design's
 *    shadows are coloured (#E4E7F1 under white, #3A45B4 under indigo, #C6474A under coral).
 *  - PRESS-TO-MEET-THE-SHADOW. Pressing translates the surface down by the shadow's depth and
 *    shrinks the shadow to match, so the control physically lands. That is the whole interaction
 *    feel of the reference.
 */

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

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
    <Text numberOfLines={numberOfLines} style={[text(variant, color ?? colors.ink), style]}>
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------------------------------------
// Gradient fill
// ---------------------------------------------------------------------------------------------

/**
 * A linear-gradient background layer.
 *
 * Drawn with react-native-svg rather than adding react-native-linear-gradient: the dependency is
 * already present for the icons and mascot, and this avoids another native module in the build.
 * Absolutely positioned behind content, so the parent keeps normal layout and rounded corners
 * (the parent must set `overflow: 'hidden'`).
 *
 * `angle` follows CSS: 135deg runs top-left to bottom-right, matching the design's declarations.
 */
export function GradientFill({
  from,
  to,
  angle = 180,
}: {
  from: string;
  to: string;
  angle?: number;
}) {
  // Every instance needs its OWN gradient id. A hard-coded id collides as soon as two of these
  // are mounted at once — the Meeting screen alone has four (three stat tiles and the gist) —
  // which makes every one of them resolve to whichever definition registered last, and gives
  // react-native-svg duplicate nodes to reconcile.
  const id = `grad${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  // CSS gradient angles run clockwise from "to top"; convert to the unit-square coordinates
  // react-native-svg wants.
  const rad = ((angle - 90) * Math.PI) / 180;
  const dx = Math.cos(rad) / 2;
  const dy = Math.sin(rad) / 2;
  return (
    <Svg style={StyleSheet.absoluteFill} preserveAspectRatio="none">
      <Defs>
        <LinearGradient
          id={id}
          x1={`${(0.5 - dx) * 100}%`}
          y1={`${(0.5 - dy) * 100}%`}
          x2={`${(0.5 + dx) * 100}%`}
          y2={`${(0.5 + dy) * 100}%`}>
          <Stop offset="0" stopColor={from} />
          <Stop offset="1" stopColor={to} />
        </LinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Raised — the shared hard-shadow container
// ---------------------------------------------------------------------------------------------

export function Raised({
  children,
  depth = 6,
  edge,
  fill,
  gradient,
  rad = radius.card,
  rotate,
  onPress,
  style,
  grow,
  pressable = true,
}: {
  children: React.ReactNode;
  depth?: number;
  edge: string;
  fill?: string;
  gradient?: { from: string; to: string; angle?: number };
  rad?: number;
  rotate?: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  /**
   * Take the remaining space of a ROW parent.
   *
   * `style` lands on the innermost surface, which is the right place for padding and corners but
   * useless for sizing: a `flex: 1` there cannot widen the Pressable wrapping it, so in a row the
   * whole stack sizes to its text and overflows the screen. This puts the flex on the outer node,
   * and the intermediate wrappers inherit the width by ordinary cross-axis stretch.
   */
  grow?: boolean;
  pressable?: boolean;
}) {
  const press = useRef(new Animated.Value(0)).current;
  const d = s(depth);

  const to = (v: number) =>
    Animated.timing(press, {
      toValue: v,
      duration: motion.fast,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start();

  // ALWAYS the same tree shape — Pressable > rotate > clip > slide > edge > surface — whether or
  // not this instance is interactive. Returning the surface bare when `onPress` is undefined and
  // wrapped when it is defined changes the structure at that position the moment a button toggles
  // `disabled`, which Fabric can fail to re-parent ("the specified child already has a parent").
  const interactive = !!onPress && pressable;

  // Press travel: two thirds of the depth, so a 6px shadow presses down to 2px — the design's
  // `translateY(4px); box-shadow: 0 2px 0` on a `0 6px 0` control.
  const travel = Math.max(2, Math.round(d * 0.66));

  return (
    <Pressable
      onPress={onPress}
      onPressIn={interactive ? () => to(1) : undefined}
      onPressOut={interactive ? () => to(0) : undefined}
      disabled={!onPress}
      style={grow ? styles.flex : undefined}>
      {/* Rotation lives OUTSIDE the clipping layer: a tilted child inside an un-tilted
          `overflow: hidden` box gets its corners sliced off. */}
      <View style={{ transform: rotate ? [{ rotate }] : [] }}>
        {/* The clip is what makes the shadow shrink. The edge and surface slide down together —
            they must, or the edge shows ABOVE the surface as a coloured band, since a transform
            does not change layout and the edge would still occupy the vacated strip. Sliding both
            and clipping the overflow removes `travel` from the bottom of the shadow instead,
            which is exactly the design's "press down, shadow gets smaller". */}
        <View style={{ borderRadius: rad, overflow: 'hidden' }}>
          <Animated.View
            style={{
              transform: interactive
                ? [{ translateY: press.interpolate({ inputRange: [0, 1], outputRange: [0, travel] }) }]
                : [],
            }}>
            <View style={{ borderRadius: rad, backgroundColor: edge, paddingBottom: d }}>
              <View
                style={[
                  {
                    borderRadius: rad,
                    backgroundColor: gradient ? undefined : fill,
                    overflow: 'hidden',
                  },
                  style,
                ]}>
                {gradient ? (
                  <GradientFill from={gradient.from} to={gradient.to} angle={gradient.angle} />
                ) : null}
                {children}
              </View>
            </View>
          </Animated.View>
        </View>
      </View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------

export function Button({
  label,
  icon,
  onPress,
  disabled,
  full,
  style,
}: {
  label: string;
  icon?: IconName;
  onPress: () => void;
  disabled?: boolean;
  full?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  return (
    <View style={[full && { alignSelf: 'stretch' }, { opacity: disabled ? 0.45 : 1 }, style]}>
      <Raised
        edge={colors.primaryEdge}
        gradient={{ from: '#5A66DE', to: colors.primary }}
        rad={radius.ctl}
        depth={6}
        onPress={disabled ? undefined : onPress}>
        <View style={styles.btn}>
          {icon ? <Icon name={icon} size={s(20)} color={colors.onPrimary} /> : null}
          <Text style={text('cta', colors.onPrimary)}>{label}</Text>
        </View>
      </Raised>
    </View>
  );
}

/** White pill button used in the footers (Pause / Mark moment / Speakers / Export / Redo). */
export function SoftButton({
  label,
  icon,
  onPress,
  disabled,
  stacked,
  tone,
}: {
  label: string;
  icon?: IconName;
  onPress?: () => void;
  disabled?: boolean;
  /** Icon above label (meeting actions) rather than beside it (recorder footer). */
  stacked?: boolean;
  tone?: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={[styles.flex, { opacity: disabled ? 0.45 : 1 }]}>
      <Raised
        edge={colors.line}
        fill={colors.card}
        rad={radius.lg}
        depth={4}
        onPress={disabled ? undefined : onPress}>
        <View style={stacked ? styles.softStacked : styles.softRow}>
          {icon ? <Icon name={icon} size={s(19)} color={tone ?? colors.primary} /> : null}
          <Text style={text(stacked ? 'metaBlack' : 'label', colors.ink)}>{label}</Text>
        </View>
      </Raised>
    </View>
  );
}

/** 40x40 rounded-square icon button (back / search / settings). */
export function IconButton({
  icon,
  onPress,
  label,
}: {
  icon: IconName;
  onPress: () => void;
  label: string;
}) {
  const { colors } = useTheme();
  return (
    <View accessibilityRole="button" accessibilityLabel={label}>
      <Raised edge={colors.lineStrong} fill={colors.card} rad={radius.md} depth={3} onPress={onPress}>
        <View style={{ width: s(40), height: s(40), alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={icon} size={s(19)} color={icon === 'chevronLeft' ? colors.ink : colors.primary} strokeWidth={2.4} />
        </View>
      </Raised>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Badges / chips
// ---------------------------------------------------------------------------------------------

export function Badge({
  label,
  color,
  soft,
  small,
}: {
  label: string;
  color: string;
  soft: string;
  small?: boolean;
}) {
  return (
    <View
      style={[
        styles.badge,
        // Two paddings in the design: status pills sit at 7/11, the tighter minute badges at 5/9.
        { backgroundColor: soft, paddingHorizontal: s(small ? 9 : 11), paddingVertical: s(small ? 5 : 7) },
      ]}>
      <Text style={text(small ? 'chipSm' : 'chip', color)}>{label}</Text>
    </View>
  );
}

/** Square initials tile ("EN", "QP") used on library cards. */
export function Tile({ label, color, soft }: { label: string; color: string; soft: string }) {
  return (
    <View
      style={{
        width: s(34),
        height: s(34),
        borderRadius: s(12),
        backgroundColor: soft,
        alignItems: 'center',
        justifyContent: 'center',
      }}>
      <Text style={text('meta', color)}>{label}</Text>
    </View>
  );
}

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
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        opacity: p.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] }),
      }}
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Switch
// ---------------------------------------------------------------------------------------------

/**
 * The knob slides on the native driver; the track colour cross-fades on a second, JS-driven value
 * because backgroundColor is not a native-driver property. Two values rather than one so the slide
 * — the part the eye tracks — never waits on the JS thread.
 */
export function Switch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  const { colors } = useTheme();
  const slide = useRef(new Animated.Value(on ? 1 : 0)).current;
  const tint = useRef(new Animated.Value(on ? 1 : 0)).current;
  const W = s(48);
  const H = s(28);
  const K = s(22);
  const PAD = s(3);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(slide, {
        toValue: on ? 1 : 0,
        duration: motion.base,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(tint, {
        toValue: on ? 1 : 0,
        duration: motion.base,
        useNativeDriver: false,
      }),
    ]).start();
  }, [on, slide, tint]);

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      hitSlop={s(8)}>
      <Animated.View
        style={{
          width: W,
          height: H,
          borderRadius: radius.pill,
          padding: PAD,
          justifyContent: 'center',
          backgroundColor: tint.interpolate({
            inputRange: [0, 1],
            outputRange: [colors.lineStrong, colors.primary],
          }),
        }}>
        <Animated.View
          style={{
            width: K,
            height: K,
            borderRadius: radius.pill,
            backgroundColor: colors.card,
            transform: [
              {
                translateX: slide.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, W - K - PAD * 2],
                }),
              },
            ],
          }}
        />
      </Animated.View>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------------------------
// Section rule
// ---------------------------------------------------------------------------------------------

export function SectionRule({ label, right }: { label: string; right?: React.ReactNode }) {
  const { colors } = useTheme();
  return (
    <View style={styles.ruleRow}>
      <Text style={text('overline', colors.inkFaint)}>{label}</Text>
      <View style={[styles.rule, { backgroundColor: '#E7EAF3' }]} />
      {right}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

export function ProgressBar({ pct, color, track }: { pct: number; color: string; track: string }) {
  const w = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(w, {
      toValue: Math.max(0, Math.min(100, pct)),
      duration: motion.base,
      easing: Easing.out(Easing.quad),
      // Width cannot be driven natively; one short tween on a tiny view is cheaper here than
      // restructuring into a scaleX transform with a compensating origin.
      useNativeDriver: false,
    }).start();
  }, [pct, w]);
  return (
    <View style={{ height: s(8), borderRadius: radius.pill, backgroundColor: track, overflow: 'hidden' }}>
      <Animated.View
        style={{
          height: '100%',
          borderRadius: radius.pill,
          backgroundColor: color,
          width: w.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
        }}
      />
    </View>
  );
}

/**
 * The processing ring: a static track with a rotating arc, matching the design's spinning
 * `stroke-dasharray="150 400"` circle. The arc length also encodes real progress, so it is both
 * a spinner and a gauge.
 */
export function ProgressRing({
  pct,
  size,
  stroke,
  children,
}: {
  pct: number;
  size: number;
  stroke: number;
  children?: React.ReactNode;
}) {
  const { colors } = useTheme();
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, {
        toValue: 1,
        duration: 3200,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);

  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = Math.max(0.08, Math.min(0.95, pct / 100)) * circ;

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      {/* ONE Svg holding both circles, inside the single rotating layer.
          Two sibling <Svg> elements — one of them re-created on every progress tick while an
          animation drove its parent — left orphaned RNSVGSvgViewAndroid nodes and crashed Fabric
          with "addViewAt: view already has a parent" every time this screen appeared. Rotating
          the track along with the arc is invisible (it is a full circle), so collapsing them
          costs nothing. */}
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            transform: [
              { rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) },
            ],
          },
        ]}>
        <Svg width={size} height={size}>
          <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.line} strokeWidth={stroke} fill="none" />
          <Circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            stroke={colors.primary}
            strokeWidth={stroke}
            strokeLinecap="round"
            fill="none"
            strokeDasharray={`${dash} ${circ}`}
          />
        </Svg>
      </Animated.View>
      {children}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Entrance animations
// ---------------------------------------------------------------------------------------------

/** The design's `pop` keyframe: rise 14px and scale from .96 while fading in. */
export function Pop({
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
      delay: Math.min(index, 6) * 60,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [a, index]);
  return (
    <Animated.View
      style={[
        {
          opacity: a,
          transform: [
            { translateY: a.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) },
            { scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
          ],
        },
        style,
      ]}>
      {children}
    </Animated.View>
  );
}

/** The design's `slide` keyframe: in from the left. Used for minutes. */
export function Slide({
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
      delay: Math.min(index, 6) * 60,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [a, index]);
  return (
    <Animated.View
      style={[
        {
          opacity: a,
          transform: [{ translateX: a.interpolate({ inputRange: [0, 1], outputRange: [-18, 0] }) }],
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
    row: { flexDirection: 'row', alignItems: 'center' },
  });
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  btn: {
    paddingVertical: s(18),
    paddingHorizontal: s(24),
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: s(10),
  },
  softRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: s(8),
    paddingVertical: s(15),
    paddingHorizontal: s(8),
  },
  softStacked: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: s(5),
    paddingVertical: s(13),
    paddingHorizontal: s(8),
  },
  badge: { borderRadius: radius.pill, alignSelf: 'flex-start' },
  ruleRow: { flexDirection: 'row', alignItems: 'center', gap: s(10) },
  rule: { flex: 1, height: 2, borderRadius: radius.pill },
});
