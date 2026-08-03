import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, SectionList, Pressable, StyleSheet, Alert } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import FileExport from '../native/NativeFileExport';
import Icon from '../components/Icon';
import type { Utterance, Minute, Speaker } from '../pipeline/types';
import { useTheme, spacing, radius, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Meeting'>;

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

  const refresh = useCallback(async () => {
    const [mins, utts, segs, spk] = await Promise.all([
      db.minutes(meetingId), db.utterances(meetingId), db.segments(meetingId), db.speakers(meetingId),
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
      }
    };
    load();
    return () => { cancelled = true; };
  }, [refresh]);

  // Re-run the whole pipeline over the stored audio. The common reason is that a model
  // (whisper, diarization, Qwen) was installed AFTER this meeting was recorded, so the
  // first pass stopped early — rather than making the user re-record, re-derive from the
  // PCM we already kept.
  const onReprocess = useCallback(async () => {
    if (reprocessing) return;
    setReprocessing(true);
    try {
      await PipelineController.process(meetingId, { model: 'base', useLLM: true });
      await refresh();
    } catch (e: any) {
      Alert.alert('Could not reprocess', String(e?.message ?? e));
    } finally {
      setReprocessing(false);
    }
  }, [meetingId, refresh, reprocessing]);

  const kindColor = (kind: string): string => {
    if (kind === 'decision') return colors.primary;
    if (kind === 'action') return colors.warning;
    if (kind === 'question') return colors.success;
    return colors.textDim; // summary
  };

  const nameById = new Map(speakers.map(x => [x.id, x.displayName]));
  const sections = [
    { title: 'Minutes', kind: 'minutes' as const, data: minutes },
    {
      title: 'Transcript',
      kind: 'transcript' as const,
      data: utterances.map(u => ({
        who: u.speakerId ? nameById.get(u.speakerId) ?? 'Speaker' : '—',
        text: u.text,
      })),
    },
  ];

  return (
    <View style={s.root}>
      {segCount > 0 && (
        <View style={s.vadPill}>
          <View style={[s.vadDot, { backgroundColor: colors.success }]} />
          <Text style={s.vadText}>
            {segCount} speech segment{segCount === 1 ? '' : 's'} · {(speechMs / 1000).toFixed(1)}s speech
          </Text>
        </View>
      )}
      <View style={s.actions}>
        <Pressable style={s.btn} onPress={() => navigation.navigate('Speakers', { meetingId })}>
          <Icon name="users" size={18} color={colors.text} />
          <Text style={s.btnText}>Speakers</Text>
        </Pressable>
        <Pressable
          style={s.btn}
          onPress={() =>
            Alert.alert('Export minutes', 'Choose a format', [
              { text: 'Markdown', onPress: () => FileExport.share(meetingId, 'md') },
              { text: 'Plain text', onPress: () => FileExport.share(meetingId, 'txt') },
              { text: 'Subtitles (.srt)', onPress: () => FileExport.share(meetingId, 'srt') },
              { text: 'Cancel', style: 'cancel' },
            ])
          }>
          <Icon name="share" size={18} color={colors.text} />
          <Text style={s.btnText}>Export</Text>
        </Pressable>
        <Pressable style={s.btn} onPress={onReprocess} disabled={reprocessing}>
          <Icon name="refresh" size={18} color={reprocessing ? colors.textDim : colors.text} />
          <Text style={[s.btnText, reprocessing && { color: colors.textDim }]}>
            {reprocessing ? 'Working…' : 'Reprocess'}
          </Text>
        </Pressable>
      </View>
      <SectionList
        sections={sections as any}
        keyExtractor={(_, i) => String(i)}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => <Text style={s.section}>{(section as any).title}</Text>}
        renderItem={({ item, section }) => {
          if ((section as any).kind === 'minutes') {
            const m = item as Minute;
            return (
              <View style={s.minuteRow}>
                <View style={[s.kindDot, { backgroundColor: kindColor(m.kind) }]} />
                <Text style={s.minuteText}>{m.content}</Text>
              </View>
            );
          }
          const u = item as { who: string; text: string };
          return (
            <View style={s.uttRow}>
              <Text style={[s.who, { color: colors.primary }]}>{u.who}</Text>
              <Text style={s.uttText}>{u.text}</Text>
            </View>
          );
        }}
      />
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, padding: spacing.md, backgroundColor: c.bg },
    vadPill: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, alignSelf: 'flex-start', backgroundColor: c.successSoft, paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.pill, marginBottom: spacing.sm },
    vadDot: { width: 7, height: 7, borderRadius: 4 },
    vadText: { color: c.success, fontSize: 12, fontWeight: '600' },
    actions: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
    btn: { flex: 1, flexDirection: 'row', gap: spacing.xs, backgroundColor: c.surface, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: c.border },
    btnText: { color: c.text, fontWeight: '700' },
    section: { color: c.textDim, fontWeight: '800', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.6, marginTop: spacing.md, marginBottom: spacing.sm },
    minuteRow: { flexDirection: 'row', gap: spacing.sm, backgroundColor: c.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, borderWidth: 1, borderColor: c.border },
    kindDot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
    minuteText: { flex: 1, color: c.text, fontSize: 14, lineHeight: 20 },
    uttRow: { marginBottom: spacing.sm },
    who: { fontSize: 12, fontWeight: '800', marginBottom: 2 },
    uttText: { color: c.text, fontSize: 14, lineHeight: 20 },
  });
}
