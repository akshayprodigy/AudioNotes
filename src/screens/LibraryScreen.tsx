import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { unsupportedLanguageShort } from './languages';
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useLibraryStore } from '../state/libraryStore';
import type { MeetingSort } from '../db/queries';
import { loadActions, tally } from './actionsData';
import { emptyFollowUp, loadFollowUp, type FollowUp } from './followUpData';
import FollowUpCard, { followUpVisible } from './FollowUpCard';
import AddToProjectSheet, { ADD_TO_PROJECT } from '../projects/AddToProjectSheet';
import { useImport } from './useImport';
import { refreshAllowance, useAllowance } from '../billing/allowance';
import { AllowanceLine } from './AllowanceNote';
import LibrarySummary from './LibrarySummary';
import { PipelineController } from '../pipeline/PipelineController';
import { db } from '../db/queries';
import ProNudgeCard from './ProNudgeCard';
import ProCompareSheet from './ProCompareSheet';
import ReadinessCard from '../setup/ReadinessCard';
import ProModelsCard from '../setup/ProModelsCard';
import DownloadsStrip from '../setup/DownloadsStrip';
import { watchDownloads } from '../setup/activeDownloads';
import { autoStartProModels } from '../setup/proModels';
import { useSetupReadiness } from '../setup/useReadiness';
import { SAMPLE_ID, isSampleId, withoutSample } from '../sample/sampleId';
import { deleteSample, seedSample } from '../sample/seedSample';
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
  Raised,
  Sheet,
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
    // A crash, which used to wear NO SPEECH. Not live: nothing is running until it is retried.
    case 'failed':
      return { label: "DIDN'T FINISH", color: c.danger, soft: c.dangerSoft, live: false };
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
    case 'failed':
      return m.failReason ?? 'Processing stopped. Open it to try again.';
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

