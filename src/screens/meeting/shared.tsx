import React from 'react';
import { StyleSheet, View } from 'react-native';
import Icon, { type IconName } from '../../components/Icon';
import { Raised, Txt } from '../../components/ui';
import { radius, s, type Colors } from '../../theme';
import type { Minute } from '../../pipeline/types';

/**
 * Pieces shared by more than one meeting tab. Moved out of MeetingScreen when it split —
 * they encode the icon and colour mapping the whole screen depends on.
 */

export function kindMeta(
  kind: string,
  c: Colors,
): { label: string; color: string; soft: string; icon: IconName } {
  switch (kind) {
    case 'action':
      return { label: 'ACTION', color: c.warning, soft: c.warningSoft, icon: 'check' };
    case 'decision':
      return { label: 'DECISION', color: c.primary, soft: c.primarySoft, icon: 'check' };
    case 'question':
      return { label: 'OPEN QUESTION', color: c.success, soft: c.successSoft, icon: 'help' };
    default:
      return { label: 'NOTE', color: c.inkSoft, soft: c.cardAlt, icon: 'list' };
  }
}

/**
 * Avatar initials. "First two letters" gives every auto-named speaker "SP" — a column of
 * identical circles carrying no information — because they are all "Speaker N". For generated
 * names the digit is the distinguishing part; a renamed speaker gets proper initials.
 */
export function initials(name: string): string {
  const gen = name.match(/^Speaker\s*(\d+)$/i);
  if (gen) return `S${gen[1]}`;
  const w = name.trim().split(/\s+/).filter(Boolean);
  if (!w.length) return '?';
  if (w.length === 1) return w[0].slice(0, 2).toUpperCase();
  return (w[0][0] + w[w.length - 1][0]).toUpperCase();
}

/** Minutes are padded so the transcript's timestamp column lines up: 05:07, not 5:07. */
export const stamp = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
};

/**
 * Pull the owner and due date back out of an action's stored text.
 *
 * `minutes.ts` builds the row as `<sentence> — <owner>` plus an optional `(due …)`, so the string
 * in the database carries three fields mashed together. Rendered raw it reads
 * "…under one orthopedician, — Unassigned", and since the extractor resolves most owners to
 * "Unassigned", that noise was on nearly every line of the worklist.
 *
 * Parsed here rather than fixed at the source on purpose: `itemKey` hashes the stored content to
 * decide which boxes are ticked, so changing the stored format would silently untick every item
 * the user had worked through. The data stays; only the presentation changes.
 */
export function splitAction(content: string): {
  text: string;
  owner: string | null;
  due: string | null;
} {
  // lastIndexOf, because the suffix is appended last and the sentence may contain a dash itself.
  const at = content.lastIndexOf(' — ');
  if (at < 0) return { text: content.trim(), owner: null, due: null };

  const text = content.slice(0, at).trim();
  let tail = content.slice(at + 3).trim();
  let due: string | null = null;

  const m = tail.match(/\s*\((due[^)]*)\)$/i);
  if (m && m.index !== undefined) {
    due = m[1].trim();
    tail = tail.slice(0, m.index).trim();
  }
  // "Unassigned" is the extractor's way of saying it could not tell. Saying nothing is the same
  // information without the noise.
  const owner = tail && !/^unassigned$/i.test(tail) ? tail : null;
  return { text, owner, due };
}

/**
 * Capitalise the opening letter.
 *
 * Extraction cuts at sentence boundaries the ASR did not always get right, so items routinely
 * begin mid-clause and lowercase ("the patient party that this is an orthopedic case"). Only the
 * first character is touched — the words are quoted from the meeting and stay as they were said.
 */
export function sentenceCase(text: string): string {
  const t = text.trimStart();
  if (!t) return text;
  return t[0].toUpperCase() + t.slice(1);
}

export type ProseBlock = { kind: 'p' | 'li'; text: string };

/**
 * Split a generation into paragraphs and list items.
 *
 * The model writes bullets as literal "- " lines, and a single `<Text>` renders those as stray
 * dashes with no indent — the marker sits inline with the words and every item runs together.
 * Splitting them out lets the list be set as a list. Consecutive plain lines are joined into one
 * paragraph, because a hard-wrapped line is not a new thought.
 */
