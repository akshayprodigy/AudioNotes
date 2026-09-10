import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MeetingTab, RootStackParamList } from '../navigation/RootNavigator';
import { db } from '../db/queries';
import { useLibraryStore } from '../state/libraryStore';
import Icon from '../components/Icon';
import Mascot from '../components/Mascot';
import { IconButton, Pop, Raised, SoftButton, Txt } from '../components/ui';
import { font, radius, s, sv, useTheme, type Colors } from '../theme';

import type { SearchHit } from '../pipeline/types';

type Props = NativeStackScreenProps<RootStackParamList, 'Search'>;

/**
 * The markers native wraps around matched terms inside `snippet`.
 *
 * Control characters rather than any kind of markup, chosen because no transcript will ever
 * contain them — so splitting on them cannot corrupt real text, and no word a person actually said
 * can be mistaken for a marker. They must never reach the screen: rendered raw they show up as
 * boxes or as nothing at all, both of which look like a bug in the transcript.
 */
const HL_OPEN = '\u0002';
const HL_CLOSE = '\u0003';

type Run = { text: string; hit: boolean };

/**
 * Split a snippet into plain and matched runs.
 *
 * Tolerant of unbalanced markers on purpose. FTS5 snippets are cut to a character budget, so a
 * snippet can legitimately begin inside a match or end before its closing marker; the parser just
 * carries the current state and flushes what it has. Whatever happens, both marker characters are
 * consumed rather than emitted.
 */
