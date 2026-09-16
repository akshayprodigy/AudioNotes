# Speaker Repair — Implementation Plan

> **SHIPPED 16 Sep 2026.** All eight tasks done; device-verified on the Pixel 7 Pro (spec §"Device verification").

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Change who said a line, a run of lines, or a whole turn from the Script — including "someone new" — and keep those corrections when diarization runs again.

**Architecture:** A reassignment writes `utterances.speaker_id` through (every reader sees it) and records itself in `edits` as `target_kind = 'speaker'`. `AudioDb.assignSpeakers` protects human-touched speakers and pinned lines, decided by a pure `SpeakerRepair` object. On the screen, long-press opens a two-action sheet; a `SpeakerPicker` sheet lists speakers, "Someone new", and three scope chips; `linesForScope` (pure) turns a scope into line ids.

**Tech Stack:** Kotlin (AudioDb, pure object + JUnit), TypeScript/React Native (jest + react-test-renderer), the existing `Sheet`, `TextPrompt`, `edits` and `speakers` tables.

Spec: `docs/superpowers/specs/2026-09-16-speaker-repair-design.md`.

**House rule:** every new test is mutation-checked. Never run a mutation-restore in the background.

---

## File map

| File | Responsibility |
|---|---|
| `android/.../data/SpeakerRepair.kt` (new) | Pure: protected speakers, pinned lines, the edits to re-apply. |
| `android/.../data/AudioDb.kt` | `assignSpeakers` honours the protection; `replaceUtterances` clears speaker edits too. |
| `src/pipeline/types.ts` | `EditTarget` gains `'speaker'`. |
| `src/db/queries.ts` | `setLineSpeaker`, `addSpeaker`. |
| `src/screens/meeting/speakerRepair.ts` (new) | Pure: `linesForScope`, `nextSpeakerName`. |
| `src/screens/meeting/SpeakerPicker.tsx` (new) | The picker sheet: speakers, Someone new, scope chips. |
| `src/screens/meeting/TranscriptTab.tsx` | Long-press → `onLineActions(part, turn)`; turn head → `onReassignTurn(turn)`. |
| `src/screens/MeetingScreen.tsx` | Line-action sheet, picker state, the writes, refresh. |
| Tests | `SpeakerRepairTest.kt`, `speakerRepair.test.ts`, `SpeakerPicker.test.tsx`, `TranscriptTab.test.tsx`, `MeetingScreen.test.tsx`. |

---

### Task 1: SpeakerRepair — the protection rule, pure (Kotlin)

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/data/SpeakerRepair.kt`
- Create: `android/app/src/test/java/com/innocorelabs/verbale/data/SpeakerRepairTest.kt`

- [ ] **Step 1: Failing test**

```kotlin
package com.innocorelabs.verbale.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What re-diarization must leave alone. The defect it guards: assignSpeakers used to delete every
 * speaker row and reassign every line, so a person's renames, new voices and "no, SHE said that"
 * corrections vanished the first time diarization ran again — which it does for any meeting
 * recorded before the speaker models were on the phone.
 */
class SpeakerRepairTest {
  private val machine1 = SpeakerRepair.SpeakerRow("s1", "S0", "Speaker 1")
  private val machine2 = SpeakerRepair.SpeakerRow("s2", "S1", "Speaker 2")
  private val renamed = SpeakerRepair.SpeakerRow("s3", "S2", "Priya")
  private val human = SpeakerRepair.SpeakerRow("s4", "human", "Speaker 4")

  @Test fun aRenamedSpeakerIsProtected() {
    assertEquals(setOf("s3"), SpeakerRepair.protectedIds(listOf(machine1, renamed), emptyMap()))
  }

  @Test fun aHumanCreatedSpeakerIsProtectedEvenWithAMachineLookingName() {
    assertEquals(setOf("s4"), SpeakerRepair.protectedIds(listOf(machine1, human), emptyMap()))
  }

  @Test fun aMachineSpeakerSomebodyAssignedALineToIsProtected() {
    val edits = mapOf("u7" to "s2")
    assertEquals(setOf("s2"), SpeakerRepair.protectedIds(listOf(machine1, machine2), edits))
  }

  @Test fun anUntouchedMachineSpeakerIsNot() {
    assertEquals(emptySet<String>(), SpeakerRepair.protectedIds(listOf(machine1, machine2), emptyMap()))
  }

