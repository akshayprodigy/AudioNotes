import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { unsupportedLanguageShort } from './languages';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useLibraryStore } from '../state/libraryStore';
import type { MeetingSort } from '../db/queries';
import { loadActions, tally } from './actionsData';
import { useImport } from './useImport';
import { PipelineController } from '../pipeline/PipelineController';
import { db } from '../db/queries';
import ProNudgeCard from './ProNudgeCard';
import {
  entitlement,
  noteNudgeShown,
  nudgeState,
  refuseNudge,
  shouldNudgeForPro,
} from '../billing/trial';
import Icon, { type IconName } from '../components/Icon';
import Mascot from '../components/Mascot';
import RecordingBar from '../components/RecordingBar';
import { confirmDestructive, quoted } from '../components/confirm';
import {
  Badge,
  IconButton,
  LiveDot,
  Pop,
  ProgressBar,
  Raised,
  Sheet,
  Tile,
  Txt,
  type SheetAction,
} from '../components/ui';
import type { Meeting } from '../pipeline/types';
import { radius, s, tilt, useTheme, type Colors } from '../theme';

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
    // Finished, not in flight. This fell through to the default below and showed a live
    // TRANSCRIBING badge on a meeting nothing was working on, forever.
    case 'unsupported_language':
      return { label: 'NOT ENGLISH', color: c.warning, soft: c.warningSoft, live: false };
    default:
      return { label: 'TRANSCRIBING', color: c.primary, soft: c.primarySoft, live: true };
  }
}

/**
 * The line under a card's title.
 *
 * A row must never be blank while work is in flight — that reads as broken. Processing a meeting
 * takes tens of minutes (ASR alone runs at 0.68x realtime) and narration adds another minute and a
 * half at the end, so for most of a recording's life this is the only thing the row can say.
 *
 * Once narration has run it is replaced by the one-liner the model wrote, which is the whole point:
 * a library of rows reading "Okay so um yeah let's start" is a folder of recordings, and a library
 * of rows saying what each meeting was about is a record of what happened.
 */
