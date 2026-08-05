import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useLibraryStore } from '../state/libraryStore';
import { PipelineController } from '../pipeline/PipelineController';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { Badge, IconButton, LiveDot, Pop, ProgressBar, Raised, Tile, Txt } from '../components/ui';
import type { Meeting } from '../pipeline/types';
import { radius, s, spacing, text, tilt, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Library'>;

function statusOf(status: string, c: Colors) {
  switch (status) {
    case 'done':
      return { label: 'READY', color: c.success, soft: c.successSoft, live: false };
    case 'error':
      return { label: 'NO SPEECH', color: c.warning, soft: c.warningSoft, live: false };
    case 'recording':
      return { label: 'RECORDING', color: c.danger, soft: c.dangerSoft, live: true };
    case 'captured':
      return { label: 'QUEUED', color: c.warning, soft: c.warningSoft, live: true };
    default:
      return { label: 'TRANSCRIBING', color: c.primary, soft: c.primarySoft, live: true };
  }
}

const when = (ts: number) =>
  ts ? new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '';

function dur(ms: number): string {
  if (!ms || ms <= 0) return '';
  const min = Math.round(ms / 60000);
  return min >= 1 ? `${min} min` : `${Math.max(1, Math.round(ms / 1000))}s`;
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'TODAY';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'YESTERDAY';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' }).toUpperCase();
}

/** Two initials for the card tile, from the meeting's own title. */
function initials(title: string): string {
  const w = (title || '').trim().split(/\s+/).filter(x => /[A-Za-z0-9]/.test(x));
  if (w.length === 0) return '··';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[1][0]).toUpperCase();
}

/**
 * Consecutive days ending today (or yesterday) with a recording. Derived from the loaded
 * meetings rather than stored: a counter has to be maintained on every write and goes wrong the
 * moment a meeting is deleted. Allowing the run to end yesterday stops the card resetting to
 * zero just because nothing has been recorded yet this morning.
 */
function captureStreak(meetings: Meeting[]): number {
  const days = new Set(meetings.filter(m => m.createdAt).map(m => new Date(m.createdAt).toDateString()));
  if (days.size === 0) return 0;
  const cur = new Date();
  if (!days.has(cur.toDateString())) {
    cur.setDate(cur.getDate() - 1);
    if (!days.has(cur.toDateString())) return 0;
  }
  let n = 0;
  while (days.has(cur.toDateString())) {
    n++;
    cur.setDate(cur.getDate() - 1);
  }
  return n;
}

/** The design's expanding ring behind the record FAB: scale .85 -> 1.5, opacity .55 -> 0, 2s. */
function FabRing() {
  const { colors } = useTheme();
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(a, { toValue: 1, duration: 2000, easing: Easing.out(Easing.ease), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [a]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        top: -s(10),
        bottom: -s(10),
        borderRadius: radius.pill,
        backgroundColor: colors.primary,
        opacity: a.interpolate({ inputRange: [0, 1], outputRange: [0.25, 0] }),
        transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1.5] }) }],
      }}
    />
  );
}

