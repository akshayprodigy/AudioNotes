import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Easing, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import FileExport from '../native/NativeFileExport';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { confirmDestructive, quoted } from '../components/confirm';
import {
  Badge,
  IconButton,
  ProgressRing,
  GradientFill,
  Raised,
  Segmented,
  Sheet,
  SoftButton,
  Txt,
  type SheetAction,
} from '../components/ui';
import SummaryTab from './meeting/SummaryTab';
import MinutesTab from './meeting/MinutesTab';
import ActionsTab from './meeting/ActionsTab';
import TranscriptTab from './meeting/TranscriptTab';
import type { Meeting, Minute, Speaker, Utterance } from '../pipeline/types';
import { radius, s, sv, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Meeting'>;

/**
 * Pipeline stages, phrased as what they achieve, with the cost of each measured on device (the
 * `stage=` timings logged by AudioPipelineModule) as seconds of work per second of audio.
 *
 * Cost is held as a RATE rather than as a share of the whole, because a share only describes the
 * run it was measured on. A re-run that still has its transcript skips VAD, ASR and diarization
 * outright, so those four stages complete in well under a second — and an ETA that divided
 * elapsed time by percent-complete read that as the pace of the entire job. The screen said
 * "92% · about 1s left" with eight minutes of writing still ahead of it. A rate against the
 * meeting's own length survives a skipped stage, because a stage that does not run costs nothing.
 *
 * The rates also drive the ring, so progress advances at a roughly even pace rather than sitting
 * at 5% and then jumping to done.
 */
const STAGES: { key: string; label: string; rate: number }[] = [
  { key: 'vad', label: 'Audio cleaned up', rate: 0.08 },
  // whisper-base runs at about 0.68x realtime, two threads.
  { key: 'asr', label: 'Words written down', rate: 1.47 },
  { key: 'diarize', label: 'Speakers separated', rate: 0.67 },
  { key: 'minutes', label: 'Pulling out the minutes', rate: 0.11 },
  // 460 s of narration against a 24-minute recording, three chunks, on the IPD meeting. Prefill
  // at ~37 tok/s dominates, so the cost tracks transcript length rather than anything else.
  { key: 'narrate', label: 'Written up in plain English', rate: 0.32 },
];
const TOTAL_RATE = STAGES.reduce((a, x) => a + x.rate, 0);

/** Seconds into a human wait. "480s left" is a number; "about 8 min left" is an answer. */
function etaLabel(sec: number): string {
  if (sec <= 0) return '';
  if (sec < 90) return ` · about ${sec}s left`;
  return ` · about ${Math.round(sec / 60)} min left`;
}

export default function MeetingScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { meetingId } = route.params;

  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [minutes, setMinutes] = useState<Minute[]>([]);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [speechMs, setSpeechMs] = useState(0);
  const [reprocessing, setReprocessing] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [sheet, setSheet] = useState(false);
  // Always lands on Summary. A remembered tab means tapping two meetings in a row opens them on
  // different screens, which reads as a bug rather than a convenience.
  const [tab, setTab] = useState('summary');

  const refresh = useCallback(async () => {
    const [mtg, mins, utts, segs, spk] = await Promise.all([
      db.getMeeting(meetingId),
      db.minutes(meetingId),
      db.utterances(meetingId),
      db.segments(meetingId),
      db.speakers(meetingId),
    ]);
    setMeeting(mtg ?? null);
    setMinutes(mins);
    setUtterances(utts);
    setSpeakers(spk);
    setSpeechMs(segs.reduce((a, x) => a + (x.end_ms - x.start_ms), 0));
    return mins.length;
  }, [meetingId]);

  useEffect(() => {
    let cancelled = false;
    let ticks = 0;
    const load = async () => {
      const count = await refresh();
      if (cancelled) return;
      if (count === 0 && ticks < 60) {
        ticks += 1;
        setTimeout(load, 2000);
      } else setSettled(true);
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  useEffect(() => {
    const offProgress = PipelineController.onProgress(p => {
      if (p.meetingId === meetingId) setStage(p.stage);
    });
    const offComplete = PipelineController.onComplete(e => {
      if (e.meetingId !== meetingId) return;
      setStage(null);
      setSettled(true);
      if (e.outcome === 'error') setFailure(e.message ?? 'Processing failed');
      refresh();
    });
    return () => {
      offProgress();
      offComplete();
    };
  }, [meetingId, refresh]);

  /**
   * Run the pipeline again.
   *
   * `rewriteProse` clears the LLM rows first. Without it a meeting that already has a summary has
   * no outstanding stages, so the run returns instantly and the button appears to do nothing —
   * see db.clearNarration. The Summary tab passes it; the Redo button in the overflow sheet does
   * not, because Redo is there to recover a run that fell over, not to spend eight minutes of
   * model time on prose that is already written.
   */
  const onReprocess = useCallback(
    async (rewriteProse = false) => {
      if (reprocessing) return;
      setReprocessing(true);
      setFailure(null);
      try {
        if (rewriteProse) {
          await db.clearNarration(meetingId);
          await refresh();
        }
        await PipelineController.process(meetingId, { model: 'base' });
        await refresh();
      } catch (e: any) {
        Alert.alert('Could not reprocess', String(e?.message ?? e));
      } finally {
        setReprocessing(false);
      }
    },
    [meetingId, refresh, reprocessing],
  );

  const onExport = () =>
    Alert.alert('Export minutes', 'Choose a format', [
      { text: 'Markdown', onPress: () => FileExport.share(meetingId, 'md') },
      { text: 'Plain text', onPress: () => FileExport.share(meetingId, 'txt') },
      { text: 'Subtitles (.srt)', onPress: () => FileExport.share(meetingId, 'srt') },
      { text: 'Cancel', style: 'cancel' },
    ]);

  const working = stage !== null || reprocessing || (!settled && minutes.length === 0);
  const empty = settled && !working && minutes.length === 0 && utterances.length === 0;

  /**
   * Per-meeting actions, in the overflow sheet.
   *
   * Speakers, Export and Redo used to sit in a button row on the results page. The tab refactor
   * dropped that row, which left a finished meeting with no way to reprocess it — and reprocessing
   * is exactly what every meeting recorded before narration shipped needs. They live here now
   * rather than as a permanent row, which would cost vertical space on all four tabs.
   *
   * Archive and Delete both leave this screen, so both pop back to the library first — a detail
   * screen for a meeting just archived out of the library, or deleted outright, has nothing left
   * to show and its polling refresh would query a row that no longer exists.
   */
  const sheetActions: SheetAction[] = [
    {
      icon: 'users',
      label: 'Speakers',
      hint: 'Rename people, or merge two speakers the app split apart.',
      onPress: () => navigation.navigate('Speakers', { meetingId }),
    },
    {
      icon: 'share',
      label: 'Export',
      hint: 'Share the minutes as Markdown, plain text or subtitles.',
      onPress: onExport,
    },
    {
      icon: 'refresh',
      label: reprocessing ? 'Working…' : 'Redo',
      hint: 'Run any stage that has not finished. To rewrite the summary, use the Summary tab.',
      onPress: () => onReprocess(),
    },
    {
      icon: 'archive',
      label: 'Archive',
      hint: 'Hides it from the library. Nothing is deleted, and you can restore it.',
      onPress: async () => {
        await db.setArchived(meetingId, true).catch(() => {});
        navigation.goBack();
      },
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
            meeting?.title,
          )} will be permanently deleted. This cannot be undone.`,
          confirmLabel: 'Delete',
          onConfirm: async () => {
            await PipelineController.deleteMeeting(meetingId).catch(() => {});
            navigation.goBack();
          },
        }),
    },
  ];

  // The same three actions the finished meeting offers, in the same stacked form — they are the
  // same controls, and rendering them label-only here made the screen look like a different app.
  const Footer = () => (
    <View style={st.footer}>
      <SoftButton
        icon="users"
        label="Speakers"
        stacked
        onPress={() => navigation.navigate('Speakers', { meetingId })}
      />
      <SoftButton icon="share" label="Export" stacked onPress={onExport} />
      <SoftButton
        icon="refresh"
        label={reprocessing ? 'Working…' : 'Redo'}
        stacked
        onPress={() => onReprocess()}
        disabled={reprocessing}
      />
    </View>
  );

  // ---------- Processing ----------
  if (working) {
    const found = STAGES.findIndex(x => x.key === (stage ?? 'vad'));
    const idx = found < 0 ? 0 : found;
    // A stage reports only that it started, so treat the running one as 40% through.
    const RUNNING = 0.4;
    const doneRate = STAGES.slice(0, idx).reduce((a, x) => a + x.rate, 0);
    const pct = Math.round(((doneRate + STAGES[idx].rate * RUNNING) / TOTAL_RATE) * 100);
    // Remaining work priced from the recording's own length rather than from elapsed time, which
    // is what made a transcript-only re-run promise a finish it was nowhere near.
    const audioSec = (meeting?.durationMs ?? 0) / 1000;
    const remainingRate =
      STAGES.slice(idx).reduce((a, x) => a + x.rate, 0) - STAGES[idx].rate * RUNNING;
    const eta = audioSec > 0 ? Math.max(1, Math.round(remainingRate * audioSec)) : 0;

    return (
      <View style={[st.root, { paddingTop: insets.top + s(8), paddingBottom: insets.bottom + s(20) }]}>
        <View style={st.pad}>
          <View style={st.navRow}>
            <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
            <Txt variant="sectionTitle" style={st.flex}>
              Meeting
            </Txt>
            {/* Reachable mid-run on purpose: a mis-tapped recording is exactly the one you want
                to throw away, and waiting out the pipeline first to be allowed to is absurd.
                deleteMeeting cancels the run before it touches anything. */}
            <IconButton icon="more" label="More actions" onPress={() => setSheet(true)} />
          </View>

          <View style={st.procHead}>
            <ProgressRing pct={pct} size={sv(150)} stroke={s(8)}>
              <Mascot mood="thinking" size={sv(94)} />
            </ProgressRing>
            <Txt variant="display" style={st.procTitle}>
              Writing your notes…
            </Txt>
            <Txt variant="sub" color={colors.inkDim} style={st.procBody}>
              All the thinking happens on your phone, so it takes a moment.
            </Txt>
            <View style={st.pctPill}>
              <Txt variant="metaBlack" color={colors.primary}>
                {pct}%{etaLabel(eta)}
              </Txt>
            </View>
          </View>

          <View style={st.checkWrap}>
            <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={6}>
              <View style={st.checkInner}>
                {STAGES.map((x, i) => {
                  const state = i < idx ? 'done' : i === idx ? 'active' : 'todo';
                  return (
                    <View key={x.key}>
                      {i > 0 && state !== 'active' ? <View style={st.divider} /> : null}
                      <View
                        style={[
                          st.checkRow,
                          state === 'active' && {
                            borderRadius: radius.ctl,
                            overflow: 'hidden',
                          },
                          state === 'todo' && { opacity: 0.45 },
                        ]}>
                        {/* The design tints the active row with a 90deg #F6F7FE -> #fff wash,
                            so it fades out toward the right rather than sitting as a flat block. */}
                        {state === 'active' ? (
                          <GradientFill from="#F6F7FE" to="#FFFFFF" angle={90} />
                        ) : null}
                        {state === 'done' ? (
                          <View style={[st.checkDot, { backgroundColor: colors.successSoft }]}>
                            <Icon name="check" size={s(16)} color={colors.success} strokeWidth={3.2} />
                          </View>
                        ) : state === 'active' ? (
                          <Spinner size={s(30)} color={colors.primary} track="#DDE1F5" />
                        ) : (
                          <View style={[st.checkDot, { backgroundColor: colors.cardAlt }]} />
                        )}
                        <Txt
                          variant={state === 'active' ? 'bodyBlack' : 'bodyStrong'}
                          color={state === 'active' ? colors.primary : state === 'todo' ? colors.inkDim : colors.ink}>
                          {x.label}
                        </Txt>
                      </View>
                    </View>
                  );
                })}
              </View>
            </Raised>
          </View>

          <View style={st.spacer} />
          <Footer />
        </View>
        <Sheet
          visible={sheet}
          title={meeting?.title || 'Meeting'}
          actions={sheetActions}
          onClose={() => setSheet(false)}
        />
      </View>
    );
  }

  // Order is what people reach for, in order: what was this about, then the written minutes, then
  // the record itself, then the worklist. Actions is last because it is the one you go to
  // deliberately — the other three are what you read.
  const TABS = [
    { key: 'summary', label: 'Summary' },
    { key: 'mom', label: 'MOM' },
    { key: 'transcript', label: 'Script' },
    { key: 'actions', label: 'Actions' },
  ];

  return (
    <View style={[st.root, { paddingTop: insets.top + s(6) }]}>
      <View style={st.navRowDetail}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <View style={st.flex}>
          <Txt variant="sectionTitle" numberOfLines={1}>
            {meeting?.title || 'Meeting'}
          </Txt>
          <Txt variant="chipSoft" color={colors.inkFaint}>
            {meeting?.createdAt
              ? new Date(meeting.createdAt).toLocaleString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : ''}
          </Txt>
        </View>
        {meeting?.status === 'done' ? (
          <Badge label="READY" color={colors.success} soft={colors.successSoft} small />
        ) : null}
        <IconButton icon="more" label="More actions" onPress={() => setSheet(true)} />
      </View>

      {failure ? (
        <View style={st.failCard}>
          <Icon name="alert" size={s(18)} color={colors.danger} strokeWidth={2.4} />
          <Txt variant="bodyStrong" color={colors.danger} style={st.flex}>
            {failure}
          </Txt>
        </View>
      ) : null}

      {empty ? (
        <View style={st.emptyWrap}>
          <Mascot mood="asleep" size={sv(130)} />
          <Txt variant="display" style={st.emptyTitle}>
            Nothing to show
          </Txt>
          <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
            Pip could not hear any speech in this recording. If the mic was covered or the room was
            very quiet, try again a little closer.
          </Txt>
        </View>
      ) : (
        <>
          <Segmented items={TABS} value={tab} onChange={setTab} style={st.tabs} />
          {/* Each tab owns its own scroll. Hosting them in one page scroll is what the split was
              for: the transcript can be a virtualised list only if it is the thing scrolling. */}
          <View style={st.flex}>
            {tab === 'summary' ? (
              <SummaryTab
                minutes={minutes}
                speakers={speakers}
                speechMs={speechMs}
                onWrite={() => onReprocess(true)}
                writing={reprocessing}
              />
            ) : tab === 'mom' ? (
              <MinutesTab minutes={minutes} onExport={onExport} />
            ) : tab === 'transcript' ? (
              <TranscriptTab utterances={utterances} speakers={speakers} />
            ) : (
              <ActionsTab meetingId={meetingId} minutes={minutes} />
            )}
          </View>
        </>
      )}

      <Sheet
        visible={sheet}
        title={meeting?.title || 'Meeting'}
        actions={sheetActions}
        onClose={() => setSheet(false)}
      />
    </View>
  );
}

/** The design's active-step ring: a 3px circle with one transparent edge, spinning. */
function Spinner({ size, color, track }: { size: number; color: string; track: string }) {
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 900, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  return (
    <Animated.View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 3,
        borderColor: track,
        borderTopColor: color,
        transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
      }}
    />
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    pad: { flex: 1, paddingHorizontal: s(22) },
    spacer: { flex: 1 },

    navRow: { flexDirection: 'row', alignItems: 'center', gap: s(12) },
    footer: { flexDirection: 'row', gap: s(10) },

    failCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(10),
      backgroundColor: c.dangerSoft,
      borderRadius: radius.xl,
      padding: s(14),
      marginHorizontal: s(16),
      marginTop: s(4),
      marginBottom: s(10),
    },

    tabs: { marginHorizontal: s(16), marginBottom: s(10) },
    navRowDetail: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(12),
      paddingHorizontal: s(20),
    },

    procHead: { alignItems: 'center', marginTop: sv(26) },
    procTitle: { marginTop: s(18), textAlign: 'center' },
    procBody: { marginTop: s(6), textAlign: 'center', maxWidth: s(250) },
    pctPill: {
      marginTop: s(16),
      backgroundColor: c.primarySoft,
      paddingHorizontal: s(14),
      paddingVertical: s(8),
      borderRadius: radius.pill,
    },
    checkWrap: { marginTop: sv(26) },
    checkInner: { padding: s(8) },
    checkRow: { flexDirection: 'row', alignItems: 'center', gap: s(12), padding: s(14) },
    checkDot: { width: s(30), height: s(30), borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
    divider: { height: 1, backgroundColor: c.cardAlt, marginHorizontal: s(14) },



    // The bubble points at its speaker: the corner nearest the avatar is squared off.

    emptyWrap: { alignItems: 'center', paddingTop: sv(60), paddingHorizontal: s(30) },
    emptyTitle: { marginTop: s(18) },
    emptyBody: { textAlign: 'center', marginTop: s(8) },
  });
}
