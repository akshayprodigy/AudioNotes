import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { Button, Card, FadeIn, Txt } from '../components/ui';
import type { Speaker } from '../pipeline/types';
import { font, radius, spacing, useTheme, type Colors } from '../theme';

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
      setTarget(t => t ?? list[0]?.id ?? null);
    });
  }, [meetingId]);

  useEffect(() => {
    load();
  }, [load]);

  const merge = async (dropId: string) => {
    if (!target || target === dropId) return;
    await db.mergeSpeakers(meetingId, target, dropId);
    load();
  };

  const regenerate = async () => {
    setBusy(true);
    try {
      await PipelineController.buildMinutes(meetingId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={s.root}>
      {speakers.length > 0 ? (
        <Txt variant="body" color={colors.inkSoft} style={s.hint}>
          Diarization can split one person across two voices. Pick who to keep, then merge the
          duplicates into them and regenerate.
        </Txt>
      ) : null}

      <FlatList
        data={speakers}
        keyExtractor={x => x.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={speakers.length === 0 ? s.emptyPad : undefined}
        ListEmptyComponent={
          <View style={s.empty}>
            <Mascot mood="asleep" size={120} />
            <Txt variant="heading" style={s.emptyTitle}>
              No speakers yet
            </Txt>
            <Txt variant="body" color={colors.inkSoft} style={s.emptyBody}>
              Speaker labels appear once a meeting has been through diarization.
            </Txt>
          </View>
        }
        renderItem={({ item, index }) => {
          const isTarget = item.id === target;
          const tint = colors.speakers[index % colors.speakers.length];
          const tintSoft = colors.speakersSoft[index % colors.speakersSoft.length];
          return (
            <FadeIn index={index} style={s.rowWrap}>
              <Card
                onPress={() => setTarget(item.id)}
                style={isTarget ? { borderColor: tint } : undefined}>
                <View style={s.row}>
                  <View style={[s.avatar, { backgroundColor: tintSoft }]}>
                    <Icon name="users" size={16} color={tint} />
                  </View>
                  <TextInput
                    style={s.input}
                    defaultValue={item.displayName}
                    placeholder="Name"
                    placeholderTextColor={colors.inkFaint}
                    onEndEditing={e => db.renameSpeaker(item.id, e.nativeEvent.text)}
                  />
                  {isTarget ? (
                    <View style={[s.tag, { backgroundColor: tintSoft }]}>
                      <Icon name="check" size={13} color={tint} />
                      <Txt variant="caption" color={tint}>
                        Keep
                      </Txt>
                    </View>
                  ) : (
                    <Pressable
                      style={s.mergeBtn}
                      onPress={() => merge(item.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Merge ${item.displayName} into the kept speaker`}>
                      <Icon name="merge" size={16} color={colors.inkSoft} />
                    </Pressable>
                  )}
                </View>
              </Card>
            </FadeIn>
          );
        }}
      />

      {speakers.length > 0 ? (
        <Button
          label={busy ? 'Regenerating…' : 'Regenerate minutes'}
          icon="ai"
          onPress={regenerate}
          disabled={busy}
          full
        />
      ) : null}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, padding: spacing.xl, backgroundColor: c.canvas },
    hint: { marginBottom: spacing.lg },
    rowWrap: { marginBottom: spacing.sm },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    avatar: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
    input: {
      flex: 1,
      backgroundColor: c.cardAlt,
      borderRadius: radius.sm,
      color: c.ink,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontFamily: font.medium,
      fontSize: 15,
    },
    tag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      borderRadius: radius.pill,
    },
    mergeBtn: { backgroundColor: c.cardAlt, borderRadius: radius.sm, padding: spacing.sm },
    emptyPad: { flexGrow: 1, justifyContent: 'center' },
    empty: { alignItems: 'center', paddingHorizontal: spacing.lg },
    emptyTitle: { marginTop: spacing.lg },
    emptyBody: { textAlign: 'center', marginTop: spacing.xs },
  });
}