function subtitleOf(m: Meeting): string | null {
  if (m.summaryLine) return m.summaryLine;
  switch (m.status) {
    case 'recording':
      return null; // the live chip is already saying it, louder
    case 'captured':
      return 'Waiting to start…';
    case 'vad':
    case 'asr':
      return 'Writing down the words…';
    case 'diarized':
      return 'Telling the voices apart…';
    case 'unsupported_language':
      // Composed, never stored: see unsupportedLanguageShort. This row must say why it is not
      // READY, and the refusal explanation must not survive into a meeting that later transcribes.
      return unsupportedLanguageShort(m.language);
    case 'done':
      return null; // narrated meetings have a line; un-narrated ones say nothing rather than guess
    default:
      return null;
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

const SORTS: { key: MeetingSort; label: string; hint: string }[] = [
  { key: 'recent', label: 'Newest first', hint: 'The default, and what you want most days.' },
  { key: 'oldest', label: 'Oldest first', hint: 'For working forwards through a backlog.' },
  { key: 'longest', label: 'Longest first', hint: 'Real meetings float up; mis-taps sink.' },
  { key: 'title', label: 'By name', hint: 'Once meetings have names you chose.' },
];

/** A filter pill. Small enough to live here rather than in the shared kit. */
function Chip({
  label,
  on,
  onPress,
  colors,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  colors: Colors;
}) {
  const st = useMemo(() => makeStyles(colors), [colors]);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={label}
      style={[
        st.chip,
        {
          borderColor: on ? colors.primary : colors.line,
          backgroundColor: on ? colors.primarySoft : colors.card,
        },
      ]}>
      <Txt variant="chipSm" color={on ? colors.primaryDeep : colors.inkDim}>
        {label}
      </Txt>
    </Pressable>
  );
}

export default function LibraryScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { meetings, refresh, sort, setSort, tag, tags, setTag } = useLibraryStore();
  const [sorting, setSorting] = useState(false);
  const backfillSearch = useLibraryStore(st2 => st2.backfillSearch);
  const backfillItems = useLibraryStore(st2 => st2.backfillItems);
  const [sheetFor, setSheetFor] = useState<Meeting | null>(null);
  const [archived, setArchived] = useState(0);
  const [work, setWork] = useState({ total: 0, open: 0, meetings: 0 });
  /** Meetings the pipeline has paused for the phone's sake; their badge reads PAUSED. */
  const [pausedIds, setPausedIds] = useState<Set<string>>(new Set());
  useEffect(
    () =>
      PipelineController.onPause(e =>
        setPausedIds(prev => {
          const next = new Set(prev);
          if (e.reason) next.add(e.meetingId);
          else next.delete(e.meetingId);
          return next;
        }),
      ),
    [],
  );

  /**
   * Importing lives here because the library is where the app comes back to.
   *
   * A share that arrives while the app is closed lands on whatever mounts first, and this screen
   * is it — so the confirmation appears over the meeting list rather than over nothing. Opening
   * the new meeting on completion is the same thing a finished recording does.
   */
  const importing = useImport(
    useCallback(
      (meetingId: string) => {
        refresh();
        navigation.navigate('Meeting', { meetingId });
      },
      [navigation, refresh],
    ),
  );

  const countActions = useCallback(() => {
    loadActions()
      .then(rows => setWork(tally(rows)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onFocus = () => {
      // Both sweeps ride on the refresh rather than on a timer of their own, because the count
      // they latch against only means anything once the meetings have been loaded. Each
      // short-circuits to nothing unless that count has actually moved, so putting them on every
      // focus costs nothing and heals a restored backup on the very next one.
      //
      // IN SEQUENCE, not concurrently, and the item migration first. There is one process-wide
      // SQLCipher connection shared with the recording service, and both sweeps are chunked
      // precisely so that no single native call is long enough to be the reason this transition
      // drops frames; run together their calls interleave on that one connection, each batch waits
      // behind the other's, and the yield between passes stops being a yield. Items lead because
      // what they repair is a false statement — the worklist and Search's "meetings with actions"
      // filter both read ACROSS meetings and, unmigrated, describe the meetings somebody has
      // opened rather than the library. The search backlog costs results in a screen that already
      // says it may be incomplete, and it has a second driver in PipelineController.sweep.
      refresh()
        .then(backfillItems)
        // countActions ran below, before any of this, so on the first focus after an update it
        // tallied a library that had not been migrated yet. `true` means native was asked and that
        // tally may be stale; `false` is the latched case, where nothing on disk moved and
        // re-counting would be two library-wide queries per focus, forever, for the same answer.
        //
        // `work` is the "N open actions" card below the streak. A re-count that is missing here
        // is a card that reads 0 over a full worklist on the first focus after an update, which is
        // the exact failure this sweep exists to end.
        .then(swept => { if (swept) countActions(); })
        .then(backfillSearch)
        .catch(() => {});
      db.archivedCount().then(setArchived).catch(() => {});
      countActions();
      PipelineController.processPending().then(refresh).catch(() => {});
    };
    onFocus();
    return navigation.addListener('focus', onFocus);
  }, [navigation, refresh, backfillSearch, backfillItems, countActions]);

  const reload = () => {
    refresh();
    db.archivedCount().then(setArchived).catch(() => {});
    // Archiving or deleting a meeting takes its action items out of the worklist too.
    countActions();
  };

  /**
   * Long-press actions. A live recording is excluded: archiving or deleting the meeting the
   * microphone is currently writing into would pull the row out from under the capture service.
   */
  const sheetActions = (m: Meeting): SheetAction[] => {
    if (m.status === 'recording') {
      return [
        {
          icon: 'alert',
          label: 'Still recording',
          hint: 'Finish this meeting before archiving or deleting it.',
          onPress: () => {},
        },
      ];
    }
    return [
      {
        icon: 'archive',
        label: 'Archive',
        hint: 'Hides it from the library. Nothing is deleted, and you can restore it.',
        onPress: () => db.setArchived(m.id, true).then(reload).catch(() => {}),
      },
      {
        icon: 'trash',
        label: 'Delete',
        hint: 'Removes the recording, transcript and minutes for good.',
        destructive: true,
        onPress: () =>
          confirmDestructive({
            title: 'Delete this meeting?',
            message: `The recording, transcript and minutes for ${quoted(
              m.title,
            )} will be permanently deleted. This cannot be undone.`,
            confirmLabel: 'Delete',
            onConfirm: () => {
              PipelineController.deleteMeeting(m.id).then(reload).catch(() => {});
            },
          }),
      },
    ];
  };

  const [nudge, setNudge] = useState(false);
  // Search across every transcript is part of Pro. Read here rather than inside the button so the
  // tap is decided from state that is already loaded, not from an await in a press handler.
  const [paid, setPaid] = useState(false);

  /**
   * Meetings that actually finished.
   *
   * A meeting still processing has shown its owner nothing, so it is not evidence that they are
   * getting value out of the app and must not count towards asking them to pay for more of it.
   */
  const completed = useMemo(() => meetings.filter(m => m.status === 'done').length, [meetings]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [ent, seen] = await Promise.all([entitlement(), nudgeState()]);
      if (alive) setPaid(ent.paid);
      const show = shouldNudgeForPro({
        completed,
        lastShownAt: seen.lastShownAt,
        refusals: seen.refusals,
        entitlement: ent,
      });
      if (!alive) return;
      setNudge(show);
      // Recorded when it is rendered, not when it becomes eligible: otherwise somebody who never
      // opened the library would burn the offer without ever seeing it.
      if (show) await noteNudgeShown(completed);
    })();
    return () => {
      alive = false;
    };
  }, [completed]);

  const streak = useMemo(() => captureStreak(meetings), [meetings]);
  const totalMin = useMemo(
    () => Math.round(meetings.reduce((a, m) => a + (m.durationMs || 0), 0) / 60000),
    [meetings],
  );

  const open = (id: string) => navigation.navigate('Meeting', { meetingId: id });

  /** The badge, with the pipeline's pause — runtime state, never persisted — laid over the status. */
  const badgeFor = (m: Meeting) =>
    pausedIds.has(m.id)
      ? { label: 'PAUSED', color: colors.warning, soft: colors.warningSoft, live: true }
      : statusOf(m.status, colors);

  /** Full-width card: tile + status + time, then title. */
  const BigCard = ({ m, i }: { m: Meeting; i: number }) => {
    const status = badgeFor(m);
    return (
      <Pop index={i}>
        <Raised
          edge={colors.line}
          fill={colors.card}
          rad={radius.card}
          depth={6}
          rotate={tilt(i)}
          onPress={() => open(m.id)}
          onLongPress={() => setSheetFor(m)}>
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
            {subtitleOf(m) ? (
              <Txt
                variant="chipSoft"
                color={m.summaryLine ? colors.inkSoft : colors.inkFaint}
                numberOfLines={2}
                style={st.cardLine}>
                {subtitleOf(m)}
              </Txt>
            ) : null}
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
    const bars = Array.from({ length: 12 }, (_, _i) => {
      h = (h * 1103515245 + 12345) >>> 0;
      return 0.3 + ((h >>> 16) % 71) / 100; // 0.30 - 1.00
    });
    // Four steps of the primary ramp rather than four literals: the bars have to sit on the card
    // in both themes, and a hardcoded pale indigo on a #171A24 card is a white smear.
    const shades = [colors.primarySoft2, colors.primarySoftEdge, colors.primary, colors.primaryLight];
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
    const status = badgeFor(m);
    return (
      <Pop index={i} style={{ flex }}>
        <Raised
          edge={colors.line}
          fill={colors.card}
          rad={radius.xl}
          depth={6}
          rotate={tilt(i)}
          onPress={() => open(m.id)}
          onLongPress={() => setSheetFor(m)}>
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
        onPress={() => open(m.id)}
          onLongPress={() => setSheetFor(m)}>
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
        {/* Decoding an hour of audio is not instant, and an import that looks like nothing is
            happening gets tapped again. Shown as a strip rather than a modal so the library stays
            usable — the meeting appears in the list when it lands. */}
        {importing.busy ? (
          <View style={st.importing}>
            <Icon name="download" size={s(16)} color={colors.primaryDeep} strokeWidth={2.6} />
            <Txt variant="chip" color={colors.primaryDeep} style={st.flex}>
              {importing.progress === null
                ? 'Reading the recording…'
                : `Reading the recording… ${Math.round(importing.progress * 100)}%`}
            </Txt>
          </View>
        ) : null}

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
            {/* Sits with search and settings rather than beside the record button: importing is
                something you do occasionally and deliberately, and putting it next to Record
                would put a second call to action against the one this screen is built around. */}
            <IconButton
              icon={importing.busy ? 'clock' : 'download'}
              label="Import a recording"
              onPress={importing.busy ? () => {} : importing.pick}
            />
            {/* Free lands on the paywall, where search is the first thing listed, so the tap
                explains itself instead of appearing to do nothing. */}
            <IconButton
              icon="search"
              label={paid ? 'Search meetings' : 'Search meetings (Pro)'}
              onPress={() => navigation.navigate(paid ? 'Search' : 'Paywall')}
            />
            <IconButton
              icon="list"
              label={paid ? 'Actions' : 'Actions (Pro)'}
              onPress={() => navigation.navigate(paid ? 'Actions' : 'Paywall')}
            />
            <IconButton icon="sliders" label="Settings" onPress={() => navigation.navigate('Settings')} />
          </View>
        </View>

        {/* Only once there is something to sort or filter. On a library of three meetings this
            row is furniture in front of the content. */}
        {meetings.length + (tag ? 1 : 0) > 4 || tags.length > 0 ? (
          <View style={st.filterRow}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={st.chips}>
              <Chip label="All" on={tag === null} onPress={() => setTag(null)} colors={colors} />
              {tags.map(t => (
                <Chip
                  key={t.name}
                  label={`${t.name} · ${t.n}`}
                  on={tag === t.name}
                  onPress={() => setTag(tag === t.name ? null : t.name)}
                  colors={colors}
                />
              ))}
            </ScrollView>
            <IconButton
              icon="filter"
              label={`Sort: ${SORTS.find(x => x.key === sort)?.label ?? 'Newest'}`}
              onPress={() => setSorting(true)}
            />
            {tag !== null ? (
              <IconButton
                icon="list"
                label={paid ? 'Open thread' : 'Open thread (Pro)'}
                onPress={() => (paid ? navigation.navigate('Thread', { tag }) : navigation.navigate('Paywall'))}
              />
            ) : null}
          </View>
        ) : null}

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

        {/* The tracker's front door. Hidden when nothing is open — "0 open actions" is a nag —
            and hidden outright on free, where the worklist itself is Pro (the "Actions (Pro)"
            header button is the nudge). */}
        {paid && work.open > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open actions"
            onPress={() => navigation.navigate('Actions')}
            style={st.actionsWrap}>
            <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={6}>
              <View style={st.actionsCard}>
                <View style={[st.actionsIcon, { backgroundColor: colors.primarySoft }]}>
                  <Icon name="list" size={s(20)} color={colors.primary} strokeWidth={2.4} />
                </View>
                <View style={st.flex}>
                  <Txt variant="bodyBlack">
                    {work.open} open action{work.open === 1 ? '' : 's'}
                  </Txt>
                  <Txt variant="chipSoft" color={colors.inkSoft}>
                    across {work.meetings} meeting{work.meetings === 1 ? '' : 's'}
                  </Txt>
                </View>
                <Icon name="chevronRight" size={s(18)} color={colors.inkFaint} />
              </View>
            </Raised>
          </Pressable>
        ) : null}

        {nudge ? (
          <ProNudgeCard
            meetings={completed}
            onOpen={() => {
              setNudge(false);
              navigation.navigate('Paywall');
            }}
            onDismiss={() => {
              setNudge(false);
              refuseNudge();
            }}
          />
        ) : null}

        {meetings.length === 0 ? (
          <Pop style={[st.empty, st.emptyGrow]}>
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

        {/* Only once something is in it. An always-visible "Archived (0)" is a permanent
            reminder of a feature most people will never use. */}
        {archived > 0 ? (
          <View style={st.archiveRow}>
            <Raised
              edge={colors.line}
              fill={colors.card}
              rad={radius.xl}
              depth={5}
              onPress={() => navigation.navigate('Archive')}>
              <View style={st.archiveInner}>
                <View style={st.archiveIcon}>
                  <Icon name="archive" size={s(18)} color={colors.inkSoft} strokeWidth={2.4} />
                </View>
                <Txt variant="bodyStrong" style={st.flex}>
                  Archived
                </Txt>
                <Txt variant="chipSoft" color={colors.inkFaint}>
                  {archived}
                </Txt>
                <Icon name="chevronRight" size={s(18)} color={colors.inkFaint} strokeWidth={2.4} />
              </View>
            </Raised>
          </View>
        ) : null}
      </ScrollView>

      <Sheet
        visible={sorting}
        title="Sort meetings"
        actions={SORTS.map(o => ({
          icon: (o.key === sort ? 'check' : 'list') as IconName,
          label: o.label,
          hint: o.hint,
          onPress: () => setSort(o.key),
        }))}
        onClose={() => setSorting(false)}
      />

      <Sheet
        visible={sheetFor !== null}
        title={sheetFor?.title || 'Meeting'}
        actions={sheetFor ? sheetActions(sheetFor) : []}
        onClose={() => setSheetFor(null)}
      />

      {/* Sits just above the Record dock while a meeting is recording: tap to jump back into the
          recorder, ■ to stop. Returns null when idle, so this wrapper is empty the rest of the
          time (box-none lets touches through to the list below). */}
      <View
        style={[st.barWrap, { bottom: Math.max(insets.bottom, s(10)) + s(16) + s(72) }]}
        pointerEvents="box-none">
        <RecordingBar navigation={navigation} />
      </View>

      <View style={[st.fabWrap, { bottom: Math.max(insets.bottom, s(10)) + s(16) }]} pointerEvents="box-none">
        {/* The ring is absolutely positioned against THIS box, which shrinks to the button. Hung
            off the outer wrapper instead it inherits its left:0/right:0 and paints a full-width
            slab of indigo across whatever card happens to be behind it. */}
        <View pointerEvents="box-none">
          <FabRing />
          <Raised
            edge={colors.primaryEdge}
            gradient={{ from: colors.primaryLight, to: colors.primary }}
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
    // Fills the screen so the empty block below has room to centre itself in. Deliberately does
    // NOT centre its own children: this is the ScrollView's content container, so centring here
    // would take the header down to the middle of the screen with everything else.
    emptyFlex: { flexGrow: 1 },
    filterRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(8),
      paddingLeft: s(20),
      paddingRight: s(12),
      marginBottom: s(12),
    },
    chips: { gap: s(8), paddingRight: s(8), alignItems: 'center' },
    chip: {
      paddingHorizontal: s(12),
      paddingVertical: s(7),
      borderRadius: radius.pill,
      borderWidth: 1,
    },
    importing: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(10),
      marginHorizontal: s(20),
      marginBottom: s(10),
      paddingHorizontal: s(14),
      paddingVertical: s(10),
      borderRadius: radius.ctl,
      backgroundColor: c.primarySoft,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: s(20),
      paddingTop: s(6),
    },
    sub: { marginTop: s(6) },
    headBtns: { flexDirection: 'row', gap: s(8) },

    streakWrap: { marginHorizontal: s(20), marginTop: s(16) },
    actionsWrap: { marginHorizontal: s(20), marginTop: s(12) },
    actionsCard: { flexDirection: 'row', alignItems: 'center', gap: s(12), padding: s(14) },
    actionsIcon: { width: s(40), height: s(40), borderRadius: radius.ctl, alignItems: 'center', justifyContent: 'center' },
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
    cardLine: { marginTop: s(4) },
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
    // Only when there is nothing else in the list: takes the space the header and cards are not
    // using, and centres the mascot inside that, leaving the header where a header belongs.
    emptyGrow: { flexGrow: 1, justifyContent: 'center' },
    emptyTitle: { marginTop: s(18) },
    emptyBody: { textAlign: 'center', marginTop: s(8) },

    archiveRow: { marginHorizontal: s(20), marginTop: s(24) },
    archiveInner: { flexDirection: 'row', alignItems: 'center', gap: s(12), padding: s(14) },
    archiveIcon: {
      width: s(34),
      height: s(34),
      borderRadius: s(12),
      backgroundColor: c.cardAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },

    barWrap: { position: 'absolute', left: 0, right: 0 },
    fabWrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
    fab: { flexDirection: 'row', alignItems: 'center', gap: s(10), paddingHorizontal: s(30), paddingVertical: s(17) },
  });
}
