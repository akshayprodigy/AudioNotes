import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Easing, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import FileExport from '../native/NativeFileExport';
import Icon, { type IconName } from '../components/Icon';
import Mascot from '../components/Mascot';
import { confirmDestructive, quoted } from '../components/confirm';
import {
  Badge,
  IconButton,
  Pop,
  ProgressRing,
  GradientFill,
  Raised,
  SectionRule,
  Sheet,
  Slide,
  SoftButton,
  Txt,
  type SheetAction,
} from '../components/ui';
import type { Meeting, Minute, Speaker, Utterance } from '../pipeline/types';
import { radius, s, sv, text, tilt, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Meeting'>;

/**
 * Pipeline stages, phrased as what they achieve, with weights measured on device (the `stage=`
 * timings logged by AudioPipelineModule). The weights drive both the ring and the ETA, so
 * progress advances at a roughly even rate rather than sitting at 5% then jumping to done.
 */
const STAGES: { key: string; label: string; weight: number }[] = [
  { key: 'vad', label: 'Audio cleaned up', weight: 0.03 },
  { key: 'asr', label: 'Words written down', weight: 0.62 },
  { key: 'diarize', label: 'Speakers separated', weight: 0.28 },
  { key: 'minutes', label: 'Pulling out the minutes', weight: 0.07 },
];

function kindMeta(kind: string, c: Colors): { label: string; color: string; soft: string; icon: IconName } {
  switch (kind) {
    case 'action':
      return { label: 'ACTION', color: c.warning, soft: c.warningSoft, icon: 'check' };
    case 'decision':
      return { label: 'DECISION', color: c.primary, soft: c.primarySoft, icon: 'check' };
    case 'question':
      return { label: 'OPEN QUESTION', color: c.success, soft: c.successSoft, icon: 'help' };
    default:
      return { label: 'NOTE', color: c.inkSoft, soft: c.cardAlt, icon: 'list' };
  }
}

/**
 * Avatar initials. "First two letters" gives every auto-named speaker "SP" — a column of
 * identical circles carrying no information — because they are all "Speaker N". For generated
 * names the digit is the distinguishing part; a renamed speaker gets proper initials.
 */
function initials(name: string): string {
  const gen = name.match(/^Speaker\s*(\d+)$/i);
  if (gen) return `S${gen[1]}`;
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[w.length - 1][0]).toUpperCase();
}

