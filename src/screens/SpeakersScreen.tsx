import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, FlatList, Pressable, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import Icon from '../components/Icon';
import type { Speaker } from '../pipeline/types';
import { useTheme, spacing, radius, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Speakers'>;

export default function SpeakersScreen({ route }: Props) {
  const { colors } = useTheme();
  const s = useMemo(() => makeStyles(colors), [colors]);
  const { meetingId } = route.params;
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    db.speakers(meetingId).then(list => {
      setSpeakers(list);
      setTarget(t => t ?? (list[0]?.id ?? null));
    });
  }, [meetingId]);

  useEffect(() => { load(); }, [load]);

  const merge = async (dropId: string) => {
    if (!target || target === dropId) return;
    await db.mergeSpeakers(meetingId, target, dropId);
    load();
  };

  const regenerate = async () => {
    setBusy(true);
    try { await PipelineController.buildMinutes(meetingId); } finally { setBusy(false); }
  };

  return (
    <View style={s.root}>
      <Text style={s.hint}>
        Tap a speaker to make it the merge target. Rename inline. Merge others into the target, then
        regenerate minutes to update owners.
      </Text>
      <FlatList
        data={speakers}
        keyExtractor={x => x.id}
        renderItem={({ item }) => {
          const isTarget = item.id === target;
          return (
            <Pressable style={[s.row, isTarget && s.rowTarget]} onPress={() => setTarget(item.id)}>
              <View style={[s.avatar, { backgroundColor: isTarget ? colors.primary : colors.surfaceAlt }]}>
                <Icon name="users" size={16} color={isTarget ? colors.onPrimary : colors.textDim} />
              </View>
              <TextInput
                style={s.input}
                defaultValue={item.displayName}
                placeholder="Name"
                placeholderTextColor={colors.textFaint}
                onEndEditing={e => db.renameSpeaker(item.id, e.nativeEvent.text)}
              />
              {isTarget ? (
                <View style={s.targetTag}>
                  <Icon name="check" size={14} color={colors.primary} />
                  <Text style={s.targetText}>target</Text>
                </View>
              ) : (
                <Pressable style={s.mergeBtn} onPress={() => merge(item.id)}>
                  <Icon name="merge" size={16} color={colors.text} />
                </Pressable>
              )}
            </Pressable>
          );
        }}
        ListEmptyComponent={<Text style={s.hint}>No speakers yet — run diarization first.</Text>}
      />
      <Pressable style={[s.regen, busy && { backgroundColor: colors.surfaceAlt }]} onPress={regenerate} disabled={busy}>
        <Icon name="ai" size={18} color={busy ? colors.textDim : colors.onPrimary} />
        <Text style={[s.regenText, busy && { color: colors.textDim }]}>{busy ? 'Regenerating…' : 'Regenerate minutes'}</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, padding: spacing.md, backgroundColor: c.bg },
    hint: { color: c.textDim, fontSize: 13, marginBottom: spacing.md, lineHeight: 19 },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm, backgroundColor: c.surface, borderRadius: radius.md, padding: spacing.sm, borderWidth: 1, borderColor: c.border },
    rowTarget: { borderColor: c.primary },
    avatar: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
    input: { flex: 1, backgroundColor: c.surfaceAlt, borderRadius: radius.sm, color: c.text, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
    mergeBtn: { backgroundColor: c.surfaceAlt, borderRadius: radius.sm, padding: spacing.sm },
    targetTag: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: spacing.sm },
    targetText: { color: c.primary, fontSize: 12, fontWeight: '700' },
    regen: { flexDirection: 'row', gap: spacing.sm, backgroundColor: c.primary, borderRadius: radius.md, padding: spacing.md, alignItems: 'center', justifyContent: 'center', marginTop: spacing.sm },
    regenText: { color: c.onPrimary, fontWeight: '800' },
  });
}
