import React from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import Icon from '../../components/Icon';
import { Raised, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Speaker, Utterance } from '../../pipeline/types';
import {
  EditedTag,
  ToolButton,
  editedText,
  initials,
  isEdited,
  stamp,
  type EditMap,
} from './shared';

export type Turn = {
  key: string;
  who: string;
  idx: number;
  startMs: number;
  /** End of the last utterance folded into this turn — see activeTurn. */
  endMs: number;
  /**
   * The utterances this turn is made of, kept separate rather than joined into a string.
   *
   * A turn is a reading unit; an utterance is what the pipeline stores, what a timestamp points
   * at, and what a correction is keyed on. Flattening them lost both: tapping an eight-segment
   * turn played from up to a minute before the line you touched, and there was no id to hang an
   * edit off.
   */
  parts: { id: string; startMs: number; text: string }[];
};

/**
 * A turn is also the unit FlatList virtualises, so it has to stay bounded. Grouping purely by
 * speaker would put an entire eighteen-minute monologue in one row — and this meeting is exactly
 * that, one voice for most of its length — leaving the list with a handful of enormous items and
 * nothing left to window. Capping the run keeps rows a readable size and keeps windowing useful.
 */
const MAX_LINES_PER_TURN = 8;

/** A pause this long is a new thought even from the same speaker, so it earns a fresh timestamp. */
const TURN_GAP_MS = 20_000;

/**
 * Group runs of consecutive utterances by the same speaker into one turn.
 *
 * The pipeline emits an utterance per VAD segment, which is a unit of silence, not a unit of
 * meaning: one person talking steadily for a minute produces six or seven of them. Rendered one
 * card each, that was six avatars, six repetitions of "Speaker 1", six timestamps and six drop
 * shadows to say that one person said one thing — the screen scrolled for a minute and told you
 * almost nothing. A turn is how people actually read a conversation: who spoke, when they started,
 * and everything they said before someone else spoke.
 */
export function toTurns(
  utterances: Utterance[],
  nameById: Map<string, string>,
  indexById: Map<string, number>,
): Turn[] {
  const turns: Turn[] = [];
  let last: string | null = null;
  let lastEnd = 0;
  for (let i = 0; i < utterances.length; i++) {
    const u = utterances[i];
    const id = u.speakerId ?? '';
    const text = (u.text ?? '').trim();
    if (!text) continue;

    const open = turns.length ? turns[turns.length - 1] : null;
    const sameVoice = open !== null && id === last;
    const room = open !== null && open.parts.length < MAX_LINES_PER_TURN;
    const continuous = u.startMs - lastEnd < TURN_GAP_MS;
    const part = { id: u.id ?? String(i), startMs: u.startMs, text };
    if (open && sameVoice && room && continuous) {
      open.parts.push(part);
      open.endMs = u.endMs;
      lastEnd = u.endMs;
      continue;
    }

    turns.push({
      key: u.id ?? String(i),
      who: u.speakerId ? nameById.get(u.speakerId) ?? 'Speaker' : 'Unlabelled',
      idx: u.speakerId ? indexById.get(u.speakerId) ?? 0 : 0,
      startMs: u.startMs,
      endMs: u.endMs,
      parts: [part],
    });
    last = id;
    lastEnd = u.endMs;
  }
  return turns;
}

/**
 * Which turn the playhead is inside, or -1.
 *
 * The gaps between turns belong to the turn BEFORE them: VAD trims silence, so the playhead spends
 * a good part of any meeting in the space between two segments, and a highlight that blinked off
 * in every pause would flicker its way down the screen. Once a turn has been reached it stays lit
 * until the next one starts.
 */
