import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import type { ThreadDecision, ThreadOpenItem, ThreadResult } from '../pipeline/types';
import { dayLabel } from '../pipeline/dateNorm';
import { labelsFor } from './meeting/recordLabels';
import { RecordChips, SectionHead, sentenceCase, splitAction } from './meeting/shared';
import { IconButton, Txt } from '../components/ui';
import { s, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Thread'>;
type Loaded = Extract<ThreadResult, { tag: string }>;

/**
 * A thread: the meetings sharing one tag (Phase 3) — what is still open across them, the
 * decisions in order with "changes: …" links, and the meetings. Pro only; a `NOT_PRO` refusal
 * (native decides, before any table is touched) sends this straight to the paywall, the way
 * AskScreen's own refusal does.
 */
export default function ThreadScreen({ route, navigation }: Props) {
  const { tag } = route.params;
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<Loaded | null>(null);

  useEffect(() => {
    let alive = true;
    db.thread(tag)
      .then(r => {
        if (!alive) return;
        if ('refusal' in r) {
          navigation.navigate('Paywall');
          return;
        }
        setResult(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [tag, navigation]);

  const openMeeting = (meetingId: string) => navigation.navigate('Meeting', { meetingId });

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <View style={st.flex}>
          <Txt variant="sectionTitle">{tag}</Txt>
          {result ? (
            <Txt variant="chipSoft" color={colors.inkFaint}>
              {result.meetings.length} meeting{result.meetings.length === 1 ? '' : 's'}
            </Txt>
          ) : null}
        </View>
      </View>

      {result ? (
        <ScrollView
          contentContainerStyle={[st.pad, { paddingBottom: insets.bottom + s(28) }]}
          showsVerticalScrollIndicator={false}>
          <SectionHead label="STILL OPEN" colors={colors} />
          {result.open.length === 0 ? (
            <Txt variant="body" color={colors.inkSoft} style={st.emptyLine}>
              Nothing open in this thread.
            </Txt>
          ) : (
            result.open.map(item => (
              <OpenRow key={item.itemId} item={item} colors={colors} onPress={() => openMeeting(item.meetingId)} />
            ))
          )}

          <SectionHead label="DECISIONS SO FAR" style={st.sectionGap} colors={colors} />
          {result.decisions.length === 0 ? (
            <Txt variant="body" color={colors.inkSoft} style={st.emptyLine}>
              No decisions yet.
            </Txt>
          ) : (
            result.decisions.map(d => (
              <DecisionRow key={d.itemId} decision={d} colors={colors} onPress={() => openMeeting(d.meetingId)} />
            ))
          )}

          <SectionHead label="MEETINGS" style={st.sectionGap} colors={colors} />
          {result.meetings.map(m => (
            <Pressable
              key={m.id}
              onPress={() => openMeeting(m.id)}
              accessibilityRole="button"
              accessibilityLabel={`Open ${m.title}`}
              style={st.row}>
              <Txt variant="bodyStrong">{m.title}</Txt>
              <Txt variant="chipSoft" color={colors.inkFaint}>
                {dayLabel(m.createdAt)}
              </Txt>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
    </View>
  );
}

function OpenRow({
  item,
  colors,
  onPress,
}: {
  item: ThreadOpenItem;
  colors: Colors;
  onPress: () => void;
}) {
  const { text, owner, due } = splitAction(item.content);
  const labels = labelsFor({ itemType: item.itemType, status: item.status, dateNorm: item.dateNorm });
  const dim = [owner, due, `${item.meetingTitle}, ${dayLabel(item.meetingAt)}`].filter(Boolean).join(' · ');
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={sentenceCase(text)} style={rowStyle.row}>
      <Txt variant="prose">{sentenceCase(text)}</Txt>
      <Txt variant="chipSoft" color={colors.inkFaint}>
        {dim}
      </Txt>
      <RecordChips labels={labels} colors={colors} />
    </Pressable>
  );
}

function DecisionRow({
  decision,
  colors,
  onPress,
}: {
  decision: ThreadDecision;
  colors: Colors;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={sentenceCase(decision.content)}
      style={rowStyle.row}>
      <Txt variant="prose">{sentenceCase(decision.content)}</Txt>
      <Txt variant="chipSoft" color={colors.inkFaint}>
        {`${decision.meetingTitle}, ${dayLabel(decision.meetingAt)}`}
      </Txt>
      {decision.changes ? (
        <Txt variant="chipSoft" color={colors.inkFaint}>
          {`changes: "${decision.changes.content}" (${dayLabel(decision.changes.meetingAt)})`}
        </Txt>
      ) : null}
    </Pressable>
  );
}

const rowStyle = StyleSheet.create({ row: { marginBottom: s(14) } });

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20) },
    pad: { paddingHorizontal: s(20), paddingTop: s(16) },
    row: { marginBottom: s(14) },
    sectionGap: { marginTop: s(18) },
    emptyLine: { marginBottom: s(8) },
  });
}
