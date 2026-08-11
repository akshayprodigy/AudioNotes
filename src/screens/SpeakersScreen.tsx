import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { Button, IconButton, Pop, Raised, Txt } from '../components/ui';
import type { Speaker } from '../pipeline/types';
import { font, radius, s, sv, tilt, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Speakers'>;

export default function SpeakersScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
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
      await PipelineController.regenerateMinutes(meetingId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <Txt variant="sectionTitle">Speakers</Txt>
      </View>

      <FlatList
        data={speakers}
        keyExtractor={x => x.id}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          st.listPad,
          { paddingBottom: insets.bottom + s(20) },
          speakers.length === 0 && st.emptyPad,
        ]}
        ListHeaderComponent={
          speakers.length > 0 ? (
            <Txt variant="body" color={colors.inkSoft} style={st.hint}>
              Diarization can split one person across two voices. Pick who to keep, then merge the
              duplicates into them and regenerate.
            </Txt>
          ) : null
        }
        ListEmptyComponent={
          <View style={st.empty}>
            <Mascot mood="asleep" size={sv(120)} />
            <Txt variant="display" style={st.emptyTitle}>
              No speakers yet
            </Txt>
            <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
              Speaker labels appear once a meeting has been through diarization.
            </Txt>
          </View>
        }
        renderItem={({ item, index }) => {
          const isTarget = item.id === target;
          const tint = colors.speakers[index % colors.speakers.length];
          const tintSoft = colors.speakersSoft[index % colors.speakersSoft.length];
          return (
            <Pop index={index} style={st.rowWrap}>
              <Raised
                edge={isTarget ? tint : colors.line}
                fill={colors.card}
                rad={radius.xl}
                depth={5}
                rotate={tilt(index)}
                onPress={() => setTarget(item.id)}>
                <View style={st.row}>
                  <View style={[st.avatar, { backgroundColor: tintSoft }]}>
                    <Icon name="users" size={s(16)} color={tint} strokeWidth={2.4} />
                  </View>
                  <TextInput
                    style={st.input}
                    defaultValue={item.displayName}
                    placeholder="Name"
                    placeholderTextColor={colors.inkFaint}
                    onEndEditing={e => db.renameSpeaker(item.id, e.nativeEvent.text)}
                  />
                  {isTarget ? (
                    <View style={[st.tag, { backgroundColor: tintSoft }]}>
                      <Icon name="check" size={s(13)} color={tint} strokeWidth={3} />
                      <Txt variant="chip" color={tint}>
                        Keep
                      </Txt>
                    </View>
                  ) : (
                    <Pressable
                      style={st.mergeBtn}
                      onPress={() => merge(item.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Merge ${item.displayName} into the kept speaker`}>
                      <Icon name="merge" size={s(16)} color={colors.inkSoft} strokeWidth={2.4} />
                    </Pressable>
                  )}
                </View>
              </Raised>
            </Pop>
          );
        }}
      />

      {speakers.length > 0 ? (
        <View style={[st.cta, { paddingBottom: Math.max(insets.bottom, s(10)) + s(6) }]}>
          <Button
            label={busy ? 'Regenerating…' : 'Regenerate minutes'}
            icon="ai"
            onPress={regenerate}
            disabled={busy}
            full
          />
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20) },
    listPad: { paddingHorizontal: s(20), paddingTop: s(16) },
    emptyPad: { flexGrow: 1, justifyContent: 'center' },
    hint: { marginBottom: s(16) },
    rowWrap: { marginBottom: s(10) },
    row: { flexDirection: 'row', alignItems: 'center', gap: s(12), padding: s(14) },
    avatar: {
      width: s(36),
      height: s(36),
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    input: {
      flex: 1,
      backgroundColor: c.cardAlt,
      borderRadius: radius.sm,
      color: c.ink,
      paddingHorizontal: s(12),
      paddingVertical: s(8),
      fontFamily: font.bold,
      fontSize: s(15),
    },
    tag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(4),
      paddingHorizontal: s(10),
      paddingVertical: s(6),
      borderRadius: radius.pill,
    },
    mergeBtn: { backgroundColor: c.cardAlt, borderRadius: radius.sm, padding: s(9) },
    cta: { paddingHorizontal: s(20), paddingTop: s(8) },
    empty: { alignItems: 'center', paddingHorizontal: s(20) },
    emptyTitle: { marginTop: s(18) },
    emptyBody: { textAlign: 'center', marginTop: s(6) },
  });
}
