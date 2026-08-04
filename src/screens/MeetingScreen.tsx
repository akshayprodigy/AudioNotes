import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, SectionList, StyleSheet, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import FileExport from '../native/NativeFileExport';
import Icon, { type IconName } from '../components/Icon';
import Mascot from '../components/Mascot';
import { Card, FadeIn, LiveDot, SectionLabel, Txt } from '../components/ui';
import type { Minute, Speaker, Utterance } from '../pipeline/types';
import { radius, spacing, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Meeting'>;

const STAGE_TEXT: Record<string, string> = {
  vad: 'Finding speech…',
  asr: 'Writing the transcript…',
  diarize: 'Working out who spoke…',
};

/**
 * Avatar initials.
 *
 * The obvious "first two letters" gives every auto-named speaker the same "SP", because they are
 * all called "Speaker N" — a column of identical circles that carries no information at all. For
 * the generated names the DIGIT is the only distinguishing part, so use it; once a speaker has
 * been given a real name, fall back to proper initials.
 */
function initials(name: string): string {
  const generated = name.match(/^Speaker\s*(\d+)$/i);
  if (generated) return generated[1];
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}

/** Minute kinds carry meaning; give each a colour and a word rather than an unlabelled dot. */
function kindMeta(kind: string, c: Colors): { label: string; color: string; soft: string; icon: IconName } {
  switch (kind) {
    case 'action':
      return { label: 'Action', color: c.warning, soft: c.warningSoft, icon: 'check' };
    case 'decision':
      return { label: 'Decision', color: c.primary, soft: c.primarySoft, icon: 'check' };
    case 'question':
      return { label: 'Open question', color: c.success, soft: c.successSoft, icon: 'alert' };
    default:
      return { label: 'Summary', color: c.inkSoft, soft: c.cardAlt, icon: 'list' };
  }
}

export default function MeetingScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { meetingId } = route.params;
  const [minutes, setMinutes] = useState<Minute[]>([]);
  const [utterances, setUtterances] = useState<Utterance[]>([]);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [speechMs, setSpeechMs] = useState(0);
  const [segCount, setSegCount] = useState(0);
  const [reprocessing, setReprocessing] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);

  const refresh = useCallback(async () => {
    const [mins, utts, segs, spk] = await Promise.all([
      db.minutes(meetingId),
      db.utterances(meetingId),
      db.segments(meetingId),
      db.speakers(meetingId),
    ]);
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
      } else {
        setSettled(true);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Live stage progress, and the terminal event. Polling alone could not distinguish "still
  // working" from "failed and will never produce anything", which left the screen blank forever.
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

  // Re-run the whole pipeline over the stored audio. The common reason is that a model
  // (whisper, diarization, Qwen) was installed AFTER this meeting was recorded, so the first
  // pass stopped early — rather than making the user re-record, re-derive from the PCM we kept.
  const onReprocess = useCallback(async () => {
    if (reprocessing) return;
    setReprocessing(true);
    setFailure(null);
    try {
      await PipelineController.process(meetingId, { model: 'base', useLLM: true });
      await refresh();
    } catch (e: any) {
      Alert.alert('Could not reprocess', String(e?.message ?? e));
    } finally {
      setReprocessing(false);
    }
  }, [meetingId, refresh, reprocessing]);

  const nameById = new Map(speakers.map(x => [x.id, x.displayName]));
  const speakerIndex = new Map(speakers.map((x, i) => [x.id, i]));

  const sections = [
    { title: 'Minutes', kind: 'minutes' as const, data: minutes },
    {
      title: 'Transcript',
      kind: 'transcript' as const,
      data: utterances.map(u => ({
        who: u.speakerId ? nameById.get(u.speakerId) ?? 'Speaker' : 'Unlabelled',
        idx: u.speakerId ? speakerIndex.get(u.speakerId) ?? 0 : 0,
        text: u.text,
      })),
    },
  ];

  const working = stage !== null || (!settled && minutes.length === 0);
  const empty = settled && minutes.length === 0 && utterances.length === 0;

  const Action = ({
    icon,
    label,
    onPress,
    disabled,
  }: {
    icon: IconName;
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[s.action, disabled && { opacity: 0.45 }]}>
      <Icon name={icon} size={18} color={colors.ink} />
      <Txt variant="caption">{label}</Txt>
    </Pressable>
  );

  return (
    <View style={s.root}>
      <View style={s.head}>
        {working ? (
          <View style={s.workingRow}>
            <Mascot mood="thinking" size={54} />
            <View style={s.rowFill}>
              <Txt variant="heading">{STAGE_TEXT[stage ?? ''] ?? 'Getting started…'}</Txt>
              <Txt variant="caption" color={colors.inkSoft}>
                This runs entirely on your phone, so it takes a moment.
              </Txt>
            </View>
            <LiveDot color={colors.primary} />
          </View>
        ) : segCount > 0 ? (
          <View style={s.statsRow}>
            <View style={[s.stat, { backgroundColor: colors.successSoft }]}>
              <Txt variant="heading" color={colors.success}>
                {segCount}
              </Txt>
              <Txt variant="caption" color={colors.success}>
                segments
              </Txt>
            </View>
            <View style={[s.stat, { backgroundColor: colors.primarySoft }]}>
              <Txt variant="heading" color={colors.primary}>
                {(speechMs / 1000).toFixed(0)}s
              </Txt>
              <Txt variant="caption" color={colors.primary}>
                of speech
              </Txt>
            </View>
            <View style={[s.stat, { backgroundColor: colors.warningSoft }]}>
              <Txt variant="heading" color={colors.warning}>
                {speakers.length || '—'}
              </Txt>
              <Txt variant="caption" color={colors.warning}>
                {speakers.length === 1 ? 'speaker' : 'speakers'}
              </Txt>
            </View>
          </View>
        ) : null}

        {failure ? (
          <Card style={s.failCard}>
            <View style={s.failRow}>
              <Icon name="alert" size={18} color={colors.danger} />
              <Txt variant="bodyStrong" color={colors.danger} style={s.rowFill}>
                {failure}
              </Txt>
            </View>
          </Card>
        ) : null}

        <View style={s.actions}>
          <Action
            icon="users"
            label="Speakers"
            onPress={() => navigation.navigate('Speakers', { meetingId })}
          />
          <Action
            icon="share"
            label="Export"
            onPress={() =>
              Alert.alert('Export minutes', 'Choose a format', [
                { text: 'Markdown', onPress: () => FileExport.share(meetingId, 'md') },
                { text: 'Plain text', onPress: () => FileExport.share(meetingId, 'txt') },
                { text: 'Subtitles (.srt)', onPress: () => FileExport.share(meetingId, 'srt') },
                { text: 'Cancel', style: 'cancel' },
              ])
            }
          />
          <Action
            icon="refresh"
            label={reprocessing ? 'Working…' : 'Redo'}
            onPress={onReprocess}
            disabled={reprocessing}
          />
        </View>
      </View>

      {empty ? (
        <View style={s.emptyWrap}>
          <Mascot mood="asleep" size={130} />
          <Txt variant="title" style={s.emptyTitle}>
            Nothing to show
          </Txt>
          <Txt variant="body" color={colors.inkSoft} style={s.emptyBody}>
            Pip could not hear any speech in this recording. If the mic was covered or the room was
            very quiet, try recording again a little closer.
          </Txt>
        </View>
      ) : (
        <SectionList
          sections={sections as any}
          keyExtractor={(_, i) => String(i)}
          stickySectionHeadersEnabled={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={s.listPad}
          renderSectionHeader={({ section }) =>
            (section as any).data.length ? (
              <View style={s.sectionHead}>
                <SectionLabel>{(section as any).title}</SectionLabel>
              </View>
            ) : null
          }
          renderItem={({ item, section, index }) => {
            if ((section as any).kind === 'minutes') {
              const m = item as Minute;
              const meta = kindMeta(m.kind, colors);
              return (
                <FadeIn index={index} style={s.itemWrap}>
                  <Card accent={meta.color}>
                    <View style={[s.kindTag, { backgroundColor: meta.soft }]}>
                      <Txt variant="caption" color={meta.color}>
                        {meta.label}
                      </Txt>
                    </View>
                    <Txt variant="body" style={s.minuteText}>
                      {m.content}
                    </Txt>
                  </Card>
                </FadeIn>
              );
            }
            const u = item as { who: string; idx: number; text: string };
            const tint = colors.speakers[u.idx % colors.speakers.length];
            const tintSoft = colors.speakersSoft[u.idx % colors.speakersSoft.length];
            return (
              <View style={s.uttRow}>
                <View style={[s.avatar, { backgroundColor: tintSoft }]}>
                  <Txt variant="caption" color={tint}>
                    {initials(u.who)}
                  </Txt>
                </View>
                <View style={s.rowFill}>
                  <Txt variant="label" color={tint}>
                    {u.who}
                  </Txt>
                  <Txt variant="body" color={colors.ink} style={s.uttText}>
                    {u.text}
                  </Txt>
                </View>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    // The header is pinned so Export/Redo stay reachable while reading a long transcript, which
    // means the list scrolls underneath it. An opaque background plus a hairline is what makes
    // that read as "content passing behind a bar" rather than "text mysteriously cut off".
    head: {
      paddingHorizontal: spacing.xl,
      paddingTop: spacing.md,
      paddingBottom: spacing.md,
      gap: spacing.md,
      backgroundColor: c.canvas,
      borderBottomWidth: 1,
      borderBottomColor: c.line,
      zIndex: 1,
    },
    rowFill: { flex: 1 },
    workingRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: c.card,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.line,
      padding: spacing.md,
    },
    statsRow: { flexDirection: 'row', gap: spacing.sm },
    stat: {
      flex: 1,
      borderRadius: radius.md,
      paddingVertical: spacing.md,
      alignItems: 'center',
    },
    failCard: { borderColor: c.danger },
    failRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    actions: { flexDirection: 'row', gap: spacing.sm },
    action: {
      flex: 1,
      alignItems: 'center',
      gap: 4,
      backgroundColor: c.card,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.line,
      paddingVertical: spacing.md,
    },
    listPad: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
    sectionHead: { marginTop: spacing.xl },
    itemWrap: { marginBottom: spacing.sm },
    kindTag: {
      alignSelf: 'flex-start',
      paddingHorizontal: spacing.sm,
      paddingVertical: 3,
      borderRadius: radius.sm,
    },
    minuteText: { marginTop: spacing.sm },
    uttRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
    avatar: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
    uttText: { marginTop: 1 },
    emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
    emptyTitle: { marginTop: spacing.lg },
    emptyBody: { textAlign: 'center', marginTop: spacing.sm },
  });
}