  @Test fun theMachineNamePatternIsExact() {
    // "Speaker 12" is machine; "Speaker" alone, "speaker 1", "Speaker 1 (Priya)" are a person's.
    assertEquals(true, SpeakerRepair.isMachineName("Speaker 12"))
    assertEquals(false, SpeakerRepair.isMachineName("Speaker"))
    assertEquals(false, SpeakerRepair.isMachineName("speaker 1"))
    assertEquals(false, SpeakerRepair.isMachineName("Speaker 1 (Priya)"))
  }

  @Test fun onlyEditsWhoseSpeakerStillExistsAreReapplied() {
    val edits = mapOf("u1" to "s2", "u2" to "gone")
    assertEquals(mapOf("u1" to "s2"), SpeakerRepair.reapplicable(edits, setOf("s1", "s2")))
  }
}
```

- [ ] **Step 2: Run** — `cd android && ./gradlew :app:testDebugUnitTest --tests '*SpeakerRepairTest*' -q 2>&1 | grep -E "^e:" | head -2` → `Unresolved reference 'SpeakerRepair'`.

- [ ] **Step 3: Implement**

```kotlin
package com.innocorelabs.verbale.data

/**
 * What re-diarization must leave alone.
 *
 * `assignSpeakers` used to delete every speaker row and reassign every line, which was right when
 * nothing but the machine had ever touched them. Once a person has renamed a voice, created one,
 * or said who really spoke a line, the machine's next pass has to work around that — the
 * alternative is a Redo that undoes their afternoon. Pure so the rule is testable off a device;
 * AudioDb does the SQL.
 */
object SpeakerRepair {
  /** A person's own voice, never the clusterer's: `speakers.cluster_label` for db.addSpeaker. */
  const val HUMAN_CLUSTER = "human"

  data class SpeakerRow(val id: String, val clusterLabel: String, val displayName: String)

  private val machineName = Regex("^Speaker [1-9][0-9]*$")

  /** "Speaker 3" and nothing else: the exact shape assignSpeakers writes. Anything else was typed. */
  fun isMachineName(name: String): Boolean = machineName.matches(name)

  /**
   * Speakers that survive a re-clustering: human-created, renamed, or the target of any speaker
   * edit. [edits] is line id → speaker id, the meeting's `target_kind = 'speaker'` rows.
   */
  fun protectedIds(speakers: List<SpeakerRow>, edits: Map<String, String>): Set<String> {
    val referenced = edits.values.toSet()
    return speakers
      .filter { it.clusterLabel == HUMAN_CLUSTER || !isMachineName(it.displayName) || it.id in referenced }
      .map { it.id }
      .toSet()
  }

  /** The lines a person has spoken for; the clusterer may not touch them. */
  fun pinnedLines(edits: Map<String, String>): Set<String> = edits.keys

  /** The edits to write back after re-clustering — those whose speaker row still exists. */
  fun reapplicable(edits: Map<String, String>, survivingSpeakerIds: Set<String>): Map<String, String> =
    edits.filterValues { it in survivingSpeakerIds }
}
```

- [ ] **Step 4: Run — 6 passed.** Mutation-check: change the regex to `^Speaker \\d*$` (accepts "Speaker "): the pattern test still passes on the listed cases — so also assert `isMachineName("Speaker ")` is false in the test; then that mutant fails. Drop `|| it.id in referenced`: the edit-protection test fails. Restore.

- [ ] **Step 5: Commit** — `git commit -m "feat(speakers): SpeakerRepair — what re-diarization must leave alone"`

---

### Task 2: AudioDb honours the protection

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt` (`assignSpeakers` ~660-745; `replaceUtterances` edit clearing ~640)

No JVM test can reach SQLCipher; the device suite has `ItemsDbTest`-style instrumentation tests — add one there in Step 3.

- [ ] **Step 1: Read the protection inside the transaction**, before the `DELETE FROM speakers`:

```kotlin
      // What a person has done to this meeting's speakers, and the lines they have spoken for.
      // The clusterer works around both — see SpeakerRepair.
      val rows = ArrayList<SpeakerRepair.SpeakerRow>()
      db.rawQuery("SELECT id, cluster_label, display_name FROM speakers WHERE meeting_id=?", arrayOf(meetingId)).use { c ->
        while (c.moveToNext()) rows.add(SpeakerRepair.SpeakerRow(c.getString(0), c.getString(1), c.getString(2)))
      }
      val speakerEdits = HashMap<String, String>()
      db.rawQuery(
        "SELECT target_key, content FROM edits WHERE meeting_id=? AND target_kind='speaker'",
        arrayOf(meetingId),
      ).use { c -> while (c.moveToNext()) speakerEdits[c.getString(0)] = c.getString(1) }
      val protected = SpeakerRepair.protectedIds(rows, speakerEdits)
      val pinned = SpeakerRepair.pinnedLines(speakerEdits)
```

