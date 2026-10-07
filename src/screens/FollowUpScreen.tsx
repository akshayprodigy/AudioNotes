import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { ActionRow, DecisionRow } from '../pipeline/types';
import { entitlement } from '../billing/trial';
import { db } from '../db/queries';
import { dayLabel } from '../pipeline/dateNorm';
import { emptyFollowUp, loadFollowUp, previewOf, dayStart, type FollowUp, type ReviewMeeting } from './followUpData';
import { labelsFor } from './meeting/recordLabels';
import { RecordChips, sentenceCase, splitAction } from './meeting/shared';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { IconButton, Raised, Txt } from '../components/ui';
import { radius, s, sv, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'FollowUp'>;
type Kind = Props['route']['params']['kind'];

const TITLE: Record<Kind, string> = {
  due: 'Due or overdue',
  decisions: 'Decisions still open',
  review: 'Notes to review',
};
const SUB: Record<Kind, string> = {
  due: 'Open actions whose date has come, oldest first',
  decisions: 'Decisions that nobody has settled or withdrawn',
  review: 'Meetings with items waiting for a quick look',
};
const EMPTY: Record<Kind, [string, string]> = {
  due: ['Nothing is due', 'Open actions with a date that has arrived show up here.'],
  decisions: ['No open decisions', 'Decisions that are still standing show up here.'],
  review: ['Nothing to review', 'Items the app was unsure about wait here for a quick look.'],
};

/**
 * One of the follow-up home's three lists (Pro). The Library's card says how many; this is the
 * list behind a count. Each row opens its meeting at the moment it was said (the same route the
 * Actions screen and Threads use), an action ticks in place on the same `item_done` store the
 * Actions screen writes, and a review row opens that meeting's review queue.
 */
export default function FollowUpScreen({ route, navigation }: Props) {
  const { kind } = route.params;
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [data, setData] = useState<FollowUp>(emptyFollowUp);
  const [loaded, setLoaded] = useState(false);

  // Pro, like the worklist and the thread view it is made of; a stale link must not be the only gate.
  useEffect(() => {
    entitlement()
      .then(ent => {
        if (!ent.paid) navigation.navigate('Paywall');
      })
      .catch(() => {});
  }, [navigation]);

  useFocusEffect(
    useCallback(() => {
      // Re-read on every focus: ticking in a meeting, or settling a review card, changes these lists.
      loadFollowUp(Date.now())
        .then(f => {
          setData(f);
          setLoaded(true);
        })
        .catch(() => setLoaded(true));
    }, []),
  );

  /** The same tick the Actions screen and the meeting's own tab write; optimistic like both. */
  const toggle = useCallback((item: ActionRow) => {
    const next = !item.done;
    setData(prev => ({ ...prev, due: prev.due.map(r => (r.id === item.id ? { ...r, done: next } : r)) }));
    db.setItemDone(item.meetingId, item.id, next).catch(() => {});
  }, []);

  const openMoment = useCallback(
    (meetingId: string, anchorStartMs: number | null | undefined) =>
      anchorStartMs === null || anchorStartMs === undefined
        ? navigation.navigate('Meeting', { meetingId, tab: 'actions' })
        : navigation.navigate('Meeting', { meetingId, tab: 'transcript', atMs: anchorStartMs, play: true }),
    [navigation],
  );

  const today = dayStart(Date.now());

  const rows: (ActionRow | DecisionRow | ReviewMeeting)[] =
    kind === 'due' ? data.due : kind === 'decisions' ? data.decisions : data.review;

  const renderAction = (item: ActionRow) => {
    const { text: body, owner } = splitAction(item.content);
    const on = item.done;
    const due =
      item.dateNorm === null || item.dateNorm === undefined
        ? null
        : item.dateNorm === today
          ? 'Due today'
          : `Due ${dayLabel(item.dateNorm)}`;
    return (
      <View style={st.itemWrap}>
        <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={on ? 2 : 4}>
          <View style={st.item}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={body}
              hitSlop={s(10)}
              onPress={() => toggle(item)}>
              <View
                style={[
                  st.box,
                  { borderColor: on ? colors.success : colors.line },
                  on && { backgroundColor: colors.success },
                ]}>
                {on ? <Icon name="check" size={s(14)} color={colors.onPrimary} strokeWidth={3.4} /> : null}
              </View>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open the meeting this came from: ${body}`}
              onPress={() => openMoment(item.meetingId, item.anchorStartMs)}
              style={st.flex}>
              <Txt variant="prose" color={on ? colors.inkFaint : colors.ink} style={on ? st.struck : null}>
                {sentenceCase(body)}
              </Txt>
              <Txt variant="chipSoft" color={colors.inkFaint} style={st.meta}>
                {[owner, due, `${item.meetingTitle || 'Untitled meeting'}, ${dayLabel(item.createdAt)}`]
                  .filter(Boolean)
                  .join(' · ')}
              </Txt>
            </Pressable>
          </View>
        </Raised>
      </View>
    );
  };

  const renderDecision = (d: DecisionRow) => {
    const labels = labelsFor({ itemType: d.itemType, status: d.status, dateNorm: null });
    return (
      <View style={st.itemWrap}>
        <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={4}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Open the meeting this came from: ${sentenceCase(d.content)}`}
            onPress={() => openMoment(d.meetingId, d.anchorStartMs)}
            style={st.item}>
            <View style={st.flex}>
              <Txt variant="prose">{sentenceCase(d.content)}</Txt>
              <Txt variant="chipSoft" color={colors.inkFaint} style={st.meta}>
                {`${d.meetingTitle || 'Untitled meeting'}, ${dayLabel(d.createdAt)}`}
              </Txt>
              <View style={st.chips}>
                <RecordChips labels={labels} colors={colors} />
              </View>
            </View>
          </Pressable>
        </Raised>
      </View>
    );
  };

  const renderReview = (m: ReviewMeeting) => (
    <View style={st.itemWrap}>
      <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={4}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Review ${m.meetingTitle || 'Untitled meeting'}`}
          onPress={() => navigation.navigate('Review', { meetingId: m.meetingId })}
          style={st.item}>
          <View style={st.flex}>
            <Txt variant="bodyStrong" numberOfLines={1}>
              {m.meetingTitle || 'Untitled meeting'}
            </Txt>
            <Txt variant="chipSoft" color={colors.inkFaint} style={st.meta}>
              {`${dayLabel(m.createdAt)} · ${m.count} item${m.count === 1 ? '' : 's'} to look at`}
            </Txt>
            <Txt variant="chipSoft" color={colors.inkSoft} style={st.meta} numberOfLines={1}>
              {previewOf(m.firstText)}
            </Txt>
          </View>
          <Icon name="chevronRight" size={s(16)} color={colors.inkFaint} strokeWidth={2.4} />
        </Pressable>
      </Raised>
    </View>
  );

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <View style={st.flex}>
          <Txt variant="sectionTitle">{TITLE[kind]}</Txt>
          <Txt variant="chipSoft" color={colors.inkDim} style={st.navSub}>
            {SUB[kind]}
          </Txt>
        </View>
      </View>
      <FlatList
        data={rows}
        keyExtractor={(r, i) => ('id' in r ? `${r.meetingId}:${r.id}` : `${r.meetingId}:${i}`)}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          st.listPad,
          { paddingBottom: insets.bottom + s(28) },
          rows.length === 0 && st.emptyPad,
        ]}
        ListEmptyComponent={
          loaded ? (
            <View style={st.empty}>
              <Mascot mood="idle" size={sv(110)} animated={false} />
              <Txt variant="display" style={st.emptyTitle}>
                {EMPTY[kind][0]}
              </Txt>
              <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
                {EMPTY[kind][1]}
              </Txt>
            </View>
          ) : null
        }
        renderItem={({ item }) =>
          kind === 'due'
            ? renderAction(item as ActionRow)
            : kind === 'decisions'
              ? renderDecision(item as DecisionRow)
              : renderReview(item as ReviewMeeting)
        }
      />
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20) },
    navSub: { marginTop: s(3) },
    listPad: { paddingHorizontal: s(20), paddingTop: s(16) },
    emptyPad: { flexGrow: 1, justifyContent: 'center' },
    itemWrap: { marginBottom: s(8) },
    item: { flexDirection: 'row', gap: s(12), padding: s(14), alignItems: 'flex-start' },
    box: {
      width: s(23),
      height: s(23),
      borderRadius: s(7),
      borderWidth: s(2),
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: s(2),
    },
    struck: { textDecorationLine: 'line-through' },
    meta: { marginTop: s(4) },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: s(6), marginTop: s(6) },
    empty: { alignItems: 'center', paddingHorizontal: s(24) },
    emptyTitle: { marginTop: s(18), textAlign: 'center' },
    emptyBody: { textAlign: 'center', marginTop: s(6) },
  });
}
