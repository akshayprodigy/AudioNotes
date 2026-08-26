import React from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Raised, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Speaker, Utterance } from '../../pipeline/types';
import { initials, stamp } from './shared';

/**
 * The raw record, speaker-attributed.
 *
 * A FlatList, not a mapped ScrollView. The old screen rendered every utterance at once inside the
 * one page scroll: 133 rows for an 8.5-minute meeting, and roughly 900 for an hour-long one, all
 * mounted whether or not anyone scrolled to them. Splitting the screen into tabs is what makes
 * this fixable, so it is fixed here rather than left for later.
 */
export default function TranscriptTab({
  utterances,
  speakers,
}: {
  utterances: Utterance[];
  speakers: Speaker[];
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const nameById = React.useMemo(
    () => new Map(speakers.map(x => [x.id, x.displayName])),
    [speakers],
  );
  const indexById = React.useMemo(() => new Map(speakers.map((x, i) => [x.id, i])), [speakers]);

  return (
    <FlatList
      data={utterances}
      keyExtractor={(u, i) => u.id ?? String(i)}
      contentContainerStyle={st.pad}
      showsVerticalScrollIndicator={false}
      initialNumToRender={20}
      windowSize={11}
      removeClippedSubviews
      ListEmptyComponent={
        <Txt variant="body" color={colors.inkSoft} style={st.empty}>
          No transcript for this meeting.
        </Txt>
      }
      renderItem={({ item: u }) => {
        const who = u.speakerId ? nameById.get(u.speakerId) ?? 'Speaker' : 'Unlabelled';
        const idx = u.speakerId ? indexById.get(u.speakerId) ?? 0 : 0;
        const tint = colors.speakers[idx % colors.speakers.length];
        const tintSoft = colors.speakersSoft[idx % colors.speakersSoft.length];
        return (
          <View style={st.row}>
            <View style={[st.avatar, { backgroundColor: tintSoft }]}>
              <Txt variant="chip" color={tint}>
                {initials(who)}
              </Txt>
            </View>
            <Raised edge="#E9ECF5" fill={colors.card} rad={radius.ctl} depth={4} grow>
              <View style={st.card}>
                <Txt variant="chip" color={tint}>
                  {who} · {stamp(u.startMs)}
                </Txt>
                <Txt variant="transcript" style={st.text}>
                  {u.text}
                </Txt>
              </View>
            </Raised>
          </View>
        );
      }}
    />
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(10) },
    empty: { paddingVertical: s(30), textAlign: 'center' },
    row: { flexDirection: 'row', gap: s(10), alignItems: 'flex-start' },
    avatar: {
      width: s(34),
      height: s(34),
      borderRadius: s(17),
      alignItems: 'center',
      justifyContent: 'center',
    },
    card: { padding: s(12), gap: s(4) },
    text: { marginTop: s(2) },
  });
}