Replace `db.execSQL("DELETE FROM speakers WHERE meeting_id=?", …)` with a delete that spares the protected ids (build the placeholder list; when `protected` is empty the old statement stands).

- [ ] **Step 2: Assign only unpinned lines; re-apply the edits.** In the `for (u in utts)` loop: `if (u.id in pinned) continue` before computing overlaps. After the loop:

```kotlin
      // A person's word outranks the clusterer's. Every protected speaker survived the delete
      // above, so every edit is re-applicable; the filter is belt and braces.
      for ((lineId, sid) in SpeakerRepair.reapplicable(speakerEdits, protected + idFor.values)) {
        db.execSQL("UPDATE utterances SET speaker_id=? WHERE id=? AND meeting_id=?", arrayOf<Any?>(sid, lineId, meetingId))
      }
```

The empty-cluster delete stays (a protected speaker with no lines is kept: add `AND id NOT IN (<protected>)` to it). The renumbering loop skips protected ids (their names are theirs); number only the machine survivors — read them with `AND cluster_label != 'human' AND id NOT IN (<protected>)`.

- [ ] **Step 3: `replaceUtterances`** — the re-ASR clear becomes `target_kind IN ('utterance','speaker')` (new line ids orphan both kinds).

- [ ] **Step 4: Device test** (instrumentation, next to `ItemsDbTest`): create a meeting with three utterances and two machine speakers; rename one; put a speaker edit on line 3 pointing at the other; call `assignSpeakers` with clusters that would move everything; assert the renamed speaker's id and name survive, line 3 keeps its edited speaker, the third (untouched) line got a machine speaker. Add the class to `scripts/device-verify.sh`'s `CLASSES` list (the memory's trap: a class not listed never runs).

- [ ] **Step 5: Compile** (`./gradlew :app:compileDebugKotlin -q`), run the Kotlin unit tests; the device test runs in Task 8. Commit — `git commit -m "feat(speakers): re-diarization keeps every speaker a person touched and every line they spoke for"`

---

### Task 3: The JS writes — `setLineSpeaker`, `addSpeaker`, `'speaker'` edits

**Files:**
- Modify: `src/pipeline/types.ts:124` (EditTarget)
- Modify: `src/db/queries.ts` (next to `mergeSpeakers` ~436)
- Create: `src/screens/meeting/speakerRepair.ts`
- Create: `src/screens/__tests__/speakerRepair.test.ts`

- [ ] **Step 1: Failing test** (`speakerRepair.test.ts`)

```ts
import { linesForScope, nextSpeakerName } from '../meeting/speakerRepair';

const turn = { parts: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] };

/** Which lines a reassignment reaches. The split and the merge are both scopes of this. */
describe('linesForScope', () => {
  it('just this line', () => {
    expect(linesForScope(turn, 'b', 'line')).toEqual(['b']);
  });
  it('from here to the end of the turn — the split', () => {
    expect(linesForScope(turn, 'b', 'rest')).toEqual(['b', 'c', 'd']);
    expect(linesForScope(turn, 'd', 'rest')).toEqual(['d']);
    expect(linesForScope(turn, 'a', 'rest')).toEqual(['a', 'b', 'c', 'd']);
  });
  it('the whole turn — the merge', () => {
    expect(linesForScope(turn, 'c', 'turn')).toEqual(['a', 'b', 'c', 'd']);
  });
  it('a line the turn does not hold reaches nothing', () => {
    expect(linesForScope(turn, 'zz', 'rest')).toEqual([]);
    expect(linesForScope(turn, 'zz', 'line')).toEqual([]);
  });
});

/** A blank name for "Someone new" becomes the next machine-style name, never a duplicate. */
describe('nextSpeakerName', () => {
  it('numbers past every existing Speaker N', () => {
    expect(nextSpeakerName(['Speaker 1', 'Speaker 2'])).toBe('Speaker 3');
    expect(nextSpeakerName(['Priya', 'Speaker 4'])).toBe('Speaker 5');
    expect(nextSpeakerName([])).toBe('Speaker 1');
  });
});
```

- [ ] **Step 2: Run — module not found.**

- [ ] **Step 3: Implement** `src/screens/meeting/speakerRepair.ts`:

```ts
/**
 * Which lines a "who said this" change reaches, and what a new voice is called.
 *
 * A turn is consecutive same-speaker lines. Changing the speaker from a line onward splits the
 * turn there; changing a whole turn to its neighbour's speaker merges the two. Neither needs a
 * data shape of its own — only these ids.
 */
export type Scope = 'line' | 'rest' | 'turn';

export function linesForScope(turn: { parts: { id: string }[] }, lineId: string, scope: Scope): string[] {
  const at = turn.parts.findIndex(p => p.id === lineId);
  if (at < 0) return [];
  switch (scope) {
    case 'line':
      return [lineId];
    case 'rest':
      return turn.parts.slice(at).map(p => p.id);
    case 'turn':
      return turn.parts.map(p => p.id);
  }
}

/** "Speaker N" for N one past the highest machine-style name in the meeting. */
export function nextSpeakerName(existing: string[]): string {
  let max = 0;
  for (const name of existing) {
    const m = /^Speaker ([1-9][0-9]*)$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `Speaker ${max + 1}`;
}
```

`types.ts`: `export type EditTarget = 'utterance' | 'minute' | 'item' | 'summary' | 'narrative' | 'speaker';`

`queries.ts`, after `mergeSpeakers`:

```ts
  /**
   * A person says who spoke these lines. Written through to the utterances — every reader sees
   * it with no new code — and recorded as a 'speaker' edit per line, which is what lets
   * re-diarization (AudioDb.assignSpeakers) keep it. See SpeakerRepair.kt.
   */
  setLineSpeaker: async (meetingId: string, lineIds: string[], speakerId: string) => {
    const now = Date.now();
    for (const id of lineIds) {
      await run('UPDATE utterances SET speaker_id = ? WHERE id = ? AND meeting_id = ?', [speakerId, id, meetingId]);
      await run(
        'INSERT OR REPLACE INTO edits(meeting_id, target_kind, target_key, content, edited_at) VALUES(?,?,?,?,?)',
        [meetingId, 'speaker', id, speakerId, now],
      );
    }
  },

  /** A voice diarization never separated. `cluster_label = 'human'` is what protects it from the next clustering. */
  addSpeaker: async (meetingId: string, name: string): Promise<Speaker> => {
    const id = `${meetingId}:speaker:${Date.now()}:${Math.floor(Math.random() * 1e6)}`;
    await run('INSERT INTO speakers(id, meeting_id, cluster_label, display_name) VALUES(?,?,?,?)', [id, meetingId, 'human', name]);
    return { id, meetingId, clusterLabel: 'human', displayName: name };
  },
```

- [ ] **Step 4: Run — 6 passed; tsc clean.** Mutation-check: `rest` → `slice(at + 1)`: fails. `nextSpeakerName` → `max + 2`: fails. Restore.

- [ ] **Step 5: Commit** — `git commit -m "feat(speakers): setLineSpeaker and addSpeaker; the scope arithmetic, pure"`

---

### Task 4: SpeakerPicker — the sheet

**Files:**
- Create: `src/screens/meeting/SpeakerPicker.tsx`
- Create: `src/screens/__tests__/SpeakerPicker.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import SpeakerPicker from '../meeting/SpeakerPicker';

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }));

const speakers = [
  { id: 's1', meetingId: 'm', clusterLabel: 'S0', displayName: 'Speaker 1' },
  { id: 's2', meetingId: 'm', clusterLabel: 'S1', displayName: 'Priya' },
];

async function render(props: Partial<React.ComponentProps<typeof SpeakerPicker>> = {}) {
  const onPick = jest.fn();
  const onNew = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(
      <SpeakerPicker
        visible
        lineText="Sure, after looking at the test results"
        speakers={speakers}
        currentId="s1"
        scopes
        onPick={onPick}
        onNew={onNew}
        onClose={() => {}}
        {...props}
      />,
    );
  });
  return { tree, onPick, onNew };
}

const press = async (tree: renderer.ReactTestRenderer, label: string) => {
  const node = tree.root.findAllByProps({ accessibilityLabel: label }, { deep: false })[0];
  await act(async () => { node.props.onPress(); });
};

describe('SpeakerPicker', () => {
  it('lists every speaker and defaults the scope to just this line', async () => {
    const { tree, onPick } = await render();
    await press(tree, 'Priya');
    expect(onPick).toHaveBeenCalledWith('s2', 'line');
  });

  it('carries the chosen scope', async () => {
    const { tree, onPick } = await render();
    await press(tree, 'From here to the end of the turn');
    await press(tree, 'Priya');
    expect(onPick).toHaveBeenCalledWith('s2', 'rest');
  });

  it('offers someone new', async () => {
    const { tree, onNew } = await render();
    await press(tree, 'The whole turn');
    await press(tree, 'Someone new');
    expect(onNew).toHaveBeenCalledWith('turn');
  });

  it('hides the scope chips for a single-line turn or a turn-head tap', async () => {
    const { tree } = await render({ scopes: false });
    expect(tree.root.findAllByProps({ accessibilityLabel: 'The whole turn' }, { deep: false })).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — module not found.**

- [ ] **Step 3: Implement** `SpeakerPicker.tsx` — a `Modal`-based sheet in the style of `Sheet` (copy its scrim/card structure from `src/components/ui.tsx:345-420`; do not reuse `Sheet` itself, whose rows are fixed to `SheetAction`):

```tsx
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { Speaker } from '../../pipeline/types';
import Icon from '../../components/Icon';
import { Txt } from '../../components/ui';
import { radius, s, useTheme, type Colors } from '../../theme';
import type { Scope } from './speakerRepair';

const SCOPES: { key: Scope; label: string }[] = [
  { key: 'line', label: 'Just this line' },
  { key: 'rest', label: 'From here to the end of the turn' },
  { key: 'turn', label: 'The whole turn' },
];

/**
 * Who said it. One row per speaker, the current one marked, then "Someone new"; three scope chips
 * when the line sits in a turn with company. Splitting and merging turns are both this sheet —
 * see speakerRepair.ts.
 */
export default function SpeakerPicker({
  visible, lineText, speakers, currentId, scopes, onPick, onNew, onClose,
}: {
  visible: boolean;
  lineText: string;
  speakers: Speaker[];
  currentId: string | null;
  /** Show the scope chips (false for a single-line turn or a turn-head tap: the scope is the turn). */
  scopes: boolean;
  onPick: (speakerId: string, scope: Scope) => void;
  onNew: (scope: Scope) => void;
  onClose: () => void;
}) {
  const { colors } = useTheme();
  const st = makeStyles(colors);
  const [scope, setScope] = useState<Scope>(scopes ? 'line' : 'turn');
  useEffect(() => { if (visible) setScope(scopes ? 'line' : 'turn'); }, [visible, scopes]);
  const title = `Who said “${lineText.length > 40 ? lineText.slice(0, 40).trimEnd() + '…' : lineText}”?`;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={st.scrim} onPress={onClose} accessibilityLabel="Dismiss" />
      <View style={[st.card, { backgroundColor: colors.card }]}>
        <Txt variant="sectionTitle">{title}</Txt>
        {scopes ? (
          <View style={st.chips}>
            {SCOPES.map(x => (
              <Pressable
                key={x.key}
                accessibilityRole="button"
                accessibilityLabel={x.label}
                accessibilityState={{ selected: scope === x.key }}
                onPress={() => setScope(x.key)}
                style={[st.chip, { backgroundColor: scope === x.key ? colors.primarySoft : colors.cardAlt, borderColor: scope === x.key ? colors.primary : colors.line }]}>
                <Txt variant="chipSoft" color={scope === x.key ? colors.primary : colors.inkSoft}>{x.label}</Txt>
              </Pressable>
            ))}
          </View>
        ) : null}
        <ScrollView style={st.list}>
          {speakers.map(sp => (
            <Pressable
              key={sp.id}
              accessibilityRole="button"
              accessibilityLabel={sp.displayName}
              accessibilityState={{ selected: sp.id === currentId }}
              onPress={() => onPick(sp.id, scope)}
              style={st.row}>
              <Txt variant="bodyStrong" color={sp.id === currentId ? colors.primary : colors.ink}>{sp.displayName}</Txt>
              {sp.id === currentId ? <Icon name="check" size={s(18)} color={colors.primary} strokeWidth={3} /> : null}
            </Pressable>
          ))}
          <Pressable accessibilityRole="button" accessibilityLabel="Someone new" onPress={() => onNew(scope)} style={st.row}>
            <Icon name="plus" size={s(18)} color={colors.primary} strokeWidth={2.6} />
            <Txt variant="bodyStrong" color={colors.primary}>Someone new</Txt>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}

function makeStyles(c: Colors) {
  return StyleSheet.create({
    scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: c.scrim },
    card: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: s(20), gap: s(14), maxHeight: '70%' },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: s(8) },
    chip: { borderWidth: 1, borderRadius: 999, paddingHorizontal: s(12), paddingVertical: s(7) },
    list: { flexGrow: 0 },
    row: { flexDirection: 'row', alignItems: 'center', gap: s(10), paddingVertical: s(12), borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.line },
  });
}
```

(Check `colors.scrim`, `colors.cardAlt`, `radius.xl` exist — they are used by `Sheet`/`TextPrompt` already.)

- [ ] **Step 4: Run — 4 passed; tsc clean.** Mutation-check: make `onPick` always send `'line'`: the scope test fails. Restore.

- [ ] **Step 5: Commit** — `git commit -m "feat(speakers): SpeakerPicker — who said it, at what scope, or someone new"`

---

### Task 5: The Script's gestures

**Files:**
- Modify: `src/screens/meeting/TranscriptTab.tsx` (props ~150-165; head hint ~226; line Pressable ~290-300; turn head ~317-327)
- Create: `src/screens/__tests__/TranscriptTab.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import TranscriptTab from '../meeting/TranscriptTab';

