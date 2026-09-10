import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, LayoutAnimation, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { ActionRow } from '../pipeline/types';
import { db } from '../db/queries';
import { loadActions } from './actionsData';
import { sentenceCase, splitAction } from './meeting/shared';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { IconButton, ProgressBar, Raised, Txt } from '../components/ui';
import { radius, s, sv, useTheme, type Colors } from '../theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Actions'>;

const dayOf = (ts: number) =>
  ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

/**
 * The list is flattened into rows rather than nested, so it can be virtualised.
 *
 * A worklist spanning a year of meetings is the case this screen exists for, and that is exactly
 * the case a map of maps rendered inside a ScrollView mounts in full on every tick of a checkbox.
 */
type Row =
  | { type: 'meeting'; key: string; meetingId: string; title: string; createdAt: number; count: number }
  | { type: 'item'; key: string; item: ActionRow }
  | { type: 'fold'; key: string; count: number };

/**
 * Turn a flat, meeting-ordered list of items into header + item rows.
 *
 * A run-length grouper, so it needs one invariant and cannot check it: every row of a meeting
 * arrives CONTIGUOUSLY. `allActions` guarantees that by construction — it orders by meeting date
 * and then by meeting id, so two meetings sharing a created_at still cannot interleave — and
 * filtering by tick state preserves it. Break that ordering and nothing throws: the meeting simply
 * renders twice, with its count split across the two headers.
 */
function group(items: ActionRow[], prefix: string): Row[] {
  const rows: Row[] = [];
  let at = 0;
  while (at < items.length) {
    const id = items[at].meetingId;
    let end = at;
    while (end < items.length && items[end].meetingId === id) end++;
    const slice = items.slice(at, end);
    rows.push({
      type: 'meeting',
      key: `${prefix}:h:${id}:${at}`,
      meetingId: id,
      title: slice[0].meetingTitle || 'Untitled meeting',
      createdAt: slice[0].createdAt,
      count: slice.length,
    });
    slice.forEach((item, i) =>
      rows.push({ type: 'item', key: `${prefix}:${id}:${at + i}`, item }),
    );
    at = end;
  }
  return rows;
}

/**
 * Everything the user owes, across every meeting.
 *
 * The per-meeting worklist is the strongest habit hook the app has; kept inside a meeting it is
 * only ever seen by someone who already went looking, one meeting at a time. Lifted to its own
 * screen it answers the question people actually open a notes app to ask — what did I promise, and
 * have I done it — which is what turns a recorder into something opened daily.
 *
 * A tick written here is keyed on the ITEM's id (see actionsData), so it survives a reprocess or a
 * speaker merge — including one that re-words the sentence, which the old text hash could not.
 *
 * It is the same tick the meeting's own Actions tab shows. That tab wrote `action_done`, keyed on
 * hashed text, between Task 9 and Task 10, and the two screens held separate answers for one item
 * for exactly that long; Task 10 moved it onto `item_done` and the answers are one again. Ticks
 * made before either build are in both stores, because Task 8's migration wrote both.
 */