export default function LibraryScreen({ navigation, route }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { meetings, refresh, sort, setSort, tag, tags, setTag } = useLibraryStore();
  // The sample is a meeting in the list but not one the person recorded, so every figure about how
  // much they have recorded (the header, the streak, the Pro nudge) is taken over their own.
  const own = useMemo(() => withoutSample(meetings), [meetings]);
  const hasSample = own.length !== meetings.length;
  // First-run setup: "Finish setup - 60% of 114 MB downloaded" until the essential models are here.
  const setup = useSetupReadiness();
  const reloadSetup = setup.reload;
  const [sorting, setSorting] = useState(false);
  const backfillSearch = useLibraryStore(st2 => st2.backfillSearch);
  const backfillItems = useLibraryStore(st2 => st2.backfillItems);
  const [sheetFor, setSheetFor] = useState<Meeting | null>(null);
  const [archived, setArchived] = useState(0);
  const [work, setWork] = useState({ total: 0, open: 0, meetings: 0 });
  /** The follow-up card's three lists (Pro). Drawn only when `paid`; read for everyone, shown to Pro. */
  const [follow, setFollow] = useState<FollowUp>(emptyFollowUp);
  /** The meeting "Add to project" is open for, from its long-press menu. */
  const [projectFor, setProjectFor] = useState<Meeting | null>(null);
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
        refreshAllowance();
        navigation.navigate('Meeting', { meetingId });
      },
      [navigation, refresh],
    ),
    useCallback(() => navigation.navigate('Paywall'), [navigation]),
  );
  // The Record screen's "Or import a recording" lands here: this screen owns the import, its
  // progress line and the share-sheet path, so the pick runs here too.
  const importNow = route.params?.importNow;
  useEffect(() => {
    if (importNow) importing.pick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importNow]);
  // Every model download, whoever started it, shows on this screen (founder, 22 Oct).
  useEffect(() => {
    watchDownloads();
  }, []);
  // The month's Free meetings, one quiet line under the count; nothing for Pro.
  const allowance = useAllowance();

  const countActions = useCallback(() => {
    loadActions()
      .then(rows => {
        const own = rows.filter(r => !isSampleId(r.meetingId));
        setWork(tally(own));
        // The same rows, read once: the follow-up lists must agree with the open-actions count.
        return loadFollowUp(Date.now(), own).then(setFollow);
      })
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
      // Pro is re-read on every focus, not only when the finished count moves: coming back from
      // the Pro screen after buying must unlock Search, Actions and Threads at once.
      entitlement().then(e => { setPaid(e.paid); setPaidKnown(true); }).catch(() => {});
      refreshAllowance();
      countActions();
      // The disk may have changed while this screen was away (a download finished or died).
      reloadSetup();
      PipelineController.processPending().then(refresh).catch(() => {});
    };
    onFocus();
    return navigation.addListener('focus', onFocus);
  }, [navigation, refresh, backfillSearch, backfillItems, countActions, reloadSetup]);

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
    if (isSampleId(m.id)) {
      // Deleting it is always allowed and cheap: "See the sample again" brings it back. Archiving
      // is left out, because a hidden sample is just a delete with an extra step.
      return [
        {
          icon: 'trash',
          label: 'Delete sample',
          hint: 'Removes the sample meeting and its audio. You can bring it back from the Library.',
          destructive: true,
          onPress: () =>
            confirmDestructive({
              title: 'Delete the sample?',
              message: 'The sample meeting and its audio are removed from this phone. You can bring it back from the Library.',
              confirmLabel: 'Delete sample',
              onConfirm: () => {
                deleteSample().catch(() => {}).then(reload);
              },
            }),
        },
      ];
    }
    return [
      {
        ...ADD_TO_PROJECT,
        onPress: () => setProjectFor(m),
      },
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
  // Whether this is Pro, for the doors that are (Actions, Threads). Search is not one of them:
  // keyword search is Free. Read here rather than inside the button so the tap is decided from
  // state that is already loaded, not from an await in a press handler.
  const [paid, setPaid] = useState(false);
  // Until the first answer the header draws no Actions, so a Free user never
  // sees them flash up for a frame before the entitlement lands.
  const [paidKnown, setPaidKnown] = useState(false);
  // The Free-and-Pro sheet the count opens. Free only: Pro has no count.
  const [proSheet, setProSheet] = useState(false);
  // Pro's models are part of Pro: on a Pro phone a download that stopped is picked up by itself,
  // once per launch, so nobody needs Settings for it.
  useEffect(() => {
    if (paidKnown) autoStartProModels(paid);
  }, [paid, paidKnown]);

  /**
   * Meetings that actually finished.
   *
   * A meeting still processing has shown its owner nothing, so it is not evidence that they are
   * getting value out of the app and must not count towards asking them to pay for more of it.
   */
  const completed = useMemo(() => own.filter(m => m.status === 'done').length, [own]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const [ent, seen] = await Promise.all([entitlement(), nudgeState()]);
      if (alive) { setPaid(ent.paid); setPaidKnown(true); }
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

  const streak = useMemo(() => captureStreak(own), [own]);
  const totalMin = useMemo(
    () => Math.round(own.reduce((a, m) => a + (m.durationMs || 0), 0) / 60000),
    [own],
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
    const showStatus = m.status !== 'done';
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
              {showStatus && status.live ? (
                <View style={[st.liveChip, { backgroundColor: status.soft }]}>
                  <LiveDot color={status.color} size={s(6)} />
                  <Txt variant="chip" color={status.color}>
                    {status.label}
                  </Txt>
                </View>
              ) : null}
              {showStatus && !status.live ? (
                <Badge label={status.label} color={status.color} soft={status.soft} />
              ) : null}
              {isSampleId(m.id) ? <Badge label="SAMPLE" color={colors.primaryDeep} soft={colors.primarySoft} /> : null}
              <View style={st.flex} />
              <Txt variant="chipSoft" color={colors.inkFaint}>
                {[m.mode === 'dictation' ? 'Dictation' : null, when(m.createdAt), dur(m.durationMs)].filter(Boolean).join(' · ')}
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
          </View>
        </Raised>
      </Pop>
    );
  };

  /** Narrow card used in a two-up row. */
  const SmallCard = ({ m, i, flex }: { m: Meeting; i: number; flex: number }) => {
    const status = badgeFor(m);
    const showStatus = m.status !== 'done';
    const showSample = isSampleId(m.id);
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
            {showStatus || showSample ? (
              <View style={st.badges} testID="small-badges">
                {showStatus ? <Badge label={status.label} color={status.color} soft={status.soft} small /> : null}
                {showSample ? <Badge label="SAMPLE" color={colors.primaryDeep} soft={colors.primarySoft} small /> : null}
              </View>
            ) : null}
            <Txt variant="cardTitleSm" style={[st.smallTitle, !(showStatus || showSample) && st.smallTitleFirst]} numberOfLines={2}>
              {m.title || 'Untitled meeting'}
            </Txt>
            <Txt variant="chipSoft" color={colors.inkFaint} style={st.smallMeta}>
              {[m.mode === 'dictation' ? 'Dictation' : null, when(m.createdAt), dur(m.durationMs)].filter(Boolean).join(' · ')}
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

        <View style={st.header} testID="library-header">
          <View style={st.flex}>
            <Txt variant="screenTitle" fit>
              Meetings
            </Txt>
          </View>
          <View style={st.headBtns}>
            {/* Keyword search is Free; only search by meaning is Pro, and the Search screen says so. */}
            <IconButton
              icon="search"
              label="Search meetings"
              onPress={() => navigation.navigate('Search')}
            />
            <IconButton icon="settings" label="Settings" onPress={() => navigation.navigate('Settings')} />
          </View>
        </View>

        {/* Under the row, at full width. Beside the buttons the column is only as wide as what is
            left after four of them, and on a 360 dp phone that wrapped every one of these lines.
            With something recorded the numbers move to the summary strip instead. */}
        {own.length === 0 ? (
          <View style={st.headSub}>
            <Txt variant="sub" color={colors.inkDim}>
              Nothing recorded yet
            </Txt>
            <AllowanceLine status={allowance} onPress={() => setProSheet(true)} />
          </View>
        ) : null}

        {own.length > 0 ? (
          <LibrarySummary
            saved={own.length}
            capturedMin={totalMin}
            allowance={allowance}
            onUpgrade={() => setProSheet(true)}
            openActions={paid ? work.open : null}
            onOpenActions={() => navigation.navigate('Actions')}
          />
        ) : null}

        <ReadinessCard setup={setup} />
        <ProModelsCard />
        <DownloadsStrip />

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

        {/* The follow-up card leads: what is still owed matters more than how often you record.
            Pro only; Free sees nothing new here (the count's Free-and-Pro sheet is its door). */}
        {paid && followUpVisible(work, follow) ? (
          <FollowUpCard
            work={work}
            follow={follow}
            onOpenActions={() => navigation.navigate('Actions')}
            onOpenList={kind => {
              // One meeting waiting for review is the queue itself; several is a list to choose from.
              if (kind === 'review' && follow.review.length === 1) {
                navigation.navigate('Review', { meetingId: follow.review[0].meetingId });
              } else {
                navigation.navigate('FollowUp', { kind });
              }
            }}
          />
        ) : null}

        {/* A quiet footer, not a banner: how many days running somebody has recorded is a fact, and
            never a state to protect. No urgency, no colour that means alert. The count is still
            derived (captureStreak) so nothing about it was deleted. */}
        {streak >= 2 ? (
          <View style={st.streakLine}>
            <Icon name="flame" size={s(14)} color={colors.inkFaint} strokeWidth={2.2} />
            <Txt variant="chipSoft" color={colors.inkFaint}>
              {`Recorded ${streak} days in a row`}
            </Txt>
          </View>
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

        {/* Only with no meeting at all: beside the sample card it would contradict it, and the
            header already says "Nothing recorded yet". */}
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
        ) : null}
        {meetings.length > 0
          ? groups.map((g, gi) => (
              <View key={g.label}>
                <Txt variant="overline" color={colors.inkFaint} style={st.dayLabel}>
                  {g.label}
                </Txt>
                <View style={st.cards}>{layout(g.items, gi * 3)}</View>
              </View>
            ))
          : null}

        {/* Always there to be found again. Quiet: it is a way back to something deleted, not a
            call to action. */}
        {!hasSample ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="See the sample again"
            onPress={() => {
              seedSample()
                .then(() => {
                  refresh();
                  navigation.navigate('Meeting', { meetingId: SAMPLE_ID });
                })
                .catch(() => {});
            }}
            style={st.sampleRow}>
            <Icon name="play" size={s(16)} color={colors.primaryDeep} strokeWidth={2.4} />
            <Txt variant="chip" color={colors.primaryDeep}>
              See the sample again
            </Txt>
          </Pressable>
        ) : null}

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

      <AddToProjectSheet
        visible={projectFor !== null}
        meetingId={projectFor?.id ?? ''}
        meetingTitle={projectFor?.title}
        onClose={() => setProjectFor(null)}
        onChanged={() => refresh()}
        onUpgrade={() => navigation.navigate('Paywall')}
      />

      <ProCompareSheet
        visible={proSheet}
        allowance={allowance}
        onClose={() => setProSheet(false)}
        onGetPro={() => {
          setProSheet(false);
          navigation.navigate('Paywall');
        }}
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
    headSub: { paddingHorizontal: s(20), marginTop: s(6) },
    headBtns: { flexDirection: 'row', gap: s(8) },

    streakLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(6),
      marginHorizontal: s(20),
      marginTop: s(10),
    },

    dayLabel: { marginHorizontal: s(20), marginTop: s(22), marginBottom: s(8) },
    cards: { paddingHorizontal: s(20), gap: s(14) },
    row2: { flexDirection: 'row', gap: s(14), alignItems: 'stretch' },
    // The design's short card: 92% of the column, so the stack's right edge is not a dead
    // straight line all the way down.
    narrow: { width: '92%' },

    cardPad: { padding: s(18) },
    // Wraps: at 200% text the time and length would otherwise run off the card's right edge.
    cardTop: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: s(10), rowGap: s(4) },
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
    badges: { flexDirection: 'row', flexWrap: 'wrap', gap: s(6) },
    smallTitle: { marginTop: s(10) },
    smallTitleFirst: { marginTop: 0 },
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
    sampleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: s(8),
      minHeight: s(48),
      marginTop: s(16),
      marginHorizontal: s(20),
    },
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