const utterances = [
  { id: 'u1', meetingId: 'm', startMs: 0, endMs: 2000, speakerId: 's1', text: 'Hello there.' },
  { id: 'u2', meetingId: 'm', startMs: 2500, endMs: 4000, speakerId: 's1', text: 'Second line.' },
  { id: 'u3', meetingId: 'm', startMs: 5000, endMs: 7000, speakerId: 's2', text: 'And a reply.' },
];
const speakers = [
  { id: 's1', meetingId: 'm', clusterLabel: 'S0', displayName: 'Speaker 1' },
  { id: 's2', meetingId: 'm', clusterLabel: 'S1', displayName: 'Speaker 2' },
];

async function render(extra: Record<string, unknown>) {
  let tree!: renderer.ReactTestRenderer;
  await act(async () => {
    tree = renderer.create(<TranscriptTab utterances={utterances as never} speakers={speakers as never} positionMs={0} {...extra} />);
  });
  return tree;
}

/** The two ways into "who said this": the line's long press, and the name at the head of a turn. */
describe('speaker gestures', () => {
  it('long-pressing a line hands over the line and its turn', async () => {
    const onLineActions = jest.fn();
    const tree = await render({ onLineActions });
    const line = tree.root.findAllByProps({ accessibilityLabel: 'Second line.' }, { deep: false })[0];
    await act(async () => { line.props.onLongPress(); });
    expect(onLineActions).toHaveBeenCalledTimes(1);
    const [part, turn] = onLineActions.mock.calls[0];
    expect(part.id).toBe('u2');
    expect(turn.parts.map((p: { id: string }) => p.id)).toEqual(['u1', 'u2']);
  });

  it('tapping the name at the head of a turn hands over the turn', async () => {
    const onReassignTurn = jest.fn();
    const tree = await render({ onReassignTurn });
    const head = tree.root.findAllByProps({ accessibilityLabel: 'Speaker 2 — change who said this' }, { deep: false })[0];
    await act(async () => { head.props.onPress(); });
    expect(onReassignTurn.mock.calls[0][0].parts.map((p: { id: string }) => p.id)).toEqual(['u3']);
  });
});
```

- [ ] **Step 2: Run — fails** (no such props / labels).

- [ ] **Step 3: Implement.** Props: replace `onEditLine?: (id: string, text: string) => void` with

```ts
  /** Long press on a line: the line (id, current text) and the turn it sits in. */
  onLineActions?: (part: { id: string; text: string }, turn: Turn) => void;
  /** Tap on the name at the head of a turn. */
  onReassignTurn?: (turn: Turn) => void;
