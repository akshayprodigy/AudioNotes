import React from 'react';
import { PanResponder, Pressable, StyleSheet, View } from 'react-native';
import Icon from '../../components/Icon';
import { Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import { stamp } from './shared';

/**
 * The transport, docked below the tabs.
 *
 * It exists because our own eval puts word error around 30%, and read-only AI output at that
 * accuracy is not a record anyone can send to a client. Being able to hear the moment a line was
 * said is what turns the transcript from a claim into something checkable — so the bar is part of
 * the meeting screen rather than a mode you enter, and it stays put as you move between tabs.
 */
export default function PlayerBar({
  playing,
  positionMs,
  durationMs,
  onToggle,
  onSeek,
}: {
  playing: boolean;
  positionMs: number;
  durationMs: number;
  onToggle: () => void;
  onSeek: (ms: number) => void;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);

  const [width, setWidth] = React.useState(0);
  // While a finger is down the bar follows the finger, not the ticks still arriving from native.
  // Without this the thumb fights the drag: each tick snaps it back to where playback actually is.
  const [scrubMs, setScrubMs] = React.useState<number | null>(null);

  // Read by the pan handlers, which are created once and would otherwise close over the first
  // render's width and duration — a scrubber that always thinks the track is 0 wide.
  const geom = React.useRef({ width: 0, durationMs: 0 });
  geom.current = { width, durationMs };

  const msAt = (x: number) => {
    const { width: w, durationMs: d } = geom.current;
    if (w <= 0 || d <= 0) return 0;
    return Math.max(0, Math.min(d, Math.round((x / w) * d)));
  };

  const pan = React.useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: e => setScrubMs(msAt(e.nativeEvent.locationX)),
        onPanResponderMove: e => setScrubMs(msAt(e.nativeEvent.locationX)),
        onPanResponderRelease: e => {
          const ms = msAt(e.nativeEvent.locationX);
          setScrubMs(null);
          onSeek(ms);
        },
        onPanResponderTerminate: () => setScrubMs(null),
      }),
    // onSeek is stable (useCallback in usePlayer); recreating the responder mid-gesture would
    // drop the drag.
    [onSeek],
  );

  const shownMs = scrubMs ?? positionMs;
  const pct = durationMs > 0 ? Math.max(0, Math.min(1, shownMs / durationMs)) : 0;

  return (
    <View style={st.bar}>
      <Pressable
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={playing ? 'Pause' : 'Play'}
        hitSlop={s(8)}
        style={({ pressed }) => [st.play, { opacity: pressed ? 0.7 : 1 }]}>
        <Icon
          name={playing ? 'pause' : 'play'}
          size={s(18)}
          color={colors.onPrimary}
          strokeWidth={2.8}
        />
      </Pressable>

      <View style={st.flex}>
        <View
          style={st.track}
          onLayout={e => setWidth(e.nativeEvent.layout.width)}
          accessibilityRole="adjustable"
          accessibilityLabel="Playback position"
          accessibilityValue={{
            min: 0,
            max: Math.max(1, Math.round(durationMs / 1000)),
            now: Math.round(shownMs / 1000),
          }}
          onAccessibilityAction={e => {
            const step = 15_000;
            if (e.nativeEvent.actionName === 'increment') onSeek(Math.min(durationMs, shownMs + step));
            if (e.nativeEvent.actionName === 'decrement') onSeek(Math.max(0, shownMs - step));
          }}
          {...pan.panHandlers}>
          {/* A generous transparent hit area around a 4pt line: the line is what reads well, and
              a 4pt drag target is unusable. */}
          <View style={st.rail}>
            <View style={[st.fill, { width: `${pct * 100}%` }]} />
          </View>
          <View style={[st.thumb, { left: `${pct * 100}%` }]} />
        </View>
        <View style={st.times}>
          <Txt variant="chipSoft" color={colors.inkFaint}>
            {stamp(shownMs)}
          </Txt>
          <Txt variant="chipSoft" color={colors.inkFaint}>
            {stamp(durationMs)}
          </Txt>
        </View>
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(12),
      paddingHorizontal: s(16),
      paddingTop: s(10),
      paddingBottom: s(6),
      backgroundColor: c.card,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.line,
    },
    flex: { flex: 1 },
    play: {
      width: s(40),
      height: s(40),
      borderRadius: s(20),
      backgroundColor: c.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    track: { height: s(28), justifyContent: 'center' },
    rail: { height: s(4), borderRadius: s(2), backgroundColor: c.cardAlt, overflow: 'hidden' },
    fill: { height: '100%', backgroundColor: c.primary },
    thumb: {
      position: 'absolute',
      width: s(12),
      height: s(12),
      borderRadius: s(6),
      marginLeft: -s(6),
      backgroundColor: c.primary,
    },
    times: { flexDirection: 'row', justifyContent: 'space-between', marginTop: s(2) },
  });
}
