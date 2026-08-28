import React from 'react';
import { FlatList, StyleSheet, View } from 'react-native';
import { Raised, Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Speaker, Utterance } from '../../pipeline/types';
import { initials, stamp } from './shared';

type Turn = {
  key: string;
  who: string;
  idx: number;
  startMs: number;
  lines: string[];
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
    const room = open !== null && open.lines.length < MAX_LINES_PER_TURN;
    const continuous = u.startMs - lastEnd < TURN_GAP_MS;
    if (open && sameVoice && room && continuous) {
      open.lines.push(text);
      lastEnd = u.endMs;
      continue;
    }

    turns.push({
      key: u.id ?? String(i),
      who: u.speakerId ? nameById.get(u.speakerId) ?? 'Speaker' : 'Unlabelled',
      idx: u.speakerId ? indexById.get(u.speakerId) ?? 0 : 0,
      startMs: u.startMs,
      lines: [text],
    });
    last = id;
    lastEnd = u.endMs;
  }
  return turns;
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
  const turns = React.useMemo(
    () => toTurns(utterances, nameById, indexById),
    [utterances, nameById, indexById],
  );

  return (
    <FlatList
      data={turns}
      keyExtractor={t => t.key}
      contentContainerStyle={st.pad}
      showsVerticalScrollIndicator={false}
      initialNumToRender={12}
      windowSize={11}
      removeClippedSubviews
      ListEmptyComponent={
        <Txt variant="body" color={colors.inkSoft} style={st.empty}>
          No transcript for this meeting.
        </Txt>
      }
      renderItem={({ item: t }) => {
        const tint = colors.speakers[t.idx % colors.speakers.length];
        const tintSoft = colors.speakersSoft[t.idx % colors.speakersSoft.length];
        return (
          <View style={st.turn}>
            <View style={st.who}>
              <View style={[st.avatar, { backgroundColor: tintSoft }]}>
                <Txt variant="chipSm" color={tint}>
                  {initials(t.who)}
                </Txt>
              </View>
              <Txt variant="chip" color={tint}>
                {t.who}
              </Txt>
              <Txt variant="chipSoft" color={colors.inkFaint}>
                {stamp(t.startMs)}
              </Txt>
            </View>
            <Raised edge={colors.line} fill={colors.card} rad={radius.card} depth={4}>
              {/* One card for the whole turn. Each segment stays its own paragraph, so the
                  pauses the VAD found are still legible as pauses. */}
              <View style={st.card}>
                {t.lines.map((line, i) => (
                  <Txt key={i} variant="prose">
                    {line}
                  </Txt>
                ))}
              </View>
            </Raised>
          </View>
        );
      }}
    />
  );
}

function makeStyles(_c: Colors) {
  return StyleSheet.create({
    pad: { paddingHorizontal: s(16), paddingBottom: s(30), gap: s(16) },
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
