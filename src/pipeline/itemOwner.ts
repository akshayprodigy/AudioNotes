// Who owns an action, resolved from the speaker row rather than from the words stored with it.
//
// The rule pass bakes the owner into the item's text ("Send the report — Speaker 1 (due by
// Thursday)") and that text must not change: ticks, hand corrections and the Reconciler's matching
// all read it. So a speaker rename left every surface showing the old name. The owner is recorded
// as `items.owner_json = {kind:'speaker', id}` (the shape the Pro classifier already writes; the
// rule pass writes it too, see AudioDb.replaceItems / adoptRuleOwners) and the speaker's CURRENT
// name is put into the text at read time, on every surface.
//
// Kotlin twin: pipeline/ItemOwner.kt. Both are held to the same vectors.
//
// What it never does: rewrite a name that is not a speaker. "<Name> will …" leaves a person's name
// in the text with no speaker behind it, and a hand-typed owner is a person's own words — neither
// has an owner_json pointing at a speaker, so both stay exactly as stored.
import type { Speaker } from './types';

/** Speaker id to the name they carry now. A missing or blank name resolves to nothing. */
export type OwnerNames = ReadonlyMap<string, string | null | undefined>;

export function namesOf(speakers: readonly Pick<Speaker, 'id' | 'displayName'>[]): OwnerNames {
  return new Map(speakers.map(s => [s.id, s.displayName]));
}

const SEP = ' — ';
const DUE_TAIL = /\s*(\(due[^)]*\))$/i;

/** The speaker an owner_json points at, or null for a person, unassigned, nothing, or junk. */
export function ownerSpeakerId(ownerJson: string | null | undefined): string | null {
  if (!ownerJson) return null;
  try {
    const o = JSON.parse(ownerJson);
    return o && o.kind === 'speaker' && typeof o.id === 'string' && o.id ? o.id : null;
  } catch {
    return null;
  }
}

function currentName(ownerJson: string | null | undefined, names: OwnerNames): string | null {
  const id = ownerSpeakerId(ownerJson);
  if (!id) return null;
  const n = names.get(id)?.trim();
  return n ? n : null;
}

/**
 * The stored text with its owner replaced by the speaker's current name — when owner_json names
 * a speaker we still have a name for. Anything else comes back untouched.
 */
export function resolveOwnerText(
  content: string,
  ownerJson: string | null | undefined,
  names: OwnerNames,
): string {
  const name = currentName(ownerJson, names);
  if (!name) return content;
  const at = content.lastIndexOf(SEP);
  if (at < 0) return `${content.trim()}${SEP}${name}`;
  const body = content.slice(0, at).trim();
  let tail = content.slice(at + SEP.length).trim();
  let due = '';
  const m = tail.match(DUE_TAIL);
  if (m && m.index !== undefined) {
    due = ` ${m[1]}`;
    tail = tail.slice(0, m.index).trim();
  }
  if (tail === name) return content;
  return `${body}${SEP}${name}${due}`;
}

/**
 * The label the Review queue shows for an owner. Resolved live from the speaker row; a person the
 * classifier named stays a name; no owner is "No owner".
 */
export function ownerLabel(ownerJson: string | null, speakers: readonly Pick<Speaker, 'id' | 'displayName'>[]): string {
  try {
    const o = ownerJson ? JSON.parse(ownerJson) : null;
    if (!o || o.kind === 'unassigned') return 'No owner';
    if (o.kind === 'speaker') return speakers.find(x => x.id === o.id)?.displayName ?? 'A speaker';
    return String(o.name ?? 'Someone');
  } catch {
    return 'No owner';
  }
}

/**
 * After a person edits an action's text: the owner_json that keeps the record honest, or null for
 * "leave it". If the row points at a speaker and the owner now typed is not that speaker's name,
 * the person has re-assigned it by hand and the speaker link must go — otherwise the next
 * resolve would overwrite their words with the speaker's name.
 */
export function ownerAfterEdit(
  ownerJson: string | null | undefined,
  speakerName: string | null | undefined,
  editedText: string,
): string | null {
  if (!ownerSpeakerId(ownerJson)) return null;
  const at = editedText.lastIndexOf(SEP);
  let typed = at < 0 ? '' : editedText.slice(at + SEP.length).trim();
  typed = typed.replace(DUE_TAIL, '').trim();
  if (/^unassigned$/i.test(typed)) typed = '';
  const same = speakerName ? typed.toLowerCase() === speakerName.trim().toLowerCase() : false;
  if (same) return null;
  return typed ? JSON.stringify({ kind: 'person', name: typed }) : JSON.stringify({ kind: 'unassigned' });
}

/**
 * A search snippet of an item or minute without the extractor's " — Unassigned" tail.
 *
 * "Unassigned" is the extractor's way of saying it could not tell, and a search row reading
 * "… Friday — Unassigned" is noise on nearly every action. FTS match markers (U+0002/U+0003) may
 * sit around the word when the query was "unassigned"; they go with it.
 */
export function stripUnassigned(snippet: string): string {
  return snippet.replace(/\s*—\s*[\u0002\u0003]*Unassigned[\u0002\u0003]*/gi, '');
}
