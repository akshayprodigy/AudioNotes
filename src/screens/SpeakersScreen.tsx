import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { PipelineController } from '../pipeline/PipelineController';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { Button, IconButton, Pop, Raised, SoftButton, Txt } from '../components/ui';
import type { Speaker } from '../pipeline/types';
import { font, radius, s, sv, tilt, useTheme, type Colors } from '../theme';
import { entitlement } from '../billing/trial';

type Props = NativeStackScreenProps<RootStackParamList, 'Speakers'>;

export default function SpeakersScreen({ route, navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { meetingId } = route.params;
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [paid, setPaid] = useState(false);
  useEffect(() => {
    let alive = true;
    entitlement().then(e => { if (alive) setPaid(e.paid); }).catch(() => {});
    return () => { alive = false };
  }, []);

  const DEFAULT_NAME = /^Speaker \d+$/;

  /**
   * The one-time card (brief §2.7): paid, a real name, the setting never set, never asked before.
   * Resolves once the person has answered; "Turn on" also remembers this speaker straight away.
   */
  const maybeOfferToRemember = async (speakerId: string, name: string) => {
    if (!paid) return;
    const [remember, prompted] = await Promise.all([
      db.getSetting('voices_remember'),
      db.getSetting('voices_prompted'),
    ]);
    if (remember !== null || prompted === '1') return;
    Alert.alert(
      'Remember this voice?',
      'Verbale can keep a voiceprint of each speaker you name — on this phone only, never uploaded — and suggest the name from your next meeting. Voiceprints are personal, sometimes biometric, data: tell the people you record where the law requires it. You can forget all voices any time in Settings.',
      [
        { text: 'Not now', style: 'cancel', onPress: () => { db.setSetting('voices_prompted', '1').catch(() => {}); } },
        {
          text: 'Turn on',
          onPress: async () => {
            await db.setSetting('voices_remember', '1');
            await db.setSetting('voices_prompted', '1');
            await db.rememberVoice(speakerId, name).catch(() => {});
          },
        },
      ],
    );
  };

  const rename = async (speakerId: string, name: string) => {
    await db.renameSpeaker(speakerId, name);
    const clean = name.trim();
    if (clean === '' || DEFAULT_NAME.test(clean)) return;
    await db.rememberVoice(speakerId, clean).catch(() => {});
    await maybeOfferToRemember(speakerId, clean);
  };

  const answer = async (speakerId: string, accept: boolean) => {
    await db.answerSuggestion(speakerId, accept);
    load();
  };

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
                <View>
                  <View style={st.row}>
                    <View style={[st.avatar, { backgroundColor: tintSoft }]}>
                      <Icon name="users" size={s(16)} color={tint} strokeWidth={2.4} />
                    </View>
                    <TextInput
                      style={st.input}
                      defaultValue={item.displayName}
                      placeholder="Name"
                      placeholderTextColor={colors.inkFaint}
                      onEndEditing={e => rename(item.id, e.nativeEvent.text)}
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
                  {item.suggestedName ? (
                    <View style={st.suggest}>
                      <Txt variant="chip" color={colors.inkSoft} style={st.flex}>
                        Sounds like {item.suggestedName}?
                      </Txt>
                      <View accessibilityLabel={`Yes, this is ${item.suggestedName}`} style={st.noShrink}>
                        <SoftButton
                          icon="check"
                          label="Yes"
                          onPress={() => answer(item.id, true)}
                        />
                      </View>
                      <View accessibilityLabel={`No, not ${item.suggestedName}`} style={st.noShrink}>
                        <SoftButton
                          icon="x"
                          label="No"
                          onPress={() => answer(item.id, false)}
                        />
                      </View>
                    </View>
                  ) : null}
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
    suggest: { flexDirection: 'row', alignItems: 'center', gap: s(8), paddingHorizontal: s(14), paddingBottom: s(12) },
    flex: { flex: 1, flexShrink: 1 },
    noShrink: { flexShrink: 0 },
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