export function activeTurn(turns: Turn[], positionMs: number): number {
  if (positionMs <= 0) return -1;
  let found = -1;
  // Linear, and deliberately so: it runs once per tick (five times a second) over a list that is
  // hundreds of entries at most, and a binary search here would be a second thing to get wrong.
  for (let i = 0; i < turns.length; i++) {
    if (turns[i].startMs > positionMs) break;
    found = i;
  }
  return found;
}

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
  positionMs = 0,
  onPlayTurn,
  scrollToMs,
  scrollSeq,
  onCopy,
  edits,
  onLineActions,
  onReassignTurn,
  onRevertLine,
  oneVoice = false,
}: {
  utterances: Utterance[];
  speakers: Speaker[];
  /**
   * A dictation: one voice by definition, diarization skipped, no utterance has a speaker. The
   * turns then carry a stamp but no head — nobody else it could have been, so "Unlabelled" and
   * "change who said it" would be an invitation to fix something that is not wrong.
   */
  oneVoice?: boolean;
  /** Where playback is, so the turn being spoken can be marked. */
  positionMs?: number;
  /** Tapping a turn. Absent when the audio is gone, which makes the rows plain text again. */
  onPlayTurn?: (ms: number) => void;
  /** A moment to jump to on arrival — a search hit opening the meeting at the phrase it matched. */
  scrollToMs?: number;
  /**
   * Which REQUEST this is, bumped by the caller on every one.
   *
   * `scrollToMs` alone cannot express "the same moment, again". Two items extracted from the same
   * turn share an anchor, and tapping the same item twice is the ordinary case — you scrolled away
   * and want it back. The effect below keys on the pair, so an unchanged millisecond still scrolls
   * when the request number moves. Left undefined by a caller that only ever asks once, such as
   * the `atMs` route param a search hit arrives with.
   */
  scrollSeq?: number;
  /** Copy the record itself: attributed, no minutes above it, no subtitle timings in it. */
  onCopy?: () => void;
  edits?: EditMap;
  /**
   * Long press on a line: the line (id, current text) and the turn it sits in. The caller offers
   * "correct the words" (keyed on the utterance id, which is what the edits table holds) and
   * "change who said it" (which needs the turn, for its scopes).
   */
  onLineActions?: (part: { id: string; text: string }, turn: Turn) => void;
  /** Tap on the name at the head of a turn: change who said the whole turn. */
  onReassignTurn?: (turn: Turn) => void;
  onRevertLine?: (utteranceId: string) => void;
}) {
  const { colors } = useTheme();
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const listRef = React.useRef<FlatList<Turn>>(null);
  const ed: EditMap = edits ?? new Map();
  const nameById = React.useMemo(
    () => new Map(speakers.map(x => [x.id, x.displayName])),
    [speakers],
  );
  const indexById = React.useMemo(() => new Map(speakers.map((x, i) => [x.id, i])), [speakers]);
  const turns = React.useMemo(
    () => toTurns(utterances, nameById, indexById),
    [utterances, nameById, indexById],
  );
  const active = onPlayTurn ? activeTurn(turns, positionMs) : -1;

  /**
   * Jump to the moment somebody asked for.
   *
   * Keyed on scrollToMs rather than run on mount: the transcript can arrive after the screen does
   * (the meeting is still being polled while it processes), and scrolling on mount would land on
   * an empty list and then never try again.
   *
   * `scrollSeq` is in the dependency list and deliberately not read in the body. It is what makes
   * the SECOND tap on the same item scroll: without it the effect is keyed on a millisecond, and
   * asking again for a millisecond it already has is not a change, so nothing happens and the tap
   * looks dropped. See MeetingScreen.openProvenance for the other half.
   */
  React.useEffect(() => {
    if (scrollToMs === undefined || turns.length === 0) return;
    const i = Math.max(0, activeTurn(turns, scrollToMs));
    // viewPosition 0.3 puts the line a third of the way down rather than jammed under the tabs.
    const t = setTimeout(
      () => listRef.current?.scrollToIndex({ index: i, viewPosition: 0.3, animated: true }),
      120,
    );
    return () => clearTimeout(t);
  }, [scrollToMs, scrollSeq, turns]);

  return (
    <FlatList
      ref={listRef}
      data={turns}
      keyExtractor={t => t.key}
      // Rows are variable height, so an index scroll can outrun what has been measured. Rather
      // than guess an average with getItemLayout, retry once the list has rendered further.
      onScrollToIndexFailed={info => {
        setTimeout(() => {
          listRef.current?.scrollToIndex({
            index: Math.min(info.index, info.highestMeasuredFrameIndex),
            viewPosition: 0.3,
            animated: false,
          });
        }, 80);
      }}
      contentContainerStyle={st.pad}
      showsVerticalScrollIndicator={false}
      initialNumToRender={12}
      windowSize={11}
      removeClippedSubviews
      ListHeaderComponent={
        turns.length > 0 ? (
          <View style={st.head}>
            <Txt variant="chipSoft" color={colors.inkFaint} style={st.flex}>
              {onPlayTurn
                ? onLineActions
                  ? oneVoice
                    ? 'Tap a line to hear it. Long press to correct it.'
                    : 'Tap a line to hear it. Long press to correct it or change who said it.'
                  : 'Tap any line to hear it.'
                : onLineActions
                  ? oneVoice
                    ? 'The recording has been deleted. Long press a line to correct it.'
                    : 'The recording has been deleted. Long press a line to correct it or change who said it.'
                  : 'The recording for this meeting has been deleted.'}
            </Txt>
            {onCopy ? (
              <ToolButton
                icon="copy"
                label="Copy"
                hint="Copies the transcript, ready to paste"
                colors={colors}
                onPress={onCopy}
              />
            ) : null}
          </View>
        ) : null
      }
      ListEmptyComponent={
        <Txt variant="body" color={colors.inkSoft} style={st.empty}>
          No transcript for this meeting.
        </Txt>
      }
      renderItem={({ item: t, index }) => {
        const tint = colors.speakers[t.idx % colors.speakers.length];
        const tintSoft = colors.speakersSoft[t.idx % colors.speakersSoft.length];
        const on = index === active;
        // Within the lit turn, which segment is being spoken. Same rule as activeTurn: the last
        // one reached, so the mark holds through the pause after it rather than blinking off.
        let liveLine = -1;
        if (on) {
          for (let i = 0; i < t.parts.length; i++) {
            if (t.parts[i].startMs > positionMs) break;
            liveLine = i;
          }
        }
        const card = (
          <Raised
            edge={on ? colors.primary : colors.line}
            fill={on ? colors.primarySoft : colors.card}
            rad={radius.card}
            depth={4}>
            {/* One card for the whole turn, but each segment is its own pressable: tapping plays
                from THAT line rather than from the top of an eight-segment turn, and a correction
                is keyed on the utterance it belongs to. The pauses the VAD found stay legible as
                paragraph breaks either way. */}
            <View style={st.card}>
              {t.parts.map((part, i) => {
                const text = editedText(ed, 'utterance', part.id, part.text) ?? part.text;
                const changed = isEdited(ed, 'utterance', part.id);
                const line = (
                  <View>
                    <Txt variant="prose" color={i === liveLine ? colors.primaryDeep : undefined}>
                      {text}
                    </Txt>
                    {changed ? (
                      <EditedTag
                        colors={colors}
                        onRevert={onRevertLine ? () => onRevertLine(part.id) : undefined}
                      />
                    ) : null}
                  </View>
                );
                if (!onPlayTurn && !onLineActions) return <View key={part.id}>{line}</View>;
                return (
                  <Pressable
                    key={part.id}
                    onPress={onPlayTurn ? () => onPlayTurn(part.startMs) : undefined}
                    onLongPress={onLineActions ? () => onLineActions({ id: part.id, text }, t) : undefined}
                    accessibilityRole="button"
                    accessibilityLabel={text}
                    accessibilityHint={
                      onLineActions
                        ? 'Plays from here. Long press to correct this line or change who said it.'
                        : 'Plays from here'
                    }
                    accessibilityActions={
                      onLineActions ? [{ name: 'longpress', label: 'Correct this line or change who said it' }] : undefined
                    }
                    onAccessibilityAction={e => {
                      if (e.nativeEvent.actionName === 'longpress') onLineActions?.({ id: part.id, text }, t);
                    }}>
                    {line}
                  </Pressable>
                );
              })}
            </View>
          </Raised>
        );
        return (
          <View style={st.turn}>
            <View style={st.who}>
              {oneVoice ? null : (
                <>
                  <View style={[st.avatar, { backgroundColor: tintSoft }]}>
                    <Txt variant="chipSm" color={tint}>
                      {initials(t.who)}
                    </Txt>
                  </View>
                  {/* The name is the way to say the whole turn was somebody else. */}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${t.who} — change who said this`}
                    onPress={onReassignTurn ? () => onReassignTurn(t) : undefined}
                    disabled={!onReassignTurn}
                    hitSlop={8}>
                    <Txt variant="chip" color={tint}>
                      {t.who}
                    </Txt>
                  </Pressable>
                </>
              )}
              <Txt variant="chipSoft" color={on ? colors.primaryDeep : colors.inkFaint}>
                {stamp(t.startMs)}
              </Txt>
              {on ? (
                <Icon name="volume" size={s(13)} color={colors.primaryDeep} strokeWidth={2.6} />
              ) : null}
            </View>
            {card}
          </View>
        );
      }}
    />
  );
}

function makeStyles(_c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(16) },
    // Says the gesture exists. A tappable transcript is invisible until you happen to tap one.
    head: { flexDirection: 'row', alignItems: 'center', gap: s(10), paddingHorizontal: s(2) },
    flex: { flex: 1 },
    empty: { paddingVertical: s(30), textAlign: 'center' },
    turn: { gap: s(7) },
    // The attribution sits above the card as a line of its own, so the card holds nothing but
    // what was said and the eye can skim the left edge for who is speaking.
    who: { flexDirection: 'row', alignItems: 'center', gap: s(8), paddingLeft: s(2) },
    avatar: {
      width: s(22),
      height: s(22),
      borderRadius: s(11),
      alignItems: 'center',
      justifyContent: 'center',
    },
    card: { padding: s(14), gap: s(8) },
  });
}