```

(export `Turn`). The line `Pressable`: `onLongPress={onLineActions ? () => onLineActions({ id: part.id, text }, t) : undefined}`; the guard `if (!onPlayTurn && !onLineActions)`; the hint strings say "Long press to correct it or change who said it." The turn head name becomes a `Pressable` when `onReassignTurn` is given:

```tsx
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${t.who} — change who said this`}
                onPress={onReassignTurn ? () => onReassignTurn(t) : undefined}
                disabled={!onReassignTurn}>
                <Txt variant="chip" color={tint}>{t.who}</Txt>
              </Pressable>
```

- [ ] **Step 4: Run — 2 passed; tsc will now fail in MeetingScreen (prop renamed) — fixed in Task 6.** Mutation-check: pass `t.parts.slice(1)` as the turn: the first test fails. Restore.

- [ ] **Step 5: Commit** (together with Task 6, since tsc is red between them).

---

### Task 6: MeetingScreen — the sheet, the picker, the writes

**Files:**
- Modify: `src/screens/MeetingScreen.tsx` (imports; state near `editing`; the TranscriptTab props ~1110-1131; render the sheet + picker next to the `TextPrompt`s ~1160-1190)
- Test: `src/screens/__tests__/MeetingScreen.test.tsx`

- [ ] **Step 1: Failing test** (add `db.setLineSpeaker`/`db.addSpeaker` stubs to `beforeEach` in both `MeetingScreen.test.tsx` and `ItemProvenance.test.tsx`; the utterances/speakers fixtures as in Task 5)