function runsOf(snippet: string): Run[] {
  const out: Run[] = [];
  let buf = '';
  let inHit = false;
  const flush = () => {
    if (buf) out.push({ text: buf, hit: inHit });
    buf = '';
  };
  for (const ch of snippet) {
    if (ch === HL_OPEN) {
      flush();
      inHit = true;
    } else if (ch === HL_CLOSE) {
      flush();
      inHit = false;
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}

/** The same snippet with the markers stripped — for accessibility labels, which cannot be styled. */
const plain = (snippet: string) => snippet.replace(/[\u0002\u0003]/g, '');

/**
 * What was matched, and where tapping it should land.
 *
 * The index covers five different kinds of text and they are not interchangeable to a reader: a
 * phrase found in the transcript is something somebody said, and the same phrase found in the
 * minutes is something the meeting decided. Labelling the difference is most of what makes a
 * results list readable, and the destination follows from it — a transcript hit opens the
 * transcript at the moment it was spoken, a minute hit opens the minutes.
 *
 * `item` is a decision, action or question with provenance — one of the three, and the hit does
 * not say which, so the label names the class rather than guessing at the member and the tab is
 * the one that shows all three. It gets its own `case` because the `default` below is a trap: an
 * unhandled kind is not a type error, it is silently labelled "TITLE" and sent to the summary tab,
 * which is exactly what item hits did between the day AudioDb started indexing them and the day
 * the pipeline started producing them for real meetings.
 */
export function kindMeta(kind: SearchHit['kind'], c: Colors) {
  switch (kind) {
    case 'utterance':
      return { label: 'SAID', color: c.primary, soft: c.primarySoft, tab: 'transcript' as MeetingTab };
    case 'item':
      return { label: 'ITEM', color: c.warning, soft: c.warningSoft, tab: 'mom' as MeetingTab };
    case 'minute':
      return { label: 'MINUTES', color: c.warning, soft: c.warningSoft, tab: 'mom' as MeetingTab };
    case 'summary':
      return { label: 'SUMMARY', color: c.success, soft: c.successSoft, tab: 'summary' as MeetingTab };
    default:
      return { label: 'TITLE', color: c.inkSoft, soft: c.cardAlt, tab: 'summary' as MeetingTab };
  }
}

/** mm:ss, matching the transcript's own stamps, so a hit reads as a position in the recording. */
function stamp(ms: number): string {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

const dayOf = (ts: number) =>
  ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';

/** Date filters. Restrained deliberately — see the filter row below. */
type Range = 'all' | 'week' | 'month';
const RANGES: { key: Range; label: string; days: number }[] = [
  { key: 'all', label: 'Any time', days: 0 },
  { key: 'week', label: '7 days', days: 7 },
  { key: 'month', label: '30 days', days: 30 },
];

/** What the screen knows about a meeting a hit belongs to, independent of the index. */
interface MeetingMeta {
  title: string;
  createdAt: number;
  archived: boolean;
}

/** Hits for one meeting, in rank order, best meeting first. */
interface Group {
  meetingId: string;
  meta: MeetingMeta | undefined;
  hits: SearchHit[];
}

/** How many hits a meeting shows before it offers to show the rest. */
const PREVIEW = 3;

export default function SearchScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const st = useMemo(() => makeStyles(colors), [colors]);
  const insets = useSafeAreaInsets();

  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [range, setRange] = useState<Range>('all');
  const [onlyActions, setOnlyActions] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [meta, setMeta] = useState<Map<string, MeetingMeta>>(new Map());
  const [withActions, setWithActions] = useState<Set<string>>(new Set());

  // Progress of the library's index backfill. An old library is searchable only once that has run,
  // and saying so is the difference between "still working" and "your meeting is not in here".
  const indexing = useLibraryStore(s2 => s2.indexing);
  const unindexed = useLibraryStore(s2 => s2.unindexed);

  /**
   * Everything the filters need, loaded once.
   *
   * The index stores a meeting id and nothing else about the meeting, so the date of a hit and
   * whether its meeting produced any actions both have to come from the meetings tables. Archived
   * meetings are included: they are hidden from the library, but a person searching for a phrase
   * they know they said should still find it — the result is labelled instead of suppressed.
   */
  useEffect(() => {
    let alive = true;
    Promise.all([db.listMeetings(), db.listArchived(), db.allActions()])
      .then(([live, archived, actions]) => {
        if (!alive) return;
        const map = new Map<string, MeetingMeta>();
        for (const m of live) {
          map.set(m.id, { title: m.title, createdAt: m.createdAt, archived: false });
        }
        for (const m of archived) {
          map.set(m.id, { title: m.title, createdAt: m.createdAt, archived: true });
        }
        setMeta(map);
        setWithActions(new Set(actions.map(a => a.meetingId)));
      })
      .catch(() => {
        // Only the filters depend on this. Search itself still works, so failing quietly here is
        // better than an error banner over a results list that is perfectly correct.
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Debounce.
   *
   * FTS5 over a whole library is fast, but a query per keystroke means the answer on screen is
   * whichever request happens to return last — which on a slow write is the one for a prefix the
   * user has already moved past. The timer collapses the burst; the generation counter below
   * discards whatever still lands out of order.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeText = useCallback((t: string) => {
    setTerm(t);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setQuery(t.trim()), 220);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const generation = useRef(0);
  useEffect(() => {
    const mine = ++generation.current;
    // One character matches almost everything and is never what a person meant.
    if (query.length < 2) {
      setResults([]);
      setError(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    db.search(query)
      .then(hits => {
        if (generation.current !== mine) return;
        setResults(hits);
        setError(null);
        setBusy(false);
        setExpanded(new Set());
      })
      .catch((e: unknown) => {
        if (generation.current !== mine) return;
        // Errors used to be swallowed into an empty array, so a broken index and a genuine
        // "nothing found" were the same screen. They are not the same problem and must not look
        // alike: one is answered by rephrasing, the other by knowing something is wrong.
        setError(e instanceof Error ? e.message : String(e));
        setResults([]);
        setBusy(false);
      });
  }, [query, attempt]);

  const filtersOn = range !== 'all' || onlyActions;

  const groups = useMemo<Group[]>(() => {
    const cutoff =
      range === 'all' ? 0 : Date.now() - (RANGES.find(r => r.key === range)?.days ?? 0) * 86400000;

    const order: string[] = [];
    const byMeeting = new Map<string, SearchHit[]>();
    for (const hit of results) {
      const m = meta.get(hit.meetingId);
      // A hit whose meeting is not in the map is a meeting the index knows about and the tables do
      // not. It is shown unfiltered, but a filter it cannot be checked against must exclude it —
      // claiming a row is "from the last 7 days" without knowing its date would be a lie.
      if (filtersOn && !m) continue;
      if (cutoff && (!m || m.createdAt < cutoff)) continue;
      if (onlyActions && !withActions.has(hit.meetingId)) continue;

      let list = byMeeting.get(hit.meetingId);
      if (!list) {
        list = [];
        byMeeting.set(hit.meetingId, list);
        order.push(hit.meetingId);
      }
      list.push(hit);
    }
    // `results` arrives ranked by bm25, so first appearance is the best-matching meeting first and
    // the hits inside each group keep their own ranking.
    return order.map(id => ({ meetingId: id, meta: meta.get(id), hits: byMeeting.get(id) ?? [] }));
  }, [results, meta, withActions, range, onlyActions, filtersOn]);

  const totalHits = useMemo(() => groups.reduce((n, g) => n + g.hits.length, 0), [groups]);

  const openHit = useCallback(
    (hit: SearchHit) => {
      const { tab } = kindMeta(hit.kind, colors);
      navigation.navigate('Meeting', {
        meetingId: hit.meetingId,
        tab,
        // Utterance timings are anchored to the original recording's timeline, so this lands on
        // the exact turn rather than somewhere near it.
        //
        // An `item` hit ALSO carries a real moment — it is indexed at its anchor, not at 0 like
        // title/minute/summary — so this condition is narrower than "the kinds that have a
        // timestamp". Task 10 gave every item on the MOM and Actions tabs a timestamp that opens
        // the transcript there, so the moment is now one tap away; routing the hit STRAIGHT at it
        // would mean telling the MOM tab which of its rows to open, which it still cannot be told.
        // An item hit opens the tab that shows it, and the row carries the rest of the way.
        ...(hit.kind === 'utterance' ? { atMs: hit.startMs } : null),
      });
    },
    [colors, navigation],
  );

  const toggleGroup = useCallback((meetingId: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(meetingId)) next.delete(meetingId);
      else next.add(meetingId);
      return next;
    });
  }, []);

  const clearFilters = useCallback(() => {
    setRange('all');
    setOnlyActions(false);
  }, []);

  /** One result row: what kind of text matched, the snippet with the match picked out, and when. */
  const Hit = ({ hit }: { hit: SearchHit }) => {
    const k = kindMeta(hit.kind, colors);
    return (
      <Raised
        edge={colors.line}
        fill={colors.card}
        rad={radius.xl}
        depth={4}
        onPress={() => openHit(hit)}>
        <View
          accessibilityRole="button"
          accessibilityLabel={`${k.label.toLowerCase()}: ${plain(hit.snippet)}`}
          style={st.hit}>
          <View style={st.hitTop}>
            <View style={[st.kind, { backgroundColor: k.soft }]}>
              <Txt variant="chipSm" color={k.color}>
                {k.label}
              </Txt>
            </View>
            {hit.kind === 'utterance' && hit.startMs > 0 ? (
              <Txt variant="chipSoft" color={colors.inkFaint}>
                {stamp(hit.startMs)}
              </Txt>
            ) : null}
            <View style={st.flex} />
            <Icon name="chevronRight" size={s(16)} color={colors.inkFaint} strokeWidth={2.4} />
          </View>
          <Txt variant="body" numberOfLines={3}>
            {runsOf(hit.snippet).map((run, i) =>
              run.hit ? (
                <Text key={i} style={st.mark}>
                  {run.text}
                </Text>
              ) : (
                run.text
              ),
            )}
          </Txt>
        </View>
      </Raised>
    );
  };

  const renderGroup = ({ item, index }: { item: Group; index: number }) => {
    const open = expanded.has(item.meetingId);
    const shown = open ? item.hits : item.hits.slice(0, PREVIEW);
    const hidden = item.hits.length - shown.length;
    const title = item.meta?.title || 'Untitled meeting';
    return (
      <Pop index={index} style={st.group}>
        {/* The meeting is a heading rather than a card: the hits underneath are the cards, and two
            levels of raised surface would bury the thing being read. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${title}`}
          onPress={() => navigation.navigate('Meeting', { meetingId: item.meetingId })}
          style={st.groupHead}>
          <View style={st.flex}>
            <Txt variant="bodyStrong" numberOfLines={1}>
              {title}
            </Txt>
            <Txt variant="chipSoft" color={colors.inkFaint} style={st.groupMeta}>
              {[
                item.meta ? dayOf(item.meta.createdAt) : null,
                `${item.hits.length} match${item.hits.length === 1 ? '' : 'es'}`,
                item.meta?.archived ? 'archived' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Txt>
          </View>
          <Icon name="chevronRight" size={s(16)} color={colors.inkFaint} strokeWidth={2.4} />
        </Pressable>

        <View style={st.hits}>
          {shown.map((hit, i) => (
            <Hit key={`${hit.kind}:${hit.refId ?? i}:${i}`} hit={hit} />
          ))}
        </View>

        {item.hits.length > PREVIEW ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => toggleGroup(item.meetingId)}
            style={st.more}>
            <Txt variant="chip" color={colors.primary}>
              {open ? 'Show fewer' : `${hidden} more in this meeting`}
            </Txt>
            <Icon
              name={open ? 'chevronUp' : 'chevronDown'}
              size={s(15)}
              color={colors.primary}
              strokeWidth={2.8}
            />
          </Pressable>
        ) : null}
      </Pop>
    );
  };

  const empty = () => {
    if (error) {
      return (
        <View style={st.empty}>
          <Icon name="alert" size={s(34)} color={colors.danger} strokeWidth={2.4} />
          <Txt variant="display" style={st.emptyTitle}>
            Search could not run
          </Txt>
          <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
            {error}
          </Txt>
          <View style={st.retry}>
            <SoftButton label="Try again" icon="refresh" onPress={() => setAttempt(a => a + 1)} />
          </View>
        </View>
      );
    }
    if (query.length < 2) {
      return (
        <View style={st.empty}>
          <Mascot mood="idle" size={sv(120)} animated={false} />
          <Txt variant="display" style={st.emptyTitle}>
            Search your meetings
          </Txt>
          <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
            Transcripts, minutes, summaries and meeting names — every word of every meeting you
            have recorded, searched on this device.
          </Txt>
        </View>
      );
    }
    if (busy) {
      return (
        <View style={st.empty}>
          <Mascot mood="thinking" size={sv(120)} animated={false} />
          <Txt variant="display" style={st.emptyTitle}>
            Looking…
          </Txt>
        </View>
      );
    }
    // Two different nothings. A query that matched the index but was filtered out is a filter
    // problem and is fixable in one tap; saying "nothing found" there would be a small lie.
    const filteredOut = filtersOn && results.length > 0;
    return (
      <View style={st.empty}>
        <Mascot mood="thinking" size={sv(120)} animated={false} />
        <Txt variant="display" style={st.emptyTitle}>
          {filteredOut ? 'Nothing in this range' : 'Nothing found'}
        </Txt>
        <Txt variant="body" color={colors.inkSoft} style={st.emptyBody}>
          {filteredOut
            ? `“${query}” turns up ${results.length} match${
                results.length === 1 ? '' : 'es'
              }, but none in the meetings these filters allow.`
            : `Nothing in your transcripts, minutes, summaries or meeting names mentions “${query}”.`}
        </Txt>
        {filteredOut ? (
          <View style={st.retry}>
            <SoftButton label="Clear filters" icon="undo" onPress={clearFilters} />
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={[st.root, { paddingTop: insets.top + s(8) }]}>
      <View style={st.nav}>
        <IconButton icon="chevronLeft" label="Back" onPress={() => navigation.goBack()} />
        <Txt variant="sectionTitle">Search</Txt>
      </View>

      <View style={st.searchBox}>
        <Icon name="search" size={s(19)} color={colors.inkFaint} strokeWidth={2.4} />
        <TextInput
          style={st.input}
          placeholder="Search everything that was said or decided"
          placeholderTextColor={colors.inkFaint}
          autoFocus
          autoCorrect={false}
          returnKeyType="search"
          value={term}
          onChangeText={onChangeText}
        />
        {term.length > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Clear search"
            hitSlop={s(10)}
            onPress={() => {
              setTerm('');
              setQuery('');
            }}>
            <Icon name="x" size={s(17)} color={colors.inkDim} strokeWidth={2.6} />
          </Pressable>
        ) : null}
      </View>

      {/* Two filters, no more. The point of this screen is to find one thing quickly; a query
          builder on top of a search box is a second thing to learn before the first one works.
          Date narrows the haystack, "has actions" is the one property of a meeting people
          actually search by ("the meeting where I promised something"). */}
      <View style={st.filters}>
        {RANGES.map(r => {
          const on = r.key === range;
          return (
            <Pressable
              key={r.key}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={r.label}
              onPress={() => setRange(r.key)}
              style={[
                st.chip,
                { backgroundColor: on ? colors.primarySoft : colors.card, borderColor: on ? colors.primarySoftEdge : colors.line },
              ]}>
              <Txt variant="chipSoft" color={on ? colors.primary : colors.inkDim}>
                {r.label}
              </Txt>
            </Pressable>
          );
        })}
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: onlyActions }}
          accessibilityLabel="Only meetings with actions"
          onPress={() => setOnlyActions(v => !v)}
          style={[
            st.chip,
            {
              backgroundColor: onlyActions ? colors.warningSoft : colors.card,
              borderColor: onlyActions ? colors.warningEdge : colors.line,
            },
          ]}>
          <Icon
            name="filter"
            size={s(12)}
            color={onlyActions ? colors.warning : colors.inkDim}
            strokeWidth={2.8}
          />
          <Txt variant="chipSoft" color={onlyActions ? colors.warning : colors.inkDim}>
            Has actions
          </Txt>
        </Pressable>
      </View>

      {/* Honest about coverage while the backfill is still running: an older meeting genuinely is
          not findable yet, and "nothing found" would otherwise be read as "it isn't in there". */}
      {indexing && unindexed > 0 ? (
        <Txt variant="chipSoft" color={colors.inkDim} style={st.notice}>
          Still indexing {unindexed} older meeting{unindexed === 1 ? '' : 's'} — they will start
          turning up here shortly.
        </Txt>
      ) : null}

      {totalHits > 0 ? (
        <Txt variant="chipSoft" color={colors.inkFaint} style={st.count}>
          {totalHits} match{totalHits === 1 ? '' : 'es'} in {groups.length} meeting
          {groups.length === 1 ? '' : 's'}
        </Txt>
      ) : null}

      <FlatList
        data={groups}
        keyExtractor={g => g.meetingId}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={[
          st.listPad,
          { paddingBottom: insets.bottom + s(24) },
          groups.length === 0 && st.emptyPad,
        ]}
        ListEmptyComponent={empty()}
        renderItem={renderGroup}
      />
    </View>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: c.canvas },
    flex: { flex: 1 },
    nav: { flexDirection: 'row', alignItems: 'center', gap: s(12), paddingHorizontal: s(20) },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(10),
      backgroundColor: c.card,
      borderRadius: radius.lg,
      paddingHorizontal: s(16),
      marginHorizontal: s(20),
      marginTop: s(16),
    },
    input: {
      flex: 1,
      color: c.ink,
      paddingVertical: s(14),
      fontFamily: font.semibold,
      fontSize: s(15),
    },

    filters: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: s(8),
      paddingHorizontal: s(20),
      marginTop: s(12),
    },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: s(5),
      paddingHorizontal: s(12),
      paddingVertical: s(7),
      borderRadius: radius.pill,
      borderWidth: 1,
    },

    notice: { paddingHorizontal: s(20), marginTop: s(12) },
    count: { paddingHorizontal: s(20), marginTop: s(14) },

    listPad: { paddingHorizontal: s(20), paddingTop: s(12) },
    emptyPad: { flexGrow: 1, justifyContent: 'center' },

    group: { marginTop: s(6), marginBottom: s(14) },
    groupHead: { flexDirection: 'row', alignItems: 'center', gap: s(10), paddingVertical: s(8) },
    groupMeta: { marginTop: s(3) },
    hits: { gap: s(8) },
    more: { flexDirection: 'row', alignItems: 'center', gap: s(5), paddingVertical: s(10) },

    hit: { padding: s(14), gap: s(8) },
    hitTop: { flexDirection: 'row', alignItems: 'center', gap: s(8) },
    kind: { paddingHorizontal: s(8), paddingVertical: s(4), borderRadius: s(8) },
    // The matched run, inside a body-weight line. Only family and colour are set: giving a nested
    // Text its own size or line height inside a paragraph makes the leading jump around the match.
    mark: { fontFamily: font.black, color: c.primary },

    empty: { alignItems: 'center', paddingHorizontal: s(24) },
    emptyTitle: { marginTop: s(18), textAlign: 'center' },
    emptyBody: { textAlign: 'center', marginTop: s(6) },
    retry: { flexDirection: 'row', marginTop: s(18), paddingHorizontal: s(30) },
  });
}
