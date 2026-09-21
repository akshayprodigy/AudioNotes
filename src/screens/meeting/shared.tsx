import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Icon, { type IconName } from '../../components/Icon';
import { Raised, Txt } from '../../components/ui';
import { radius, s, type Colors } from '../../theme';
import { MINUTE_SOURCE_USER, USER_GEN } from '../../pipeline/types';
import { labelsFor, type Labels, type RecordSummary } from './recordLabels';
import type { Edit, EditTarget, Item, ItemKind, Minute } from '../../pipeline/types';

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
 * A stable key for one extracted item.
 *
 * NOT the minutes row id: those are deleted and re-inserted every time a meeting is reprocessed or
 * its speakers are merged, so keying on them would silently uncheck everything the user had worked
 * through. Normalised text survives all of that, and changes only when the wording does — which is
 * the case where an unticked box is the right answer anyway.
 *
 * It lives here rather than in ActionsTab now that a second feature depends on it: a hand-written
 * correction of a minute is stored against this same key, so an edit and the tick it belongs to
 * are anchored to exactly the same thing and survive a reprocess together. ActionsTab re-exports
 * it under the name the existing test imports.
 */
export function itemKey(content: string): string {
  const norm = content.trim().toLowerCase().replace(/\s+/g, ' ');
  let h = 0;
  for (let i = 0; i < norm.length; i++) {
    h = (h * 31 + norm.charCodeAt(i)) | 0;
  }
  return `${norm.length}:${h}`;
}

/**
 * The text a minute row actually holds.
 *
 * `minutes.content_json` stores a plain string — the native writer, the export renderer and
 * `db.replaceMinutes` all treat it that way — and `db.addUserMinute` now does too. This unwrap
 * stays for the rows written while it did not: a hand-written item added on a build between the
 * two came back wrapped in its own quotation marks, and there is no migration worth writing for
 * it. It cannot damage anything else — text that was never encoded, and an encoded value that
 * does not decode to a string, both fall straight through.
 */