```tsx
describe('who said this', () => {
  const utts = [
    { id: 'u1', meetingId: 'm1', startMs: 0, endMs: 2000, speakerId: 's1', text: 'Hello there.' },
    { id: 'u2', meetingId: 'm1', startMs: 2500, endMs: 4000, speakerId: 's1', text: 'Second line.' },
  ];
  const spks = [
    { id: 's1', meetingId: 'm1', clusterLabel: 'S0', displayName: 'Speaker 1' },
    { id: 's2', meetingId: 'm1', clusterLabel: 'S1', displayName: 'Speaker 2' },
  ];
  const press = async (tree: renderer.ReactTestRenderer, label: string) => {
    const n = tree.root.findAllByProps({ accessibilityLabel: label }, { deep: false })[0];
    await act(async () => { n.props.onPress(); });
  };

  it('reassigns the whole turn from the line sheet', async () => {
    (db.utterances as jest.Mock).mockResolvedValue(utts);
    (db.speakers as jest.Mock).mockResolvedValue(spks);
    (db.setLineSpeaker as jest.Mock).mockResolvedValue(undefined);
    const tree = await render();
    await act(async () => { tree.root.findAllByProps({ accessibilityLabel: 'Script' }, { deep: false })[0].props.onPress(); });
    const line = tree.root.findAllByProps({ accessibilityLabel: 'Second line.' }, { deep: false })[0];
    await act(async () => { line.props.onLongPress(); });
    await press(tree, 'Change who said it');
    await press(tree, 'The whole turn');
    await press(tree, 'Speaker 2');
    expect(db.setLineSpeaker).toHaveBeenCalledWith('m1', ['u1', 'u2'], 's2');
  });

  it('someone new: adds the speaker, then assigns', async () => {
    (db.utterances as jest.Mock).mockResolvedValue(utts);
    (db.speakers as jest.Mock).mockResolvedValue(spks);
    (db.addSpeaker as jest.Mock).mockResolvedValue({ id: 's9', meetingId: 'm1', clusterLabel: 'human', displayName: 'Rahul' });
    (db.setLineSpeaker as jest.Mock).mockResolvedValue(undefined);
    const tree = await render();
    await act(async () => { tree.root.findAllByProps({ accessibilityLabel: 'Script' }, { deep: false })[0].props.onPress(); });
    const line = tree.root.findAllByProps({ accessibilityLabel: 'Hello there.' }, { deep: false })[0];
    await act(async () => { line.props.onLongPress(); });
    await press(tree, 'Change who said it');
    await press(tree, 'Someone new');
    // The name prompt: type and confirm.
    const input = tree.root.findAllByType(require('react-native').TextInput).find(i => i.props.placeholder === 'Name');
    await act(async () => { input!.props.onChangeText('Rahul'); });
    await press(tree, 'Add');
    expect(db.addSpeaker).toHaveBeenCalledWith('m1', 'Rahul');
    expect(db.setLineSpeaker).toHaveBeenCalledWith('m1', ['u1'], 's9');
  });
});
```

