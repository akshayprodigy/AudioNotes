import React, { useEffect, useId, useRef } from 'react';
import {
  Animated,
  Easing,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import Icon, { type IconName } from './Icon';
import { motion, radius, s, text, useTheme, type Colors, type TypeKey } from '../theme';

/**
 * Shared primitives, built to the design's two defining devices:
 *
 *  - HARD OFFSET SHADOW. A raised surface sits on a solid, unblurred block of colour 4-10px below
 *    it. Implemented as a sibling View behind the surface rather than Android `elevation`, which
 *    renders as a soft grey blur, costs a composite layer, and cannot be tinted — the design's
 *    shadows are coloured (`line` under a card, `primaryEdge` under indigo, `dangerEdge` under
 *    coral). Which side of the surface that colour falls on is the theme's problem, not this
 *    file's: in light every `*Edge` token is lighter than the page and in dark every one of them
 *    is darker than its surface, so the same 6px offset reads as the same physical lip in both.
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

  // Drawn at a MEASURED size, in numbers, not at "100%" of an absoluteFill Svg. A percentage
  // rect is rasterised once against the Svg's size at render and is not redrawn when only the
  // layout changes underneath it — so a card that grows after mount (the Summary card, whose
  // sentence arrives from an async entitlement check) kept its first height of gradient and
  // showed the flat base colour below it (Galaxy A07, 22 Sep). A size that comes through props
  // is a re-render, and the fill follows the box.
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null);
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      onLayout={e => {
        const { width, height } = e.nativeEvent.layout;
        setSize(prev => (prev && prev.w === width && prev.h === height ? prev : { w: width, h: height }));
      }}>
      {size && size.w > 0 && size.h > 0 ? (
        <Svg width={size.w} height={size.h} preserveAspectRatio="none">
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
          <Rect x="0" y="0" width={size.w} height={size.h} fill={`url(#${id})`} />
        </Svg>
      ) : null}
    </View>
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
  onLongPress,
  style,
  grow,
  pressable = true,
}: {
  children: React.ReactNode;
  depth?: number;
  /**
   * The hard shadow's colour. Defaults to the theme's hairline, which is what a plain card wants;
   * a coloured surface passes the matching `*Edge` token. Never a literal — the whole point of the
   * token is that it falls on the correct side of the surface in both themes.
   */
  edge?: string;
  /** Surface colour. Defaults to `card`. Ignored when `gradient` is given, which paints its own. */
  fill?: string;
  gradient?: { from: string; to: string; angle?: number };
  rad?: number;
  rotate?: string;
  onPress?: () => void;
  onLongPress?: () => void;
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
  const { colors } = useTheme();
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
      onLongPress={onLongPress}
      onPressIn={interactive ? () => to(1) : undefined}
      onPressOut={interactive ? () => to(0) : undefined}
      disabled={!onPress && !onLongPress}
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
            <View style={{ borderRadius: rad, backgroundColor: edge ?? colors.line, paddingBottom: d }}>
              <View
                style={[
                  {
                    borderRadius: rad,
                    backgroundColor: gradient ? undefined : fill ?? colors.card,
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
        gradient={{ from: colors.primaryTop, to: colors.primary }}
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
          {icon ? <Icon name={icon} size={s(19)} color={tone ?? colors.primaryDeep} /> : null}
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
          <Icon
            name={icon}
            size={s(19)}
            color={icon === 'chevronLeft' ? colors.ink : colors.primaryDeep}
            strokeWidth={2.4}
          />
        </View>
      </Raised>
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Action sheet
// ---------------------------------------------------------------------------------------------

export interface SheetAction {
  icon: IconName;
  label: string;
  hint?: string;
  destructive?: boolean;
  onPress: () => void;
}

/**
 * Bottom sheet of actions, used wherever a card or screen has more to offer than fits on it.
 *
 * Built rather than using Alert's button list because this carries an icon and a line of
 * consequence per row ("the transcript stays, the audio is already gone"), which is the part that
 * makes a destructive choice safe to make. The *confirmation* for a destructive action is still a
 * platform Alert — that one wants to be unmistakably a system dialog, not app furniture.
 *
 * `onClose` fires before the action runs, so a row that navigates does not leave a modal behind.
 */
export function Sheet({
  visible,
  title,
  actions,
  onClose,
}: {
  visible: boolean;
  title?: string;
  actions: SheetAction[];
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const rise = useRef(new Animated.Value(0)).current;
  // Nine rows are taller than a 720-dp phone: on the A07 the grip and the title sat under the
  // status bar and the top row could not be reached. The card is capped and the rows scroll; the
  // title and Cancel are not part of the scroll, so they are always where the thumb expects them.
  const { height } = useWindowDimensions();

  useEffect(() => {
    Animated.timing(rise, {
      toValue: visible ? 1 : 0,
      duration: visible ? motion.base : motion.fast,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, rise]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <Pressable style={styles.sheetBackdrop} onPress={onClose} accessibilityLabel="Dismiss">
        <Animated.View
          style={{
            flex: 1,
            backgroundColor: colors.scrim,
            opacity: rise.interpolate({ inputRange: [0, 1], outputRange: [0, 0.38] }),
          }}
        />
      </Pressable>
      <Animated.View
        style={[
          styles.sheetCard,
          {
            backgroundColor: colors.card,
            maxHeight: height * SHEET_MAX_FRACTION,
            transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [s(360), 0] }) }],
          },
        ]}>
        <View style={[styles.sheetGrip, { backgroundColor: colors.line }]} />
        {title ? (
          <Text style={[text('overline', colors.inkFaint), styles.sheetTitle]} numberOfLines={1}>
            {title}
          </Text>
        ) : null}
        <ScrollView bounces={false} showsVerticalScrollIndicator={false}>
          {actions.map(a => {
            const tint = a.destructive ? colors.danger : colors.primaryDeep;
            const soft = a.destructive ? colors.dangerSoft : colors.primarySoft;
            return (
              <Pressable
                key={a.label}
                onPress={() => {
                  onClose();
                  a.onPress();
                }}
                accessibilityRole="button"
                accessibilityLabel={a.label}
                accessibilityHint={a.hint}
                style={({ pressed }) => [
                  styles.sheetRow,
                  { backgroundColor: pressed ? colors.cardAlt : 'transparent' },
                ]}>
                <View style={[styles.sheetIcon, { backgroundColor: soft }]}>
                  <Icon name={a.icon} size={s(19)} color={tint} strokeWidth={2.4} />
                </View>
                <View style={styles.flex}>
                  <Text style={text('bodyStrong', a.destructive ? colors.danger : colors.ink)}>
                    {a.label}
                  </Text>
                  {a.hint ? (
                    <Text style={[text('chipSoft', colors.inkSoft), styles.sheetHint]}>{a.hint}</Text>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
        <View style={styles.sheetCancel}>
          <SoftButton label="Cancel" onPress={onClose} />
        </View>
      </Animated.View>
    </Modal>
  );
}

/**
 * Ask for a line of text.
 *
 * Not `Alert.prompt`, which does not exist on Android — this app's only platform — and not a whole
 * screen either: renaming a meeting is a one-field decision made in passing, and pushing a route
 * for it loses the reader's place in what they were reading.
 *
 * `initial` is applied when the modal OPENS rather than held as a prop, so a rename that fails
 * keeps what the user typed instead of snapping back to the stored title.
 */
export function TextPrompt({
  visible,
  title,
  hint,
  initial,
  placeholder,
  confirmLabel = 'Save',
  multiline,
  extraPlaceholder,
  onCancel,
  onSubmit,
}: {
  visible: boolean;
  title: string;
  hint?: string;
  initial: string;
  placeholder?: string;
  confirmLabel?: string;
  multiline?: boolean;
  /**
   * A second, optional line — the owner of an action item.
   *
   * One field rather than a form: an action nobody owns is the least useful kind, and a due date
   * is a date picker's job, not a text box's.
   */
  extraPlaceholder?: string;
  onCancel: () => void;
  onSubmit: (value: string, extra: string) => void;
}) {
  const { colors } = useTheme();
  const [value, setValue] = React.useState(initial);
  const [extra, setExtra] = React.useState('');

  useEffect(() => {
    if (visible) {
      setValue(initial);
      setExtra('');
    }
  }, [visible, initial]);

  // A Modal's onRequestClose is Android's BACK. With the keyboard up, BACK belongs to the
  // keyboard: on the A07 the first press closed the whole prompt and threw away what had been
  // typed. Tracked with the keyboard's own events rather than Keyboard.isVisible(), which is a
  // snapshot taken before the event this handler is reacting to.
  const keyboardUp = React.useRef(false);
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => { keyboardUp.current = true; });
    const hide = Keyboard.addListener('keyboardDidHide', () => { keyboardUp.current = false; });
    return () => { show.remove(); hide.remove(); };
  }, []);
  const onBack = React.useCallback(() => {
    if (keyboardUp.current) { Keyboard.dismiss(); return; }
    onCancel();
  }, [onCancel]);

  const trimmed = value.trim();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onBack}>
      <Pressable style={styles.sheetBackdrop} onPress={onCancel} accessibilityLabel="Dismiss">
        <View style={[styles.promptScrim, { backgroundColor: colors.scrim }]} />
      </Pressable>
      {/* A Modal is its own window on Android, so the activity's adjustResize does nothing for
          it: on the Galaxy A07 the keyboard sat over Cancel and Add of the two-field prompt and
          the only way to them was the keyboard's own Done. The padding behaviour listens to the
          keyboard directly and lifts the card clear of it, on either platform. */}
      <KeyboardAvoidingView style={styles.promptWrap} behavior="padding" pointerEvents="box-none">
        <View style={[styles.promptCard, { backgroundColor: colors.card, borderColor: colors.line }]}>
          <Text style={text('sectionTitle', colors.ink)}>{title}</Text>
          {hint ? (
            <Text style={[text('chipSoft', colors.inkSoft), styles.promptHint]}>{hint}</Text>
          ) : null}
          <TextInput
            value={value}
            onChangeText={setValue}
            placeholder={placeholder}
            placeholderTextColor={colors.inkFaint}
            style={[
              styles.promptInput,
              multiline && styles.promptInputTall,
              { borderColor: colors.line, color: colors.ink, backgroundColor: colors.cardAlt },
            ]}
            multiline={multiline}
            maxLength={multiline ? undefined : TextPrompt.SINGLE_LINE_MAX}
            autoFocus
            selectTextOnFocus={!multiline}
            returnKeyType={multiline ? 'default' : 'done'}
            onSubmitEditing={() => {
              if (!multiline && trimmed) onSubmit(trimmed, extra.trim());
            }}
          />
          {extraPlaceholder ? (
            <TextInput
              value={extra}
              onChangeText={setExtra}
              placeholder={extraPlaceholder}
              placeholderTextColor={colors.inkFaint}
              style={[
                styles.promptInput,
                { borderColor: colors.line, color: colors.ink, backgroundColor: colors.cardAlt },
              ]}
              returnKeyType="done"
              // The last field's Done is the natural end of typing a pair; hiding the keyboard
              // and leaving the buttons was the A07's experience of it.
              onSubmitEditing={() => {
                if (trimmed) onSubmit(trimmed, extra.trim());
              }}
            />
          ) : null}
          {/* The buttons sit DIRECTLY in the row. SoftButton's outer view is already `flex: 1`,
              which in a row means "share the width". Wrapped in another `flex: 1` view — a column
              with no height of its own — that same `flex: 1` resolves to flexBasis 0 and the
              button becomes zero pixels tall: the row kept its margin, the card kept its padding,
              and the Galaxy A07 showed a blank band where Cancel and Add should have been. Rename
              hid it for a fortnight because a single-line prompt also submits from the keyboard;
              a multiline prompt had no way to submit at all. */}
          <View style={styles.promptRow}>
            <SoftButton label="Cancel" onPress={onCancel} />
            {/* Empty is not a rename, it is a deletion of the title — refused rather than
                quietly storing a blank the library would render as a nameless row. */}
            <SoftButton
              label={confirmLabel}
              icon="check"
              onPress={() => onSubmit(trimmed, extra.trim())}
              disabled={!trimmed}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
/**
 * What a single-line prompt will hold. A title or a tag is a line; a whole document pasted into
 * "Rename this meeting" once grew the field past the buttons, with no way out but emptying it.
 */
TextPrompt.SINGLE_LINE_MAX = 120;

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
      <View style={[styles.rule, { backgroundColor: colors.line }]} />
      {right}
    </View>
  );
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

/**
 * Segmented control — the meeting screen's tab bar.
 *
 * Four segments is the practical ceiling on a 360dp phone; past that the labels truncate and the
 * control stops being readable at a glance, which is the one thing a tab bar has to be.
 *
 * Segments are equal width so the row does not reflow as the selection moves, and the selected pill
 * is a raised surface on a recessed track — the same figure/ground the rest of the app uses, at the
 * smallest size it still reads at.
 */
export function Segmented({
  items,
  value,
  onChange,
  style,
}: {
  items: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeSegmentedStyles(colors), [colors]);
  return (
    <View style={[st.track, style]} accessibilityRole="tablist">
      {items.map(it => {
        const on = it.key === value;
        return (
          <Pressable
            key={it.key}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={it.label}
            onPress={() => onChange(it.key)}
            style={[st.seg, on && { backgroundColor: colors.card, borderColor: colors.line }]}>
            <Txt
              variant={on ? 'chip' : 'chipSoft'}
              color={on ? colors.primaryDeep : colors.inkDim}
              numberOfLines={1}>
              {it.label}
            </Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

function makeSegmentedStyles(c: Colors) {
  return StyleSheet.create({
    track: {
      flexDirection: 'row',
      backgroundColor: c.cardAlt,
      borderRadius: radius.ctl,
      padding: s(3),
    },
    seg: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: s(9),
      paddingHorizontal: s(4),
      borderRadius: radius.ctl - s(3),
      borderWidth: 1,
      borderColor: 'transparent',
    },
  });
}

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

/** How much of the screen a sheet may take before its rows scroll instead. */
const SHEET_MAX_FRACTION = 0.85;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  sheetBackdrop: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  promptScrim: { flex: 1, opacity: 0.38 },
  promptWrap: { flex: 1, justifyContent: 'center', paddingHorizontal: s(24) },
  promptCard: { borderRadius: radius.card24, borderWidth: 1, padding: s(20), gap: s(6) },
  promptHint: { marginBottom: s(2) },
  promptInput: {
    borderWidth: 1,
    borderRadius: s(12),
    paddingHorizontal: s(12),
    paddingVertical: s(10),
    marginTop: s(8),
  },
  promptInputTall: { minHeight: s(110), textAlignVertical: 'top' },
  promptRow: { flexDirection: 'row', gap: s(10), marginTop: s(14) },
  sheetCard: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: radius.sheet,
    borderTopRightRadius: radius.sheet,
    paddingHorizontal: s(14),
    paddingTop: s(10),
    paddingBottom: s(28),
  },
  sheetGrip: { alignSelf: 'center', width: s(42), height: s(5), borderRadius: 999, marginBottom: s(14) },
  sheetTitle: { paddingHorizontal: s(10), marginBottom: s(6) },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: s(14),
    padding: s(12),
    borderRadius: radius.lg,
  },
  sheetIcon: {
    width: s(42),
    height: s(42),
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sheetHint: { marginTop: s(2) },
  sheetCancel: { flexDirection: 'row', marginTop: s(10), paddingHorizontal: s(2) },
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