export default function LibraryScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { meetings, refresh } = useLibraryStore();

  useEffect(() => {
    const onFocus = () => {
      refresh();
      PipelineController.processPending().then(refresh).catch(() => {});
    };
    onFocus();
    return navigation.addListener('focus', onFocus);
  }, [navigation, refresh]);

  const streak = useMemo(() => captureStreak(meetings), [meetings]);
  const totalMin = useMemo(
    () => Math.round(meetings.reduce((a, m) => a + (m.durationMs || 0), 0) / 60000),
    [meetings],
  );

  const open = (id: string) => navigation.navigate('Meeting', { meetingId: id });

  /** Full-width card: tile + status + time, then title. */
  const BigCard = ({ m, i }: { m: Meeting; i: number }) => {
    const status = statusOf(m.status, colors);
    return (
      <Pop index={i}>
        <Raised
          edge={colors.line}
          fill={colors.card}
          rad={radius.card}
          depth={6}
          rotate={tilt(i)}
          onPress={() => open(m.id)}>
          <View style={st.cardPad}>
            <View style={st.cardTop}>
              <Tile label={initials(m.title)} color={colors.primary} soft={colors.primarySoft} />
              {status.live ? (
                <View style={[st.liveChip, { backgroundColor: status.soft }]}>
                  <LiveDot color={status.color} size={s(6)} />
                  <Txt variant="chip" color={status.color}>
                    {status.label}
                  </Txt>
                </View>
              ) : (
                <Badge label={status.label} color={status.color} soft={status.soft} />
              )}
              <View style={st.flex} />
              <Txt variant="chipSoft" color={colors.inkFaint}>
                {[when(m.createdAt), dur(m.durationMs)].filter(Boolean).join(' · ')}
              </Txt>
            </View>
            <Txt variant="cardTitle" style={st.cardTitle} numberOfLines={2}>
              {m.title || 'Untitled meeting'}
            </Txt>
            {m.status === 'done' ? <MiniWave seed={m.id} /> : null}
          </View>
        </Raised>
      </Pop>
    );
  };

  /**
   * The small bar chart the design puts under a finished meeting — a glanceable "this is audio"
   * mark. Heights are derived from the meeting id so a given meeting always draws the same shape
   * (a random one would reshuffle on every re-render and read as a live meter, which it is not).
   */
  const MiniWave = ({ seed }: { seed: string }) => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const bars = Array.from({ length: 12 }, (_, i) => {
      h = (h * 1103515245 + 12345) >>> 0;
      return 0.3 + ((h >>> 16) % 71) / 100; // 0.30 - 1.00
    });
    const shades = ['#DDE1F5', '#C7CDF0', colors.primary, '#8E97E4'];
    return (
      <View style={st.wave}>
        {bars.map((v, i) => (
          <View
            key={i}
            style={{
              flex: 1,
              height: `${v * 100}%`,
              borderRadius: 3,
              backgroundColor: shades[i % shades.length],
            }}
          />
        ))}
      </View>
    );
  };

  /** Narrow card used in a two-up row. */
  const SmallCard = ({ m, i, flex }: { m: Meeting; i: number; flex: number }) => {
    const status = statusOf(m.status, colors);
    return (
      <Pop index={i} style={{ flex }}>
        <Raised
          edge={colors.line}
          fill={colors.card}
          rad={radius.xl}
          depth={6}
          rotate={tilt(i)}
          onPress={() => open(m.id)}>
          <View style={st.smallPad}>
            <Badge label={status.label} color={status.color} soft={status.soft} small />
            <Txt variant="cardTitleSm" style={st.smallTitle} numberOfLines={2}>
              {m.title || 'Untitled meeting'}
            </Txt>
            <Txt variant="chipSoft" color={colors.inkFaint} style={st.smallMeta}>
              {[when(m.createdAt), dur(m.durationMs)].filter(Boolean).join(' · ')}
            </Txt>
          </View>
        </Raised>
      </Pop>
    );
  };

  /** Amber "no speech found" card — the design gives this state its own shape and colour. */
  const QuietCard = ({ m, i, flex }: { m: Meeting; i: number; flex: number }) => (
    <Pop index={i} style={{ flex }}>
      <Raised
        edge={colors.warningEdge}
        gradient={{ from: colors.warningSoft, to: colors.warningSoft2, angle: 160 }}
        rad={radius.card24}
        depth={6}
        rotate={tilt(i)}
        onPress={() => open(m.id)}>
        <View style={st.quietPad}>
          <Icon name="clock" size={s(22)} color={colors.warning} strokeWidth={2.4} />
          <View>
            <Txt variant="statNumSm" color={colors.warningDeep} style={st.quietNum}>
              {dur(m.durationMs) || '—'}
            </Txt>
            <Txt variant="chipSoft" color={colors.warning}>
              no speech found
            </Txt>
          </View>
        </View>
      </Raised>
    </Pop>
  );

  /**
   * Lay a day's meetings out on the design's uneven rhythm: full-width, then a two-up row split
   * 1.35 / 1, then full-width, then a narrower 92% card — repeating.
   *
   * The rhythm is INTRINSIC to position, not to the data. An earlier version only broke the
   * stack when a "no speech" meeting happened to appear, which meant almost every real library
   * rendered as a uniform column of identical cards — the exact "machine-stacked" look the
   * design's variation exists to avoid. A meeting with no speech still gets the amber treatment
   * wherever it lands; it just no longer decides the layout.
   */
  const layout = (list: Meeting[], offset: number) => {
    const out: React.ReactNode[] = [];
    let i = 0;
    let slot = 0; // 0 = big, 1 = two-up pair, 2 = big, 3 = narrow
    while (i < list.length) {
      const m = list[i];
      const k = offset + i;

      if (slot === 1 && i + 1 < list.length) {
        const n = list[i + 1];
        out.push(
          <View key={m.id} style={st.row2}>
            {m.status === 'error' ? (
              <QuietCard m={m} i={k} flex={1} />
            ) : (
              <SmallCard m={m} i={k} flex={1.35} />
            )}
            {n.status === 'error' ? (
              <QuietCard m={n} i={k + 1} flex={1} />
            ) : (
              <SmallCard m={n} i={k + 1} flex={m.status === 'error' ? 1.35 : 1} />
            )}
          </View>,
        );
        i += 2;
      } else if (slot === 3 && m.status !== 'error') {
        out.push(
          <View key={m.id} style={st.narrow}>
            <SmallCard m={m} i={k} flex={1} />
          </View>,
        );
        i += 1;
      } else if (m.status === 'error') {
        // The amber card carries one number and one line; stretched past half the column it is
        // mostly empty space, so it always takes the half-width slot regardless of the rhythm.
        out.push(
          <View key={m.id} style={st.row2}>
            <QuietCard m={m} i={k} flex={1} />
            <View style={st.flex} />
          </View>,
        );
        i += 1;
      } else {
        out.push(<BigCard key={m.id} m={m} i={k} />);
        i += 1;
      }
      slot = (slot + 1) % 4;
    }
    return out;
  };

  // Group by day, preserving order.
  const groups = useMemo(() => {
    const g: { label: string; items: Meeting[] }[] = [];
    for (const m of meetings) {
      const label = dayLabel(m.createdAt);
      if (!g.length || g[g.length - 1].label !== label) g.push({ label, items: [] });
      g[g.length - 1].items.push(m);
    }
    return g;
  }, [meetings]);

  return (
    <View style={st.root}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          { paddingTop: insets.top + s(6), paddingBottom: insets.bottom + s(120) },
          meetings.length === 0 && st.emptyFlex,
        ]}>
        <View style={st.header}>
          <View style={st.flex}>
            <Txt variant="screenTitle">Meetings</Txt>
            <Txt variant="sub" color={colors.inkDim} style={st.sub}>
              {meetings.length === 0
                ? 'Nothing recorded yet'
                : `${meetings.length} saved${totalMin > 0 ? ` · ${totalMin} min captured` : ''}`}
            </Txt>
          </View>
          <View style={st.headBtns}>
            <IconButton icon="search" label="Search meetings" onPress={() => navigation.navigate('Search')} />
            <IconButton icon="sliders" label="Settings" onPress={() => navigation.navigate('Settings')} />
          </View>
        </View>

        {streak >= 2 ? (
          <Pop style={st.streakWrap}>
            <Raised
              edge={colors.primaryEdge}
              gradient={{ from: colors.primary, to: colors.primaryLight, angle: 135 }}
              rad={radius.xl}
              depth={8}>
              <View style={st.streak}>
                <View style={st.streakIcon}>
                  <Icon name="flame" size={s(24)} color={colors.onPrimary} strokeWidth={2.4} />
                </View>
                <View style={st.flex}>
                  <Txt variant="bodyBlack" color={colors.onPrimary}>
                    {streak}-day capture streak
                  </Txt>
                  <View style={st.streakBar}>
                    <ProgressBar
                      pct={(Math.min(streak, 7) / 7) * 100}
                      color={colors.gold}
                      track="rgba(255,255,255,0.25)"
                    />
                  </View>
                </View>
                <View style={st.dots}>
                  {[0, 1, 2, 3, 4].map(i => (
                    <View
                      key={i}
                      style={[
                        st.dot,
                        { backgroundColor: i < Math.min(streak, 5) ? colors.gold : 'rgba(255,255,255,0.3)' },
                      ]}
                    />
                  ))}
                </View>
              </View>
            </Raised>
          </Pop>
        ) : null}

        {meetings.length === 0 ? (
          <Pop style={st.empty}>
            <Mascot mood="asleep" size={s(150)} />
            <Txt variant="display" style={st.emptyTitle}>
              No meetings yet
            </Txt>
            <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
              Tap record and Pip will listen, write the transcript, and work out who said what.
              Everything stays on your phone.
            </Txt>
          </Pop>
        ) : (
          groups.map((g, gi) => (
            <View key={g.label}>
              <Txt variant="overline" color={colors.inkFaint} style={st.dayLabel}>
                {g.label}
              </Txt>
              <View style={st.cards}>{layout(g.items, gi * 3)}</View>
            </View>
          ))
        )}
      </ScrollView>

      <View style={[st.fabWrap, { bottom: Math.max(insets.bottom, s(10)) + s(16) }]} pointerEvents="box-none">
        {/* The ring is absolutely positioned against THIS box, which shrinks to the button. Hung
            off the outer wrapper instead it inherits its left:0/right:0 and paints a full-width
            slab of indigo across whatever card happens to be behind it. */}
        <View pointerEvents="box-none">
          <FabRing />
          <Raised
            edge={colors.primaryEdge}
            gradient={{ from: '#5A66DE', to: colors.primary }}
            rad={radius.pill}
            depth={6}
            onPress={() => navigation.navigate('Record')}>
            <View style={st.fab}>
              <Icon name="mic" size={s(20)} color={colors.onPrimary} strokeWidth={2.6} />
              <Txt variant="cta" color={colors.onPrimary}>
                Record
              </Txt>
            </View>
          </Raised>
        </View>
      </View>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    emptyFlex: { flexGrow: 1, justifyContent: 'center' },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: s(20),
      paddingTop: s(6),
    },
    sub: { marginTop: s(6) },
    headBtns: { flexDirection: 'row', gap: s(8) },

    streakWrap: { marginHorizontal: s(20), marginTop: s(16) },
    streak: { flexDirection: 'row', alignItems: 'center', gap: s(14), paddingVertical: s(14), paddingHorizontal: s(16) },
    streakIcon: {
      width: s(46),
      height: s(46),
      borderRadius: s(16),
      backgroundColor: 'rgba(255,255,255,0.18)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    streakBar: { marginTop: s(6) },
    dots: { flexDirection: 'row', gap: s(5) },
    dot: { width: s(9), height: s(9), borderRadius: radius.pill },

    dayLabel: { marginHorizontal: s(20), marginTop: s(22), marginBottom: s(8) },
    cards: { paddingHorizontal: s(20), gap: s(14) },
    row2: { flexDirection: 'row', gap: s(14), alignItems: 'stretch' },
    // The design's short card: 92% of the column, so the stack's right edge is not a dead
    // straight line all the way down.
    narrow: { width: '92%' },
    wave: {
      marginTop: s(12),
      height: s(26),
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: s(3),
    },

    cardPad: { padding: s(18) },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: s(10) },
    cardTitle: { marginTop: s(12) },
    liveChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(5),
      paddingHorizontal: s(10),
      paddingVertical: s(5),
      borderRadius: radius.pill,
    },

    smallPad: { padding: s(16) },
    smallTitle: { marginTop: s(10) },
    smallMeta: { marginTop: s(10) },

    quietPad: { padding: s(16), gap: s(16), minHeight: s(120), justifyContent: 'space-between' },
    quietNum: { lineHeight: s(30) },

    empty: { alignItems: 'center', paddingHorizontal: s(30) },
    emptyTitle: { marginTop: s(18) },
    emptyBody: { textAlign: 'center', marginTop: s(8) },

    fabWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
    fab: { flexDirection: 'row', alignItems: 'center', gap: s(10), paddingHorizontal: s(30), paddingVertical: s(17) },
  });
}