(Check how the tab bar labels its buttons — `findAllByProps({ accessibilityLabel: 'Script' })` assumes the tab Pressable carries that label; adapt to the actual prop if it is `label`.)

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement.** State:

```ts
  /** The line whose long press opened the two-action sheet, with its turn. */
  const [lineSheet, setLineSheet] = useState<{ part: { id: string; text: string }; turn: Turn } | null>(null);
  /** The speaker picker: which lines it is for, and whether scope chips apply. */
  const [picker, setPicker] = useState<{ lineId: string; text: string; turn: Turn; scopes: boolean } | null>(null);
  /** "Someone new" is waiting for a name; remembers the scope chosen before the prompt. */
  const [naming, setNaming] = useState<{ scope: Scope } | null>(null);
```

Handlers:

```ts
  const applySpeaker = useCallback(
    async (speakerId: string, scope: Scope) => {
      if (!picker) return;
      const ids = linesForScope(picker.turn, picker.lineId, scope);
      setPicker(null);
      if (ids.length === 0) return;
      await db.setLineSpeaker(meetingId, ids, speakerId).catch(() => {});
      refresh();
    },
    [picker, meetingId, refresh],
  );
  const onSomeoneNew = useCallback((scope: Scope) => setNaming({ scope }), []);
  const onNamed = useCallback(
    async (name: string) => {
      const scope = naming?.scope ?? 'line';
      setNaming(null);
      const sp = await db.addSpeaker(meetingId, name.trim() || nextSpeakerName(speakers.map(x => x.displayName))).catch(() => null);
      if (sp) await applySpeaker(sp.id, scope);
    },
    [naming, meetingId, speakers, applySpeaker],
  );
```