const stamp = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

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
  const [segCount, setSegCount] = useState(0);
  const [reprocessing, setReprocessing] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [sheet, setSheet] = useState(false);
  const startedAt = useRef(Date.now());

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
    setSegCount(segs.length);
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

  const onReprocess = useCallback(async () => {
    if (reprocessing) return;
    setReprocessing(true);
    setFailure(null);
    startedAt.current = Date.now();
    try {
      await PipelineController.process(meetingId, { model: 'base', useLLM: true });
      await refresh();
    } catch (e: any) {
      Alert.alert('Could not reprocess', String(e?.message ?? e));
    } finally {
      setReprocessing(false);
    }
  }, [meetingId, refresh, reprocessing]);

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
   * Overflow actions. Both leave this screen, so both pop back to the library first — a detail
   * screen for a meeting that has just been archived out of the library, or deleted outright, has
   * nothing left to show and its polling refresh would query a row that no longer exists.
   */
  const sheetActions: SheetAction[] = [
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
        onPress={onReprocess}
        disabled={reprocessing}
      />
    </View>
  );

  // ---------- Processing ----------
  if (working) {
    const found = STAGES.findIndex(x => x.key === (stage ?? 'vad'));
    const idx = found < 0 ? 0 : found;
    const pct = Math.round(
      STAGES.slice(0, idx).reduce((a, x) => a + x.weight, 0) * 100 + STAGES[idx].weight * 40,
    );
    const elapsed = Date.now() - startedAt.current;
    const eta = pct > 8 ? Math.max(1, Math.round(((elapsed / pct) * (100 - pct)) / 1000)) : 0;

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
                {pct}%{eta > 0 ? ` · about ${eta}s left` : ''}
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

  const nameById = new Map(speakers.map(x => [x.id, x.displayName]));
  const speakerIndex = new Map(speakers.map((x, i) => [x.id, i]));
  const summary = minutes.find(m => m.kind === 'summary');
  const items = minutes.filter(m => m.kind !== 'summary');
  const actions = minutes.filter(m => m.kind === 'action').length;
  const questions = minutes.filter(m => m.kind === 'question').length;

  return (
    <View style={st.root}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: insets.top + s(6), paddingBottom: insets.bottom + s(30) }}>
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

        {/* Stats: uneven flex (1.2 / 1.5 / 1) and alternating tilt, as the design has them. */}
        <View style={st.statRow}>
          <Pop index={0} style={{ flex: 1.2 }}>
            <Raised
              edge={colors.successEdge}
              gradient={{ from: colors.successSoft, to: colors.successSoft2, angle: 160 }}
              rad={radius.xl}
              depth={5}
              rotate="-1.2deg">
              <View style={st.stat}>
                <Txt variant="statNum" color={colors.successDeep}>
                  {segCount}
                </Txt>
                <Txt variant="chipSoft" color={colors.success}>
                  {segCount === 1 ? 'segment' : 'segments'}
                </Txt>
              </View>
            </Raised>
          </Pop>
          <Pop index={1} style={{ flex: 1.5 }}>
            <Raised
              edge={colors.primarySoftEdge}
              gradient={{ from: colors.primarySoft, to: colors.primarySoft2, angle: 160 }}
              rad={radius.xl}
              depth={5}
              rotate="0.9deg">
              <View style={st.stat}>
                <Txt variant="statNum" color={colors.primaryEdge}>
                  {Math.round(speechMs / 1000)}s
                </Txt>
                <Txt variant="chipSoft" color={colors.primary}>
                  of speech
                </Txt>
              </View>
            </Raised>
          </Pop>
          <Pop index={2} style={{ flex: 1 }}>
            <Raised
              edge={colors.warningEdge}
              gradient={{ from: colors.warningSoft, to: colors.warningSoft2, angle: 160 }}
              rad={radius.xl}
              depth={5}
              rotate="-0.7deg">
              <View style={st.stat}>
                <Txt variant="statNum" color={colors.warningDeep}>
                  {speakers.length || '—'}
                </Txt>
                <Txt variant="chipSoft" color={colors.warning}>
                  {speakers.length === 1 ? 'speaker' : 'speakers'}
                </Txt>
              </View>
            </Raised>
          </Pop>
        </View>

        <View style={st.actionRow}>
          <SoftButton icon="users" label="Speakers" stacked onPress={() => navigation.navigate('Speakers', { meetingId })} />
          <SoftButton icon="share" label="Export" stacked onPress={onExport} />
          <SoftButton icon="refresh" label={reprocessing ? 'Working…' : 'Redo'} stacked onPress={onReprocess} disabled={reprocessing} />
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
              Pip could not hear any speech in this recording. If the mic was covered or the room
              was very quiet, try again a little closer.
            </Txt>
          </View>
        ) : (
          <>
            <View style={st.ruleWrap}>
              <SectionRule label="MINUTES" />
            </View>

            <View style={st.list}>
              <Slide>
                <Raised
                  edge={colors.primaryEdge}
                  gradient={{ from: colors.primary, to: colors.primaryLight, angle: 135 }}
                  rad={radius.card24}
                  depth={6}>
                  <View style={st.gist}>
                    <Txt variant="overlineSm" color={colors.onPrimary} style={st.gistLabel}>
                      THE GIST
                    </Txt>
                    <Txt variant="gist" color={colors.onPrimary} style={st.gistText}>
                      {summary?.content ?? 'No summary yet.'}
                    </Txt>
                    <View style={st.gistChips}>
                      <View style={st.gistChip}>
                        <Txt variant="chip" color={colors.onPrimary}>
                          {actions} {actions === 1 ? 'action' : 'actions'}
                        </Txt>
                      </View>
                      <View style={st.gistChip}>
                        <Txt variant="chip" color={colors.onPrimary}>
                          {questions} {questions === 1 ? 'question' : 'questions'}
                        </Txt>
                      </View>
                    </View>
                  </View>
                </Raised>
              </Slide>

              {items.map((m, i) => {
                const meta = kindMeta(m.kind, colors);
                return (
                  <Slide key={m.id ?? i} index={i + 1}>
                    <View style={st.minuteRow}>
                      <View style={[st.minuteIcon, { backgroundColor: meta.soft }]}>
                        <Icon name={meta.icon} size={s(19)} color={meta.color} strokeWidth={2.8} />
                      </View>
                      <View style={st.flex}>
                        <Raised
                          edge={colors.line}
                          fill={colors.card}
                          rad={radius.xl}
                          depth={5}
                          rotate={tilt(i)}>
                          <View style={st.minuteCard}>
                            <Badge label={meta.label} color={meta.color} soft={meta.soft} small />
                            <Txt variant="minuteBody" style={st.minuteText}>
                              {m.content}
                            </Txt>
                          </View>
                        </Raised>
                      </View>
                    </View>
                  </Slide>
                );
              })}
            </View>

            {utterances.length > 0 ? (
              <>
                <View style={st.ruleWrap}>
                  <SectionRule label="TRANSCRIPT" />
                </View>
                <View style={st.list}>
                  {utterances.map((u, i) => {
                    const who = u.speakerId ? nameById.get(u.speakerId) ?? 'Speaker' : 'Unlabelled';
                    const idx = u.speakerId ? speakerIndex.get(u.speakerId) ?? 0 : 0;
                    const tint = colors.speakers[idx % colors.speakers.length];
                    const tintSoft = colors.speakersSoft[idx % colors.speakersSoft.length];
                    return (
                      <View key={u.id ?? i} style={st.uttRow}>
                        <View style={[st.uttAvatar, { backgroundColor: tintSoft }]}>
                          <Txt variant="chip" color={tint}>
                            {initials(who)}
                          </Txt>
                        </View>
                        <Raised
                          edge="#E9ECF5"
                          fill={colors.card}
                          rad={radius.ctl}
                          depth={4}
                          grow
                          style={st.bubbleShape}>
                          <View style={st.uttCard}>
                            <Txt variant="chip" color={tint}>
                              {who} · {stamp(u.startMs)}
                            </Txt>
                            <Txt variant="transcript" style={st.uttText}>
                              {u.text}
                            </Txt>
                          </View>
                        </Raised>
                      </View>
                    );
                  })}
                </View>
              </>
            ) : null}
          </>
        )}
      </ScrollView>

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

    statRow: { flexDirection: 'row', gap: s(10), paddingHorizontal: s(20), paddingTop: s(18) },
    stat: { padding: s(14) },
    actionRow: { flexDirection: 'row', gap: s(10), paddingHorizontal: s(20), paddingTop: s(14) },
    footer: { flexDirection: 'row', gap: s(10) },

    failCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(10),
      backgroundColor: c.dangerSoft,
      borderRadius: radius.xl,
      padding: s(14),
      marginHorizontal: s(20),
      marginTop: s(14),
    },

    ruleWrap: { marginHorizontal: s(20), marginTop: s(22), marginBottom: s(10) },
    list: { paddingHorizontal: s(20), gap: s(12) },

    gist: { padding: s(18) },
    gistLabel: { opacity: 0.8 },
    gistText: { marginTop: s(8) },
    gistChips: { flexDirection: 'row', gap: s(8), marginTop: s(14) },
    gistChip: {
      backgroundColor: 'rgba(255,255,255,0.2)',
      paddingHorizontal: s(11),
      paddingVertical: s(6),
      borderRadius: radius.pill,
    },

    minuteRow: { flexDirection: 'row', gap: s(12), alignItems: 'flex-start' },
    minuteIcon: {
      width: s(38),
      height: s(38),
      borderRadius: s(14),
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: s(6),
    },
    minuteCard: { paddingVertical: s(15), paddingHorizontal: s(16) },
    minuteText: { marginTop: s(9) },

    uttRow: { flexDirection: 'row', gap: s(11), alignItems: 'flex-start' },
    uttAvatar: {
      width: s(36),
      height: s(36),
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // The bubble points at its speaker: the corner nearest the avatar is squared off.
    bubbleShape: { borderTopLeftRadius: s(6) },
    uttCard: { padding: s(13), paddingHorizontal: s(15) },
    uttText: { marginTop: s(4) },

    emptyWrap: { alignItems: 'center', paddingTop: sv(60), paddingHorizontal: s(30) },
    emptyTitle: { marginTop: s(18) },
    emptyBody: { textAlign: 'center', marginTop: s(8) },
  });
}