export function parseProse(src: string): ProseBlock[] {
  const out: ProseBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      out.push({ kind: 'p', text: para.join(' ') });
      para = [];
    }
  };
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const li = line.match(/^[-*•]\s+(.*)$/);
    if (li) {
      flush();
      out.push({ kind: 'li', text: li[1].trim() });
      continue;
    }
    para.push(line);
  }
  flush();
  return out;
}

/**
 * Long-form model output, set as paragraphs and lists rather than one undifferentiated block.
 *
 * `color` is explicit rather than taken from the theme: on the Summary tab this sits on a purple
 * card, and Txt falls back to the theme's ink — near-black — when it is not told otherwise.
 */
export function Prose({
  text,
  colors,
  color,
}: {
  text: string;
  colors: Colors;
  color?: string;
}) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const blocks = React.useMemo(() => parseProse(text), [text]);
  const ink = color ?? colors.ink;
  return (
    <View style={st.prose}>
      {blocks.map((b, i) =>
        b.kind === 'li' ? (
          <View key={i} style={st.li}>
            <View style={[st.dot, { backgroundColor: color ?? colors.primary, opacity: color ? 0.7 : 1 }]} />
            <Txt variant="prose" color={ink} style={st.flex}>
              {b.text}
            </Txt>
          </View>
        ) : (
          <Txt key={i} variant="prose" color={ink}>
            {b.text}
          </Txt>
        ),
      )}
    </View>
  );
}

/**
 * One extracted item in the MOM document.
 *
 * Deliberately quieter than the card it replaced. That one gave every item a 38px icon tile, a
 * badge and its own tilted raised card — fine for the three items the design was drawn against,
 * and card soup at the twenty-nine this meeting produces. A coloured rule carries the same kind
 * information in a fraction of the ink, and the eye can run down the column.
 */
export function DocItem({ m, colors }: { m: Minute; colors: Colors }) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const meta = kindMeta(m.kind, colors);
  const { text, owner, due } = splitAction(m.content);
  return (
    <View style={st.docRow}>
      <View style={[st.rule, { backgroundColor: meta.color }]} />
      <View style={st.flex}>
        <Txt variant="prose">{sentenceCase(text)}</Txt>
        {owner || due ? (
          <Txt variant="chipSoft" color={colors.inkDim} style={st.meta}>
            {[owner, due].filter(Boolean).join(' · ')}
          </Txt>
        ) : null}
      </View>
    </View>
  );
}

/** Section heading used down the length of every tab. */
export function SectionHead({
  label,
  count,
  colors,
  style,
}: {
  label: string;
  count?: number;
  colors: Colors;
  style?: object;
}) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[st.head, style]}>
      <Txt variant="overlineSm" color={colors.inkFaint}>
        {label}
      </Txt>
      {count !== undefined ? (
        <Txt variant="overlineSm" color={colors.inkFaint}>
          {count}
        </Txt>
      ) : null}
    </View>
  );
}

/** A card with nothing in it yet, said plainly rather than left blank. */
export function Empty({ text, colors }: { text: string; colors: Colors }) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  return (
    <Raised edge={colors.line} fill={colors.card} rad={radius.card24} depth={4}>
      <View style={st.empty}>
        <Icon name="list" size={s(22)} color={colors.inkFaint} strokeWidth={2.4} />
        <Txt variant="body" color={colors.inkSoft} style={st.emptyText}>
          {text}
        </Txt>
      </View>
    </Raised>
  );
}

function makeStyles(_c: Colors) {
  return StyleSheet.create({
    flex: { flex: 1 },
    prose: { gap: s(12) },
    li: { flexDirection: 'row', gap: s(10), alignItems: 'flex-start' },
    // Nudged down onto the first line's optical centre rather than its box top.
    dot: { width: s(6), height: s(6), borderRadius: s(3), marginTop: s(10) },
    docRow: { flexDirection: 'row', gap: s(12), alignItems: 'stretch' },
    rule: { width: s(3), borderRadius: s(2) },
    meta: { marginTop: s(4) },
    head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    empty: { padding: s(22), alignItems: 'center', gap: s(8) },
    emptyText: { textAlign: 'center' },
  });
}