export default function ActionsScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const [rows, setRows] = useState<ActionRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const refresh = useCallback(async () => {
    const items = await loadActions();
    setRows(items);
    setLoaded(true);
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Re-read on every focus, because coming back from a meeting is when this list changes:
      // OPENING that meeting is what migrates it, so it may have gained every item it has while
      // the user was in there, and a reprocess re-words items under ids this list already holds.
      // AND to pick up ticks made in that meeting's own Actions tab, which writes the same
      // `item_done` rows this list reads. That was not true between Task 9 and Task 10.
      refresh().catch(() => setLoaded(true));
    }, [refresh]),
  );

  /**
   * Tick or untick.
   *
   * Optimistic, exactly as the meeting's own tab is: the tick belongs on the next frame, not after
   * a database round trip, and a failed write costs a tick rather than the item.
   *
   * Matched on the item's id, and the id is what is written. The row it moves is now exactly one:
   * under the old text hash, two meetings that produced the same sentence shared a key, so the
   * optimistic pass had to match on meeting AND key and still moved every duplicate inside that
   * meeting together. An id is the item, so there is nothing to fan out to.
   */
  const toggle = useCallback((item: ActionRow) => {
    const next = !item.done;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setRows(prev => prev.map(r => (r.id === item.id ? { ...r, done: next } : r)));
    db.setItemDone(item.meetingId, item.id, next).catch(() => {});
  }, []);

  const open = useCallback(
    (meetingId: string) => navigation.navigate('Meeting', { meetingId, tab: 'actions' }),
    [navigation],
  );

  const outstanding = useMemo(() => rows.filter(r => !r.done), [rows]);
  const finished = useMemo(() => rows.filter(r => r.done), [rows]);
  const meetingCount = useMemo(
    () => new Set(outstanding.map(r => r.meetingId)).size,
    [outstanding],
  );

  const data = useMemo<Row[]>(() => {
    const out = group(outstanding, 'todo');
    if (finished.length > 0) {
      out.push({ type: 'fold', key: 'fold', count: finished.length });
      // Finished items are kept but folded away: they are the proof of work, not the work.
      if (showDone) out.push(...group(finished, 'done'));
    }
    return out;
  }, [outstanding, finished, showDone]);

  const renderItem = ({ item: row }: { item: Row }) => {
    if (row.type === 'meeting') {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${row.title}`}
          onPress={() => open(row.meetingId)}
          style={st.head}>
          <View style={st.flex}>
            <Txt variant="bodyStrong" numberOfLines={1}>
              {row.title}
            </Txt>
            <Txt variant="chipSoft" color={colors.inkFaint} style={st.headMeta}>
              {[dayOf(row.createdAt), `${row.count} item${row.count === 1 ? '' : 's'}`]
                .filter(Boolean)
                .join(' · ')}
            </Txt>
          </View>
          <Icon name="chevronRight" size={s(16)} color={colors.inkFaint} strokeWidth={2.4} />
        </Pressable>
      );
    }

    if (row.type === 'fold') {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showDone }}
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setShowDone(v => !v);
          }}
          style={st.fold}>
          <Txt variant="overlineSm" color={colors.inkFaint}>
            DONE · {row.count}
          </Txt>
          <Icon
            name={showDone ? 'chevronUp' : 'chevronDown'}
            size={s(16)}
            color={colors.inkFaint}
            strokeWidth={2.8}
          />
        </Pressable>
      );
    }

    const { item } = row;
    const { text: body, owner, due } = splitAction(item.content);
    const on = item.done;
    return (
      <View style={st.itemWrap}>
        <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={on ? 2 : 4}>
          <View style={st.item}>
            {/* The box ticks; the rest of the row opens the meeting. Two jobs on one row need two
                targets — a single tap that had to mean both would mean neither reliably. */}
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
                  on && { backgroundColor: colors.success, borderColor: colors.success },
                ]}>
                {on ? (
                  <Icon name="check" size={s(14)} color={colors.onPrimary} strokeWidth={3.4} />
                ) : null}
              </View>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open the meeting this came from: ${body}`}
              onPress={() => open(item.meetingId)}
              style={st.flex}>
              <Txt
                variant="prose"
                color={on ? colors.inkFaint : colors.ink}
                style={on ? st.struck : null}>
                {sentenceCase(body)}
              </Txt>
              {(owner || due) && !on ? (
                <View style={st.tags}>
                  {owner ? (
                    <View style={[st.tag, { backgroundColor: colors.primarySoft }]}>
                      <Icon name="users" size={s(11)} color={colors.primary} strokeWidth={2.6} />
                      <Txt variant="chipSm" color={colors.primary}>
                        {owner}
                      </Txt>
                    </View>
                  ) : null}
                  {due ? (
                    <View style={[st.tag, { backgroundColor: colors.warningSoft }]}>
                      <Icon name="clock" size={s(11)} color={colors.warning} strokeWidth={2.6} />
                      <Txt variant="chipSm" color={colors.warning}>
                        {due}
                      </Txt>
                    </View>
                  ) : null}
                </View>
              ) : null}
            </Pressable>
          </View>
        </Raised>
      </View>
    );
  };

  /**
   * The summary card, and the reason to open the screen at all: one number, and how far through
   * the whole pile you are. Hidden until something has loaded, so it cannot flash a false zero.
   */
  const header =
    rows.length > 0 ? (
      <View style={st.summaryWrap}>
        <Raised edge={colors.line} fill={colors.card} rad={radius.xl} depth={6}>
          <View style={st.summary}>
            <View style={st.summaryNum}>
              <Txt variant="statNum" color={outstanding.length ? colors.primary : colors.success}>
                {outstanding.length}
              </Txt>
              <Txt variant="chipSoft" color={colors.inkDim}>
                outstanding
              </Txt>
            </View>
            <View style={st.flex}>
              <Txt variant="bodyStrong">
                {finished.length} of {rows.length} done
              </Txt>
              <Txt variant="chipSoft" color={colors.inkFaint} style={st.summaryLine}>
                {outstanding.length === 0
                  ? 'Everything anyone committed to is ticked off.'
                  : `Across ${meetingCount} meeting${meetingCount === 1 ? '' : 's'}.`}
              </Txt>
              <View style={st.summaryBar}>
                <ProgressBar
                  pct={rows.length ? (finished.length / rows.length) * 100 : 0}
                  color={colors.success}
                  track={colors.cardAlt}
                />
              </View>
            </View>
          </View>
        </Raised>
      </View>
    ) : null;

  /**
   * Two different empties, because they call for two different things.
   *
   * Nothing recorded yet is a "here is what this will be" — the screen has never had anything to
   * show. Everything ticked is an achievement and should read as one. Collapsing both into
   * "Nothing outstanding" would tell a new user their empty app is finished work.
   */
  const empty = () => {
    if (!loaded) return null;
    return (
      <View style={st.empty}>
        <Mascot mood={rows.length > 0 ? 'idle' : 'asleep'} size={sv(120)} animated={false} />
        <Txt variant="display" style={st.emptyTitle}>
          {rows.length > 0 ? 'All caught up' : 'Nothing to do yet'}
        </Txt>
        <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
          {rows.length > 0
            ? `Every one of the ${rows.length} action item${
                rows.length === 1 ? '' : 's'
              } across your meetings is ticked off.`
            : 'Anything anyone commits to in a meeting is pulled out and collected here, so you ' +
              'can see what you owe without opening a single recording.'}
        </Txt>
      </View>
    );
  };

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <View style={st.flex}>
          <Txt variant="sectionTitle">Actions</Txt>
          {loaded && rows.length > 0 ? (
            <Txt variant="chipSoft" color={colors.inkDim} style={st.navSub}>
              Everything you owe, from every meeting
            </Txt>
          ) : null}
        </View>
      </View>

      <FlatList
        data={data}
        keyExtractor={r => r.key}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[
          st.listPad,
          { paddingBottom: insets.bottom + s(28) },
          data.length === 0 && st.emptyPad,
        ]}
        ListHeaderComponent={header}
        ListEmptyComponent={empty()}
        renderItem={renderItem}
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

    summaryWrap: { marginBottom: s(8) },
    summary: { flexDirection: 'row', alignItems: 'center', gap: s(16), padding: s(16) },
    summaryNum: { alignItems: 'center', minWidth: s(58) },
    summaryLine: { marginTop: s(3) },
    summaryBar: { marginTop: s(10) },

    head: { flexDirection: 'row', alignItems: 'center', gap: s(10), paddingTop: s(18), paddingBottom: s(8) },
    headMeta: { marginTop: s(3) },

    itemWrap: { marginBottom: s(8) },
    item: { flexDirection: 'row', gap: s(12), padding: s(14), alignItems: 'flex-start' },
    box: {
      width: s(23),
      height: s(23),
      borderRadius: s(7),
      borderWidth: s(2),
      alignItems: 'center',
      justifyContent: 'center',
      // Optical centring against the first line of prose rather than the top of its box.
      marginTop: s(2),
    },
    struck: { textDecorationLine: 'line-through' },
    tags: { flexDirection: 'row', flexWrap: 'wrap', gap: s(6), marginTop: s(8) },
    tag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(4),
      paddingHorizontal: s(8),
      paddingVertical: s(4),
      borderRadius: s(8),
    },

    fold: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: s(10),
      marginTop: s(10),
    },

    empty: { alignItems: 'center', paddingHorizontal: s(24) },
    emptyTitle: { marginTop: s(18), textAlign: 'center' },
    emptyBody: { textAlign: 'center', marginTop: s(6) },
  });
}