export function minuteText(m: Minute): string {
  const raw = m.content ?? '';
  if (raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(raw);
      if (typeof decoded === 'string') return decoded;
    } catch {
      // Not JSON after all, and a quoted sentence is perfectly ordinary text.
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------------------------
// What the item tabs actually render
// ---------------------------------------------------------------------------------------------

/** The three kinds a decision/action/question tab renders. `summary`/`narrative` are documents. */
export type ItemRowKind = ItemKind;

/**
 * The kinds that live in `items`, as a runtime list.
 *
 * Exported because MeetingScreen's add path routes on exactly this set — a typed decision, action
 * or question becomes an `items` row through `db.addUserItem`, and a typed summary, narrative or
 * headline stays prose in `minutes` — and a second list written out there is a list that drifts
 * from this one. `ItemKind` is the type of the same statement, and `FileExportModule.ITEM_KINDS`
 * is the Kotlin mirror.
 */
export const ITEM_KINDS: readonly ItemKind[] = ['decision', 'action', 'question'];

/**
 * Whether this kind belongs in `items`, as a type guard rather than a boolean.
 *
 * A GUARD AND NOT A PREDICATE, deliberately. `db.addUserItem` takes an [ItemKind] and
 * `db.addUserMinute` takes a `MinuteKind`, and the whole split is that prose — `summary`,
 * `narrative`, `headline` — must not reach the first. Written as `ITEM_KINDS.includes(k as
 * ItemKind)` the cast throws that away and a caller that routed every add to `addUserItem`
 * compiles cleanly, which is exactly what happened when this was measured: the mutation survived
 * every test in the tree, because nothing in the app adds prose by hand YET and so no test could
 * reach the branch. Narrowing makes the compiler the test.
 */
export const isItemKind = (kind: string): kind is ItemKind =>
  (ITEM_KINDS as readonly string[]).includes(kind);

/**
 * One line on the MOM or Actions tab, from whichever table currently holds it.
 *
 * The tabs used to render `minutes` rows, which carry no id a tick can survive a reprocess on and
 * no timestamp at all. They render `items` now — that is what makes the provenance button
 * possible, and what puts this tab's ticks in the same store as the cross-meeting worklist's. ONE
 * population is still not in `items`, and this type is what lets one renderer show it alongside:
 * every row of a meeting whose item migration has not run — see [toItemRows]. A row somebody
 * TYPED was the second such population until Task 12 moved it across.
 *
 * `itemId` is the whole difference. A row that has one is ticked in `item_done` and corrected in
 * `edits` by its id, so both survive the wording changing under it; a row that has none has no id
 * worth keying on and keeps the text hash it has always had, for both. Read `itemId === null` as
 * "this row is not in `items` yet", never as "this row is the user's" — `mine` says that, and a
 * hand-typed row now has both.
 */
export type ItemRow = {
  /** React key. Namespaced by table, because the two id spaces are unrelated. */
  key: string;
  kind: ItemRowKind;
  /** What to show, and what an edit prompt starts from. Never what a key is computed on. */
  text: string;
  /**
   * [itemKey] of the row's STORED string — which is not always what [text] shows; see [toItemRows].
   *
   * The key of everything that CANNOT be keyed on an id: the `action_done` tick of a row with no
   * item, and its `edits` row. Not the edits key for a row that HAS an item — that one is keyed on
   * the id, which is what [editTargetOf] is for, and reaching for this field instead is how a
   * correction gets written where nothing will look for it.
   */
  textKey: string;
  /** The `items` row id, or null for a row that is still only a minute. */
  itemId: string | null;
  /**
   * The `minutes` row id, or null.
   *
   * Only an unmigrated meeting's rows have one now. Removal dispatches on it — a hand-typed row
   * is deleted from `items` by [ItemRow.itemId] and a hand-typed minute from `minutes` by this —
   * which is why `MeetingScreen.onRemoveRow` takes the whole row and not an id.
   */
  minuteId: string | null;
  /** Typed by a person rather than pulled out of the transcript. */
  mine: boolean;
  /** When it was said, or null for a row that never claimed to have been said at all. */
  anchorStartMs: number | null;
  /** The typed record's visible part, or null until the Pro classifier has read the item. */
  record: RecordSummary | null;
};

/**
 * Merge the two tables into one list of rows, items first.
 *
 * **The hand-typed half of the merge is gone as of Task 12.** A decision, action or question a
 * person types is an `items` row now (`db.addUserItem`), and `AudioDb.carryUserMinutesOntoItems`
 * has moved the ones already on disk and deleted the `minutes` rows they came from. So a
 * source='user' minute is no longer merged back in: it either does not exist, or it belongs to a
 * meeting whose migration has not run, and the fallback below is what shows it then.
 *
 * **The empty-items fallback stays, and it goes when nothing can render an unmigrated meeting.**
 * `db.ensureItems` is what gives a pre-items meeting its items, it needs the native core, and
 * MeetingScreen deliberately swallows the failure so the meeting still opens. It opens onto its
 * `minutes`, which is what a person has always seen there; rendering items alone would draw an
 * empty MOM tab under a Summary tab still counting "7 actions". It costs a boolean, it is
 * self-healing on the next open, and the alternative is showing somebody nothing.
 *
 * IT ASKS ABOUT RULE ROWS, NOT ABOUT ROWS, and that is the half Task 12 could most easily have got
 * wrong. `carryUserMinutesOntoItems` runs before the native load — deliberately, so a phone still
 * downloading `its models` does not open a meeting with the person's own notes missing — so
 * an unmigrated meeting somebody typed a decision into arrives here with EXACTLY ONE item, the
 * typed one, and all of its rule-extracted rows still in `minutes`. Under "does this meeting have
 * any items at all" the fallback switches off at that moment and the whole MOM disappears, leaving
 * the one line they typed. Nothing throws, nothing is deleted, and it heals only if the native
 * core loads. `AudioDb.ensureItems` and `AudioDb.UNMIGRATED` ask the same narrowed question, for
 * the same reason — a hand-typed row is not evidence that the rules have run.
 *
 * The fallback gives its rows a null `anchorStartMs` and no `itemId`, which is the honest answer
 * rather than a placeholder: a row with no evidence gets no provenance button — "an item with no
 * sources is not a failure to find evidence; it is an item that never claimed any" — and a row
 * with no stable id keeps the tick key it already has.
 *
 * WHERE A CORRECTION TO ONE OF THESE ROWS LIVES: [editTargetOf], not [ItemRow.textKey].
 */
export function toItemRows(items: Item[], minutes: Minute[]): ItemRow[] {
  const rows: ItemRow[] = items.map(it => ({
    key: `i:${it.id}`,
    kind: it.kind,
    text: it.text,
    textKey: itemKey(it.text),
    itemId: it.id,
    minuteId: null,
    // `gen_version`, which is the authoritative marker and the one Reconciler rule 1 keys on —
    // never "did this row come out of `minutes`". db.addUserItem is what writes it.
    mine: it.genVersion === USER_GEN,
    // Already null for a hand-typed row: db.items derives it there, at the database boundary, so
    // nothing here has to know that the column is NOT NULL and holds a sentinel.
    anchorStartMs: it.anchorStartMs,
    record: it.itemType ? { itemType: it.itemType, status: it.status, dateNorm: it.dateNorm } : null,
  }));

  // "Have the RULES produced items for this meeting" — see the note above for why it is not
  // "does this meeting have items".
  const unmigrated = !items.some(it => it.genVersion !== USER_GEN);
  for (const m of minutes) {
    if (!isItemKind(m.kind)) continue;
    if (!unmigrated) continue;
    rows.push({
      key: `m:${m.id}`,
      kind: m.kind,
      // minuteText for the display, m.content for the key. They differ only for a hand-written row
      // added on the one build that JSON-encoded them (see minuteText), and the key has to stay on
      // the raw column because the export renderer hashes that column in Kotlin.
      text: minuteText(m),
      textKey: itemKey(m.content),
      itemId: null,
      minuteId: m.id,
      // MINUTE_SOURCE_USER, not USER_GEN. Two vocabularies, two constants — see the constant.
      mine: m.source === MINUTE_SOURCE_USER,
      anchorStartMs: null,
      record: null,
    });
  }
  return rows;
}

/**
 * Where a correction to this row is stored.
 *
 * A row with an item is keyed on `items.id`, and that is the point of the whole move: an id
 * survives the text being rewritten, so a correction now outlives a reprocess that changes a word
 * — the same property `item_done` gives a tick, and one no hash of the text can have, because the
 * hash moves with the text.
 *
 * A row with no item keeps `minute/<hash of its stored text>`, because it has nothing else to be
 * keyed on. That population is every row of a meeting whose migration has not run, and nothing
 * else: a row somebody typed themselves left it in Task 12, which gave it an item of its own.
 *
 * BOTH SIDES MOVED TOGETHER, and they had to. The reader here, the writer in
 * `MeetingScreen.onEditRow`, and `FileExportModule` in Kotlin all agree on this key; changing one
 * of them alone loses every correction in whichever direction it goes, silently, because `edits`
 * has a foreign key to `meetings` and none to `items` — an unmatched join returns nothing and
 * nothing errors. `AudioDb.carryEditsOntoItems` is what moves the rows every shipped build wrote.
 */
export function editTargetOf(row: ItemRow): { kind: EditTarget; key: string } {
  return row.itemId
    ? { kind: 'item', key: row.itemId }
    : { kind: 'minute', key: row.textKey };
}

// ---------------------------------------------------------------------------------------------
// User edits, overlaid at render
// ---------------------------------------------------------------------------------------------

/**
 * Hand corrections, ready to look up.
 *
 * Edits are a SIDE table on purpose (see db.putEdit): the pipeline's own text is never rewritten,
 * because action ticks are hashed on it and a rewrite would untick everything the user had worked
 * through. The consequence for the screen is that every place which shows pipeline text has to ask
 * for the edit first — this map is that question, made cheap enough to ask once per row.
 */
export type EditMap = Map<string, string>;

export const editKey = (kind: EditTarget, key: string) => `${kind}/${key}`;

/**
 * The target key for whole-document edits.
 *
 * `summary` and `narrative` have exactly one instance per meeting, so the kind already identifies
 * the thing and the key has nothing left to say. Named rather than written inline because the
 * export renderer mirrors it in Kotlin — the document a person sends to a client must carry their
 * corrections, and that only works if both sides agree on the key.
 */
export const DOC_KEY = 'doc';

export function toEditMap(edits: Edit[]): EditMap {
  return new Map(edits.map(e => [editKey(e.targetKind, e.targetKey), e.content]));
}

/**
 * The edit if there is one, the original otherwise.
 *
 * An edit wins even where there is no original at all: a summary someone typed by hand on a phone
 * that cannot run the model is still the summary of that meeting, and withholding it because no
 * model wrote one would be absurd.
 */
export function editedText(
  edits: EditMap,
  kind: EditTarget,
  key: string,
  original?: string,
): string | undefined {
  return edits.get(editKey(kind, key)) ?? original;
}

export function isEdited(edits: EditMap, kind: EditTarget, key: string): boolean {
  return edits.has(editKey(kind, key));
}

/**
 * The mark on anything a person has changed by hand, with the way back.
 *
 * Shown rather than left implicit because the reader has to be able to tell the meeting's own
 * record from their own corrections — that distinction is the whole reason edits are stored
 * separately — and because an edit with no visible way to undo it is a trap: the original text is
 * still there in the database, and one tap should be enough to see it again.
 */
export function EditedTag({
  colors,
  onRevert,
  tone,
}: {
  colors: Colors;
  onRevert?: () => void;
  /** Set on tinted cards, where the theme's faint ink disappears into the fill. */
  tone?: string;
}) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const ink = tone ?? colors.inkFaint;
  return (
    <View style={st.editedRow}>
      <Txt variant="overlineSm" color={ink}>
        EDITED BY YOU
      </Txt>
      {onRevert ? (
        <Pressable
          onPress={onRevert}
          accessibilityRole="button"
          accessibilityLabel="Undo this edit and show the original text"
          hitSlop={s(10)}
          style={st.revert}>
          <Icon name="undo" size={s(13)} color={ink} strokeWidth={2.6} />
          <Txt variant="overlineSm" color={ink}>
            REVERT
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The mark on an item a person added themselves, with the way to remove it.
 *
 * The counterpart to [EditedTag], and shown for the same reason: the reader has to be able to tell
 * the meeting's own record from what they added to it. Removal lives here rather than behind a
 * long-press because these rows have no original to fall back to — deleting one is the only way
 * out, so it cannot be hidden.
 */
export function MineTag({
  colors,
  onRemove,
  tone,
}: {
  colors: Colors;
  onRemove?: () => void;
  tone?: string;
}) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const ink = tone ?? colors.inkFaint;
  return (
    <View style={st.editedRow}>
      <Txt variant="overlineSm" color={ink}>
        ADDED BY YOU
      </Txt>
      {onRemove ? (
        <Pressable
          onPress={onRemove}
          accessibilityRole="button"
          accessibilityLabel="Remove this item"
          hitSlop={s(10)}
          style={st.revert}>
          <Icon name="trash" size={s(13)} color={ink} strokeWidth={2.6} />
          <Txt variant="overlineSm" color={ink}>
            REMOVE
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

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
 * the user had worked through. The data stays; only the presentation changes. Items a person types
 * themselves are composed back into this same format (see composeAction) for exactly that reason.
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
 * Build the stored form of an action out of the three things a person typed.
 *
 * The inverse of splitAction, and it exists so a hand-written item is stored in the SAME shape the
 * extractor writes. One format in the table means one parser at render, one export renderer and
 * one tick key — an item you typed behaves exactly like an item the meeting produced. "Unassigned"
 * is written out when there is a due date but no owner, because the date is parsed off the end of
 * that suffix and without it there is nothing to parse.
 */
export function composeAction(text: string, owner?: string, due?: string): string {
  const body = text.trim();
  const who = (owner ?? '').trim();
  // The extractor's dates always read "due …", and splitAction only recognises them that way, so a
  // bare "Friday" is given the word rather than being silently dropped at the next render.
  const when = (due ?? '').trim().replace(/^due\b\s*/i, '');
  if (!who && !when) return body;
  const suffix = who || 'Unassigned';
  return when ? `${body} — ${suffix} (due ${when})` : `${body} — ${suffix}`;
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
 *
 * Correcting a line is a long-press rather than a pencil per row for the same reason: at
 * twenty-nine items a column of pencils IS the card soup, in a smaller size. The tab says the
 * gesture exists in a line above the list, and the accessibility action offers the same thing to
 * anyone who cannot make a long-press.
 */
/**
 * What a typed item wears: its type, a status when a later turn changed it, the pinned day.
 * Nothing at all for an unclassified row — a free-tier item never grows labels it did not earn.
 */
export function RecordChips({ labels, colors }: { labels: Labels; colors: Colors }) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  if (!labels.type && !labels.status && !labels.day) return null;
  return (
    <>
      {labels.type ? (
        <View style={[st.recordChip, { backgroundColor: colors.primarySoft }]} accessibilityLabel={labels.type}>
          <Txt variant="chipSm" color={colors.primary}>
            {labels.type}
          </Txt>
        </View>
      ) : null}
      {labels.status ? (
        <View style={[st.recordChip, { backgroundColor: colors.warningSoft }]} accessibilityLabel={labels.status}>
          <Txt variant="chipSm" color={colors.warning}>
            {labels.status}
          </Txt>
        </View>
      ) : null}
      {labels.day ? (
        <View style={[st.recordChip, { backgroundColor: colors.cardAlt }]} accessibilityLabel={`→ ${labels.day}`}>
          <Txt variant="chipSm" color={colors.inkSoft}>
            → {labels.day}
          </Txt>
        </View>
      ) : null}
    </>
  );
}

export function DocItem({
  kind,
  colors,
  content,
  edited,
  mine,
  onEdit,
  onRevert,
  onRemove,
  provenance,
  labels,
}: {
  kind: string;
  colors: Colors;
  /** The text to show — the user's correction where there is one. */
  content: string;
  edited?: boolean;
  /** This row was typed by the user rather than pulled out of the transcript. */
  mine?: boolean;
  onEdit?: () => void;
  onRevert?: () => void;
  onRemove?: () => void;
  /** The way back to the moment it was said. Absent on a row that never claimed one. */
  provenance?: React.ReactNode;
  /** The typed record's chips (labelsFor). Empty for an unclassified row. */
  labels?: Labels;
}) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const meta = kindMeta(kind, colors);
  const { text, owner, due } = splitAction(content);
  const lab = labels ?? {};
  const wears = Boolean(lab.type || lab.status || lab.day);
  const body = (
    <View style={st.docRow}>
      <View style={[st.rule, { backgroundColor: meta.color }]} />
      <View style={st.flex}>
        <Txt variant="prose">{sentenceCase(text)}</Txt>
        {owner || due || provenance || wears ? (
          <View style={st.metaRow}>
            {owner || due ? (
              <Txt variant="chipSoft" color={colors.inkDim}>
                {[owner, due].filter(Boolean).join(' · ')}
              </Txt>
            ) : null}
            <RecordChips labels={lab} colors={colors} />
            {provenance}
          </View>
        ) : null}
        {/* At most one of the two: a hand-written row has no original to revert TO, so the mark
            it carries is "you added this", with removal rather than revert behind it. */}
        {mine ? (
          <MineTag colors={colors} onRemove={onRemove} />
        ) : edited ? (
          <EditedTag colors={colors} onRevert={onRevert} />
        ) : null}
      </View>
    </View>
  );
  if (!onEdit) return body;
  return (
    <Pressable
      onLongPress={onEdit}
      accessibilityRole="button"
      accessibilityLabel={text}
      accessibilityHint="Long press to correct this line"
      accessibilityActions={[{ name: 'longpress', label: 'Correct this line' }]}
      onAccessibilityAction={e => {
        if (e.nativeEvent.actionName === 'longpress') onEdit();
      }}>
      {body}
    </Pressable>
  );
}

/** Section heading used down the length of every tab. */
export function SectionHead({
  label,
  count,
  colors,
  style,
  right,
}: {
  label: string;
  count?: number;
  colors: Colors;
  style?: object;
  /** A control belonging to this section — the Edit affordance on the written minutes, say. */
  right?: React.ReactNode;
}) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  return (
    <View style={[st.head, style]}>
      <Txt variant="overlineSm" color={colors.inkFaint}>
        {label}
      </Txt>
      {right ?? null}
      {count !== undefined ? (
        <Txt variant="overlineSm" color={colors.inkFaint}>
          {count}
        </Txt>
      ) : null}
    </View>
  );
}

/**
 * A small icon-and-label control for the tab furniture — copy, edit, add.
 *
 * Quieter than SoftButton, which is a full-width pill and would dominate a card header. These sit
 * in a row at the head or foot of a section and are meant to be found when looked for rather than
 * to compete with the meeting's own words.
 */
export function ToolButton({
  icon,
  label,
  onPress,
  colors,
  tone,
  hint,
}: {
  icon: IconName;
  label: string;
  onPress: () => void;
  colors: Colors;
  tone?: string;
  hint?: string;
}) {
  const st = React.useMemo(() => makeStyles(colors), [colors]);
  const ink = tone ?? colors.primary;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      hitSlop={s(8)}
      style={({ pressed }) => [st.tool, { opacity: pressed ? 0.55 : 1 }]}>
      <Icon name={icon} size={s(15)} color={ink} strokeWidth={2.6} />
      <Txt variant="chip" color={ink}>
        {label}
      </Txt>
    </Pressable>
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
    recordChip: { paddingHorizontal: s(8), paddingVertical: s(3), borderRadius: s(8) },
    docRow: { flexDirection: 'row', gap: s(12), alignItems: 'stretch' },
    rule: { width: s(3), borderRadius: s(2) },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: s(10),
      marginTop: s(4),
    },
    head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
    empty: { padding: s(22), alignItems: 'center', gap: s(8) },
    emptyText: { textAlign: 'center' },
    editedRow: { flexDirection: 'row', alignItems: 'center', gap: s(12), marginTop: s(6) },
    revert: { flexDirection: 'row', alignItems: 'center', gap: s(4) },
    tool: { flexDirection: 'row', alignItems: 'center', gap: s(6), paddingVertical: s(4) },
  });
}