TranscriptTab props: `onLineActions={(part, turn) => setLineSheet({ part, turn })}` and `onReassignTurn={turn => setPicker({ lineId: turn.parts[0].id, text: turn.parts[0].text, turn, scopes: false })}`. The `onEditLine` prompt config moves into the sheet's first action.

Render, next to the other `Sheet`/`TextPrompt`s:

```tsx
      <Sheet
        visible={lineSheet !== null}
        title={lineSheet ? lineSheet.part.text : undefined}
        actions={[
          { icon: 'edit', label: 'Correct the words', hint: 'Fixes a mis-heard word. The recording is untouched.', onPress: () => { if (!lineSheet) return; setEditing({ title: 'Correct this line', hint: 'Fixes a mis-heard word. The recording is untouched, and you can put the original back.', initial: lineSheet.part.text, multiline: true, target: { kind: 'utterance', key: lineSheet.part.id } }); } },
          { icon: 'users', label: 'Change who said it', hint: 'This line, the rest of the turn, or the whole turn.', onPress: () => { if (!lineSheet) return; setPicker({ lineId: lineSheet.part.id, text: lineSheet.part.text, turn: lineSheet.turn, scopes: lineSheet.turn.parts.length > 1 }); } },
        ]}
        onClose={() => setLineSheet(null)}
      />
      <SpeakerPicker
        visible={picker !== null && naming === null}
        lineText={picker?.text ?? ''}
        speakers={speakers}
        currentId={picker ? utterances.find(u => u.id === picker.lineId)?.speakerId ?? null : null}
        scopes={picker?.scopes ?? false}
        onPick={applySpeaker}
        onNew={onSomeoneNew}
        onClose={() => setPicker(null)}
      />
      <TextPrompt
        visible={naming !== null}
        title="Who is this?"
        hint="A name for a voice the app did not separate. You can rename or merge it later on the Speakers screen."
        initial=""
        placeholder="Name"
        confirmLabel="Add"
        onCancel={() => setNaming(null)}
        onSubmit={onNamed}
      />
```

`Sheet.onPress` already closes the sheet before calling the action (see `ui.tsx:399-402`).

- [ ] **Step 4: Run both MeetingScreen tests and the whole suite; tsc clean.** Mutation-check: in `applySpeaker`, pass `[picker.lineId]` regardless of scope: the whole-turn test fails. Restore.

- [ ] **Step 5: Commit** — `git add src/screens/meeting/TranscriptTab.tsx src/screens/__tests__/TranscriptTab.test.tsx src/screens/MeetingScreen.tsx src/screens/__tests__/MeetingScreen.test.tsx src/screens/__tests__/ItemProvenance.test.tsx && git commit -m "feat(speakers): long-press a line or tap a turn's name to change who said it"`

---

### Task 7: The Speakers screen shows a human voice like any other

**Files:**
- Modify: `src/screens/SpeakersScreen.tsx` (only if it filters on `clusterLabel`)

- [x] Read `SpeakersScreen.tsx`; (no-op — it never reads `clusterLabel`) if it derives anything from `clusterLabel` (grep `clusterLabel`), make a `'human'` row render and merge like the rest. If it does not, this task is a no-op — record that in the commit of Task 8.

---

### Task 8: Prove it on the Pixel

`export ANDROID_SERIAL=36091FDH30034G`; `npm run apk`; force-stop; install.

- [x] Open a two-voice meeting ("Good afternoon everyone", 10 min). Script: long-press a line in the middle of a turn → sheet with both actions → "Change who said it" → chips shown, "Just this line" selected → pick the other speaker → the turn splits into three (before / the line / after). Long-press the first line of that middle turn → "The whole turn" → the original speaker → the three turns merge back into one. Long-press a line → "From here to the end of the turn" → the other speaker → the turn splits in two.
- [x] Tap a turn's name → picker without chips → pick → the turn changes hands.
- [x] "Someone new" → name "Rahul" → assigned; Speakers screen lists Rahul; Export → Copy → the Markdown transcript carries `**Rahul:**`.
- [x] Durability: run the device suite's `SpeakerRepairDbTest` (Task 2) via `scripts/device-verify.sh SpeakerRepair`; and, on a meeting whose diarization was skipped or a meeting recorded with the models absent if one exists, Redo → corrections and the name survive. If no such meeting exists, the instrumentation test is the proof; say so.
- [x] Record the run in the spec (`## Device verification`); NEXT.md §2 (reassign/split/merge → shipped); scorecard row; memory. Commit; the push is the founder's.
