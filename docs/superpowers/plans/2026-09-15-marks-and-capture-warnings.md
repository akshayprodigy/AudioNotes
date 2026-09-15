# Marks and Capture Warnings — Implementation Plan

> **SHIPPED 15 Sep 2026.** All nine tasks done; device-verified on the Pixel 7 Pro (spec §"Device verification"). Two defects the phone found are fixed in-branch.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "mark" during recording (screen, PiP, notification) that becomes a Highlights section with playback and exports; and three inline, non-blocking capture warnings (too loud, faint, storage) with logged thresholds.

**Architecture:** Marks are a time-keyed `marks` table written natively by `CaptureController.mark()` and read by JS; `highlightsFor()` resolves marks to utterances at render time, mirrored in Kotlin for exports. Warnings are computed by a pure `CaptureWarnings` object fed by the capture loop (clipping, RMS ring) and the live VAD's spans, surfaced through `CaptureController.warning` → `onCaptureWarning` → banner and notification.

**Tech Stack:** Kotlin (services, DB, exports), TypeScript/React Native (screens), jest + JUnit, the existing schema-mirror tests.

Spec: `docs/superpowers/specs/2026-09-15-marks-and-capture-warnings-design.md`.

---

## File structure

- Modify `android/.../data/AudioDb.kt` — `marks` table in SCHEMA; `addMark`, `marks`, `removeMark`.
- Modify `src/db/schema.ts`, `android/.../SchemaTest.kt`, `src/db/__tests__/schema.test.ts` — the mirror.
- Modify `src/db/queries.ts` — `marks(meetingId)`, `removeMark(id)`.
- Create `src/screens/meeting/highlights.ts` + `__tests__/highlights.test.ts` — `highlightsFor`.
- Modify `android/.../pipeline/CaptureController.kt` — `capturedMs`, `mark()`, `warning`, RMS ring, `noteSpeechSpans`.
- Create `android/.../pipeline/CaptureWarnings.kt` + `src/test/.../CaptureWarningsTest.kt` — pure rules.
- Modify `android/.../pipeline/RecordingService.kt` — `ACTION_MARK`, notification action + body, clipping/RMS feed, storage check.
- Modify `android/.../pipeline/LiveTranscriber.kt` — report spans.
- Modify `android/.../pipeline/PipController.kt`, `PipActionReceiver.kt` — third action. Create `res/drawable/ic_pip_mark.xml`.
- Modify `android/.../pipeline/AudioPipelineModule.kt` — `mark()`; emit `onCaptureMark`, `onCaptureWarning`. Modify `src/native/NativeAudioPipeline.ts`.
- Modify `android/.../res/values/strings.xml` — action and warning strings.
- Modify `src/screens/RecordScreen.tsx` — Mark button, caption, warning banner.
- Modify `src/screens/MeetingScreen.tsx`, `src/screens/meeting/SummaryTab.tsx` — Highlights section.
- Modify `android/.../pipeline/FileExportModule.kt`, `PdfExport.kt`, `ExportItemsTest.kt` — Highlights in exports.

---

### Task 1: The `marks` table, both mirrors

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/data/AudioDb.kt` (SCHEMA list, after the `tags` CREATE; accessors near `tagsFor`)
- Modify: `src/db/schema.ts` (after the `tags` CREATE)
- Modify: `android/app/src/test/java/com/innocorelabs/verbale/SchemaTest.kt`
- Modify: `src/db/__tests__/schema.test.ts`
- Modify: `src/db/queries.ts` (after `removeTag`)

- [ ] **Step 1: Failing schema tests.** Add to `SchemaTest.kt` beside `itemsTableExists`:

```kotlin
  @Test fun marksTableExists() = assertTrue(schema.contains("CREATE TABLE IF NOT EXISTS marks"))
  @Test fun marksHasExpectedColumns() {
    val ddl = schema.substringAfter("CREATE TABLE IF NOT EXISTS marks").substringBefore(";")
    for (col in listOf("id", "meeting_id", "at_ms", "created_at")) assertTrue(col, ddl.contains(col))
    assertTrue("cascade", ddl.contains("ON DELETE CASCADE"))
  }
```

And to `src/db/__tests__/schema.test.ts`, a new `describe('marks')` at the end:

```ts
describe('marks', () => {
  it('exists, keyed on time, cascading with the meeting', () => {
    const ddl = SCHEMA.join('\n');
    const m = ddl.match(/CREATE TABLE IF NOT EXISTS marks \(([^;]+)\)/);
    expect(m).not.toBeNull();
    for (const col of ['id', 'meeting_id', 'at_ms', 'created_at']) expect(m![1]).toContain(col);
    expect(m![1]).toContain('ON DELETE CASCADE');
  });
});
```

Run: `npx jest --silent src/db && (cd android && ./gradlew :app:testDebugUnitTest --tests '*SchemaTest*' -q)` — expected: both fail on `marks`.

- [ ] **Step 2: The table.** In `AudioDb.kt` SCHEMA, right after the `tags` CREATE statement:

```kotlin
      // A moment somebody marked while recording. Keyed on TIME (the capture clock), not on any
      // item or utterance, so a reprocess has nothing to reconcile and can never lose one; the
      // sentence it lands on is resolved when it is shown. created_at is wall clock, for order
      // of taps within the same second.
      """CREATE TABLE IF NOT EXISTS marks(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           at_ms INTEGER NOT NULL,
           created_at INTEGER NOT NULL);""",
      """CREATE INDEX IF NOT EXISTS idx_marks_meeting ON marks(meeting_id, at_ms);""",
```

In `src/db/schema.ts`, the same two statements after the `tags` CREATE, with the same comment.

Accessors in `AudioDb.kt` beside the tag accessors:

```kotlin
  /** A mark at [atMs] on the capture clock. Returns the new row id. */
  fun addMark(meetingId: String, atMs: Long): Long {
    db.execSQL(
      "INSERT INTO marks(meeting_id, at_ms, created_at) VALUES(?,?,?)",
      arrayOf<Any?>(meetingId, atMs, System.currentTimeMillis()),
    )
    db.rawQuery("SELECT last_insert_rowid()", null).use { c -> return if (c.moveToFirst()) c.getLong(0) else -1L }
  }

  data class Mark(val id: Long, val atMs: Long)

  fun marks(meetingId: String): List<Mark> {
    val out = ArrayList<Mark>()
    db.rawQuery("SELECT id, at_ms FROM marks WHERE meeting_id=? ORDER BY at_ms, id", arrayOf(meetingId)).use { c ->
      while (c.moveToNext()) out.add(Mark(c.getLong(0), c.getLong(1)))
    }
    return out
  }
```

In `src/db/queries.ts` after `removeTag`:

```ts
  // ---- Marks: moments tapped while recording ----------------------------------------------
  marks: (meetingId: string) =>
    run<{ id: number; at_ms: number }>(
      'SELECT id, at_ms FROM marks WHERE meeting_id = ? ORDER BY at_ms, id',
      [meetingId],
    ).then(rows => rows.map(r => ({ id: r.id, atMs: r.at_ms }))),

  removeMark: (id: number) => run('DELETE FROM marks WHERE id = ?', [id]),
```

- [ ] **Step 3: Run both schema suites** — expected: pass. Then `npx jest --silent` — the `__mocks__` for queries may need `marks`/`removeMark` (check `src/db/__mocks__/queries.ts`; add `marks: jest.fn().mockResolvedValue([])` and `removeMark: jest.fn()` if the file enumerates methods).

- [ ] **Step 4: Commit** — `feat(marks): the table, both mirrors, and the accessors`.

---

### Task 2: `highlightsFor` — the one rule, tested

**Files:**
- Create: `src/screens/meeting/highlights.ts`
- Create: `src/screens/__tests__/highlights.test.ts`

- [ ] **Step 1: Failing tests**

```ts
import { highlightsFor, GAP_MS } from '../meeting/highlights';
import type { Utterance } from '../../pipeline/types';

const u = (id: string, startMs: number, endMs: number, text: string): Utterance => ({
  id, meetingId: 'm', speakerId: 'S1', startMs, endMs, text,
});
const utts = [u('a', 1000, 4000, 'First thing.'), u('b', 9000, 12000, 'Second thing.'), u('c', 30000, 33000, 'Third.')];

describe('highlightsFor', () => {
  test('a mark inside an utterance takes that utterance', () => {
    expect(highlightsFor([{ id: 1, atMs: 2500 }], utts)).toEqual([
      { id: 1, atMs: 2500, text: 'First thing.', anchorStartMs: 1000 },
    ]);
  });
  test('a mark in a gap takes the next utterance within the gap allowance', () => {
    expect(highlightsFor([{ id: 2, atMs: 6000 }], utts)[0]).toMatchObject({ text: 'Second thing.', anchorStartMs: 9000 });
  });
  test('a mark with nothing near it keeps its time and no words', () => {
    // 13 s after "Second thing." ends and 5 s before "Third." starts: outside GAP_MS on both sides.
    expect(GAP_MS).toBe(15000);
    expect(highlightsFor([{ id: 3, atMs: 14000 }], utts)[0]).toMatchObject({ text: null, anchorStartMs: 14000 });
  });
  test('marks come back in recording order regardless of tap order', () => {
    const out = highlightsFor([{ id: 9, atMs: 31000 }, { id: 8, atMs: 1500 }], utts);
    expect(out.map(h => h.id)).toEqual([8, 9]);
  });
  test('a mark before the first word waits for it', () => {
    expect(highlightsFor([{ id: 4, atMs: 0 }], utts)[0]).toMatchObject({ text: 'First thing.', anchorStartMs: 1000 });
  });
});
```

Wait — the third test: "Third." starts at 30 000, the mark is at 14 000 → 16 s away → outside 15 s → no text. Good.

Run: `npx jest --silent src/screens/__tests__/highlights.test.ts` — expected: fails (module missing).

- [ ] **Step 2: Implement**

```ts
import type { Utterance } from '../../pipeline/types';

export interface Mark { id: number; atMs: number }
export interface Highlight {
  id: number;
  atMs: number;
  /** The sentence said at (or just after) the mark; null when nothing was said near it. */
  text: string | null;
  /** Where the provenance button lands: the utterance's start, or the mark itself when there is no utterance. */
  anchorStartMs: number;
}

/** How far ahead a mark may reach for the next words. A mark is usually a beat BEFORE the thing. */
export const GAP_MS = 15_000;

/**
 * Resolve marks to what was said. Pure, and the only place the rule lives on the JS side; the
 * Kotlin export reader mirrors it (FileExportModule.highlightsFor) and shares this file's fixture.
 */
export function highlightsFor(marks: Mark[], utterances: Utterance[]): Highlight[] {
  const sorted = [...marks].sort((a, b) => a.atMs - b.atMs || a.id - b.id);
  const utts = [...utterances].sort((a, b) => a.startMs - b.startMs);
  return sorted.map(m => {
    const inside = utts.find(u => u.startMs <= m.atMs && m.atMs <= u.endMs);
    const hit = inside ?? utts.find(u => u.startMs > m.atMs && u.startMs - m.atMs <= GAP_MS);
    return hit
      ? { id: m.id, atMs: m.atMs, text: hit.text.trim(), anchorStartMs: hit.startMs }
      : { id: m.id, atMs: m.atMs, text: null, anchorStartMs: m.atMs };
  });
}
```

- [ ] **Step 3: Run** — expected: 5 pass. **Commit** — `feat(marks): highlightsFor, the one rule`.

---

### Task 3: Marking natively — CaptureController, service, PiP, notification, module

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/CaptureController.kt`
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/RecordingService.kt`
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/PipActionReceiver.kt`, `PipController.kt`
- Create: `android/app/src/main/res/drawable/ic_pip_mark.xml`
- Modify: `android/app/src/main/res/values/strings.xml`
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/AudioPipelineModule.kt`, `src/native/NativeAudioPipeline.ts`

- [ ] **Step 1: Capture clock and `mark()` on CaptureController.** Add beside `level`:

```kotlin
  /** Bytes written so far ÷ 32: the capture clock, pause-adjusted, the one the transcript uses. */
  @Volatile var capturedMs: Long = 0L

  /** The last mark made, for the record screen's caption and the notification. */
  @Volatile var lastMarkMs: Long = -1L

  /**
   * Mark the current moment. Returns the moment, or -1 when nothing is recording. Writes the row
   * itself so every entry point — screen, PiP, notification — lands in one place.
   */
  fun mark(ctx: Context): Long {
    val id = currentMeetingId ?: return -1L
    if (!isRecording) return -1L
    val at = capturedMs
    com.innocorelabs.verbale.data.AudioDb.get(ctx).addMark(id, at)
    lastMarkMs = at
    (ctx.getSystemService(Context.VIBRATOR_SERVICE) as? android.os.Vibrator)?.let { v ->
      if (Build.VERSION.SDK_INT >= 26) v.vibrate(android.os.VibrationEffect.createOneShot(40, android.os.VibrationEffect.DEFAULT_AMPLITUDE))
      else @Suppress("DEPRECATION") v.vibrate(40)
    }
    listeners.forEach { runCatching { it.onMarked(at) } }
    return at
  }
```

Add `fun onMarked(atMs: Long) {}` (default) to `CaptureListener.kt`. In `RecordingService`'s read loop where bytes are written (the `File(path).length()` sites), keep `CaptureController.capturedMs = bytesWrittenSoFar / BYTES_PER_MS` updated after every write (track a `var written = 0L` counter incremented by `n` on each successful write; reset at start).

- [ ] **Step 2: The service action and notification button.** In `RecordingService` companion: `const val ACTION_MARK = "com.innocorelabs.verbale.action.MARK_RECORDING"`. In `onStartCommand`'s `when`: `ACTION_MARK -> CaptureController.mark(applicationContext)`. In `buildNotification`, after the pause/resume action and before stop: `b.addAction(0, getString(R.string.notif_action_mark), serviceIntent(ACTION_MARK, 4))`. Body while a mark is fresh (within 5 s): the existing body helper returns `getString(R.string.notif_body_marked, stamp(lastMarkMs))` — implement `stamp(ms)` as m:ss; refresh the notification from `onMarked` (the service is a listener already, see `onPausedChanged`).

Strings:
```xml
    <string name="notif_action_mark">Mark</string>
    <string name="notif_body_marked">Marked %1$s</string>
```

- [ ] **Step 3: PiP.** `PipActionReceiver`: `const val ACTION_MARK = "com.innocorelabs.verbale.pip.MARK"`; in `when`: `ACTION_MARK -> CaptureController.mark(context)`. `PipController.params`: a third `RemoteAction(Icon.createWithResource(activity, R.drawable.ic_pip_mark), "Mark", "Mark this moment", pending(activity, REQ_MARK, PipActionReceiver.ACTION_MARK))` with `REQ_MARK = 3`, listed between toggle and stop. Drawable `ic_pip_mark.xml`: a 24dp bookmark path (`M6 2h12v20l-6-4-6 4z`, fill `#FFFFFF`).

- [ ] **Step 4: The module.** `AudioPipelineModule`:

```kotlin
  @ReactMethod
  fun mark(promise: Promise) {
    val at = CaptureController.mark(reactApplicationContext)
    if (at < 0) promise.resolve(null) else promise.resolve(at.toDouble())
  }
```

And the module registers itself as a `CaptureListener` (it already does for state — extend `onMarked`) to emit `onCaptureMark` `{ atMs }` so a PiP/notification mark reaches a visible record screen. `NativeAudioPipeline.ts`: `mark(): Promise<number | null>;`.

- [ ] **Step 5: Build** — `cd android && ./gradlew :app:compileReleaseKotlin -q` clean. `npx tsc --noEmit` clean. **Commit** — `feat(marks): mark from the screen, the PiP window and the notification`.

---

### Task 4: The record screen — Mark button and caption

**Files:**
- Modify: `src/screens/RecordScreen.tsx`

- [ ] **Step 1:** Replace the second footer `SoftButton` (the "Stays on device" one) while recording with a Mark button, and move the assurance into the caption row:

```tsx
              <SoftButton
                label={marked !== null ? `Marked ${provenanceLabel(marked)}` : 'Mark'}
                icon="clock"
                onPress={() => {
                  AudioPipeline.mark().then(at => { if (at !== null) flashMark(at); }).catch(() => {});
                }}
              />
```

with state `const [marked, setMarked] = useState<number | null>(null)` and

```tsx
  const flashMark = useCallback((at: number) => {
    setMarked(at);
    setTimeout(() => setMarked(null), 2000);
  }, []);
  useEffect(() => {
    const sub = emitter.addListener('onCaptureMark', (e: { atMs: number }) => flashMark(e.atMs));
    return () => sub.remove();
  }, [flashMark]);
```

Keep the "Mic unavailable" state: when `silenced`, the button reads "Mic unavailable" with the alert icon and does nothing. Import `provenanceLabel` from `./meeting/ItemProvenance`.

- [ ] **Step 2:** `npx tsc --noEmit`; `npx jest --silent src/screens` (RecordScreen has no test; the emitter mock in jest.setup covers `addListener`). **Commit** — `feat(marks): the Mark button`.

---

### Task 5: Highlights on the Summary tab

**Files:**
- Modify: `src/screens/MeetingScreen.tsx` (refresh, state, props)
- Modify: `src/screens/meeting/SummaryTab.tsx`
- Modify: `src/screens/__tests__/MeetingScreen.test.tsx`

- [ ] **Step 1: Failing test** in `MeetingScreen.test.tsx`:

```tsx
test('a marked moment shows as a highlight with the sentence said there', async () => {
  (db.marks as jest.Mock).mockResolvedValue([{ id: 1, atMs: 2500 }]);
  (db.utterances as jest.Mock).mockResolvedValue([
    { id: 'u1', meetingId: 'm1', speakerId: 'S1', startMs: 1000, endMs: 4000, text: 'We ship Friday.' },
  ]);
  const tree = await render();
  const texts = tree.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children);
  expect(texts).toContain('HIGHLIGHTS');
  expect(texts).toContain('We ship Friday.');
});
```

Add `marks: jest.fn().mockResolvedValue([])` and `removeMark: jest.fn().mockResolvedValue(undefined)` to the `beforeEach` (and the mocks file if it enumerates).

- [ ] **Step 2:** In `MeetingScreen.refresh`, add `db.marks(meetingId).catch(() => [])` to the `Promise.all` and `setMarks(mks)`; state `const [marks, setMarks] = useState<Mark[]>([])`; `const highlights = useMemo(() => highlightsFor(marks, utterances), [marks, utterances])`. Pass to `SummaryTab`: `highlights={highlights} onOpenProvenance={openProvenance} canPlay={player.available} onRemoveMark={id => db.removeMark(id).then(refresh)}`.

- [ ] **Step 3:** In `SummaryTab`, new props `highlights: Highlight[]; onOpenProvenance: (ms: number) => void; canPlay: boolean; onRemoveMark: (id: number) => void;` and, above the summary card:

```tsx
      {highlights.length > 0 ? (
        <View style={st.section}>
          <Txt variant="sectionLabel" color={colors.inkSoft}>HIGHLIGHTS</Txt>
          {highlights.map(h => (
            <Raised key={h.id} edge={colors.line} fill={colors.card} rad={radius.card} depth={4}>
              <View style={st.highlight}>
                <View style={st.flex}>
                  <Txt variant="body">{h.text ?? 'Nothing said here yet'}</Txt>
                  <ProvenanceButton anchorStartMs={h.anchorStartMs} onOpen={onOpenProvenance} canPlay={canPlay} />
                </View>
                <IconButton icon="x" label="Remove this mark" onPress={() => onRemoveMark(h.id)} />
              </View>
            </Raised>
          ))}
        </View>
      ) : null}
```

(Use the tab's existing `Txt` variants and `st` style names; add `highlight: { flexDirection: 'row', gap: s(10), padding: s(14), alignItems: 'flex-start' }` and `flex: { flex: 1 }` to `makeStyles`.)

- [ ] **Step 4:** Run the test — pass. Mutation: return `[]` from `highlightsFor` temporarily — the test must fail. **Commit** — `feat(marks): highlights on the Summary tab`.

---

### Task 6: Highlights in every export

**Files:**
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/FileExportModule.kt`
- Modify: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/PdfExport.kt` (the section renderer)
- Modify: `android/app/src/test/java/com/innocorelabs/verbale/pipeline/ExportItemsTest.kt`

- [ ] **Step 1: Failing test** in `ExportItemsTest.kt`:

```kotlin
  @Test fun highlightsLeadWithTheirStampAndComeBeforeDecisions() {
    val c = FileExportModule.Content(
      title = "T", createdAt = 0L, summary = null, narrative = null,
      items = listOf(FileExportModule.ExportItem("decision", "We ship Friday.", 61_000L)),
      turns = emptyList(),
      highlights = listOf(FileExportModule.ExportHighlight(2_500L, "First thing.")),
    )
    val md = FileExportModule.renderMarkdown(c)
    assertTrue(md.contains("## Highlights"))
    assertTrue(md.indexOf("## Highlights") < md.indexOf("## Decisions"))
    assertTrue(md.contains("- [0:02] First thing."))
    val txt = FileExportModule.renderText(c)
    assertTrue(txt.contains("[0:02] First thing."))
  }

  @Test fun highlightsResolveExactlyAsTheScreenDoes() {
    // The same fixture as src/screens/__tests__/highlights.test.ts: inside → that turn; gap →
    // next turn within 15 s; nothing near → no words.
    val turns = listOf(
      FileExportModule.ExportTurn("S1", 1_000L, 4_000L, "First thing."),
      FileExportModule.ExportTurn("S1", 9_000L, 12_000L, "Second thing."),
      FileExportModule.ExportTurn("S1", 30_000L, 33_000L, "Third."),
    )
    val h = FileExportModule.highlightsFor(listOf(2_500L, 6_000L, 14_000L), turns)
    assertEquals(listOf("First thing.", "Second thing.", null), h.map { it.text })
    assertEquals(listOf(2_500L, 6_000L, 14_000L), h.map { it.atMs })
  }
```

(Match `ExportItem`/`ExportTurn` constructor shapes to the file — read them first; adjust names, not intent.)

- [ ] **Step 2:** Add `data class ExportHighlight(val atMs: Long, val text: String?)`, the `highlights: List<ExportHighlight> = emptyList()` field on `Content`, `highlightsFor(marksMs: List<Long>, turns: List<ExportTurn>)` mirroring Task 2's rule with `GAP_MS = 15_000L`, read `db.marks(meetingId)` in the reader, and render "## Highlights" / "Highlights" / a PDF section before Decisions, each line `[stamp] text` (or `[stamp] (nothing said here yet)`).

- [ ] **Step 3:** Kotlin tests pass. Mutation: change `GAP_MS` to 5_000 — the parity test must fail. **Commit** — `feat(marks): highlights in Markdown, text and PDF`.

---

### Task 7: `CaptureWarnings` — the rules, pure

**Files:**
- Create: `android/app/src/main/java/com/innocorelabs/verbale/pipeline/CaptureWarnings.kt`
- Create: `android/app/src/test/java/com/innocorelabs/verbale/pipeline/CaptureWarningsTest.kt`

- [ ] **Step 1: Failing tests**

```kotlin
class CaptureWarningsTest {
  @Test fun `one clipped sample in a hundred is loud`() {
    val buf = ShortArray(1000) { 1000 }
    for (i in 0 until 11) buf[i] = Short.MAX_VALUE
    assertTrue(CaptureWarnings.clippedFraction(buf, buf.size) > CaptureWarnings.CLIP_FRACTION)
    assertFalse(CaptureWarnings.clippedFraction(ShortArray(1000) { 1000 }, 1000) > CaptureWarnings.CLIP_FRACTION)
  }
  @Test fun `faint needs ten seconds of speech AND a low mean level`() {
    assertTrue(CaptureWarnings.isFaint(speechMs = 12_000, meanRmsDuringSpeech = 0.001))   // -60 dBFS
    assertFalse(CaptureWarnings.isFaint(speechMs = 12_000, meanRmsDuringSpeech = 0.004))  // -48: the A07 transcribed this fine
    assertFalse(CaptureWarnings.isFaint(speechMs = 5_000, meanRmsDuringSpeech = 0.001))   // not enough speech to judge
  }
  @Test fun `minutes left is free bytes at 32 bytes per ms`() {
    assertEquals(10L, CaptureWarnings.minutesLeft(freeBytes = 32L * 60_000 * 10))
  }
  @Test fun `storage outranks loud outranks faint`() {
    val w = CaptureWarnings.pick(storageMinutesLeft = 4L, loud = true, faint = true, storageWarnAtMinutes = 5L)
    assertEquals(CaptureWarnings.Kind.STORAGE, w?.kind)
    assertEquals(CaptureWarnings.Kind.LOUD, CaptureWarnings.pick(30L, true, true, 5L)?.kind)
    assertEquals(CaptureWarnings.Kind.FAINT, CaptureWarnings.pick(30L, false, true, 5L)?.kind)
    assertNull(CaptureWarnings.pick(30L, false, false, 5L))
  }
  @Test fun `the ring keeps sixty seconds and averages inside spans`() {
    val ring = RmsRing(windowMs = 60_000)
    ring.add(atMs = 0, rms = 0.010); ring.add(atMs = 1_000, rms = 0.002); ring.add(atMs = 2_000, rms = 0.002)
    assertEquals(0.002, ring.meanIn(listOf(1_000L to 3_000L)), 1e-9)
    ring.add(atMs = 70_000, rms = 0.5)
    assertEquals(0.0, ring.meanIn(listOf(0L to 500L)), 1e-9) // fell out of the window
  }
}
```

- [ ] **Step 2: Implement** `CaptureWarnings` (object: `CLIP_FRACTION = 0.01`, `FAINT_RMS = 0.002` (−54 dBFS), `FAINT_MIN_SPEECH_MS = 10_000L`, `clippedFraction`, `isFaint`, `minutesLeft`, `enum Kind { STORAGE, LOUD, FAINT }`, `data class Warning(val kind: Kind, val minutesLeft: Long)`, `pick`) and `class RmsRing(windowMs)` (a deque of (atMs, rms); `add` drops entries older than `windowMs` behind the newest; `meanIn(spans)` averages entries whose `atMs` falls inside any span, 0.0 when none). Both in `CaptureWarnings.kt`, no Android imports.

- [ ] **Step 3:** Tests pass. **Commit** — `feat(warnings): the rules, and the ring, pure and tested`.

---

### Task 8: Wire the warnings — capture loop, live VAD, surface

**Files:**
- Modify: `CaptureController.kt`, `RecordingService.kt`, `LiveTranscriber.kt`, `AudioPipelineModule.kt`, `NativeAudioPipeline.ts`, `strings.xml`, `RecordScreen.tsx`

- [ ] **Step 1: CaptureController state.**

```kotlin
  @Volatile var warning: CaptureWarnings.Warning? = null
  private val ring = RmsRing(60_000)
  @Volatile private var loud = false
  @Volatile private var speechMsIn60s = 0L
  @Volatile private var meanRmsInSpeech = 0.0

  /** Called per buffer from the capture thread. */
  fun noteBuffer(atMs: Long, rms: Double, clippedFraction: Double) {
    ring.add(atMs, rms)
    loud = clippedFraction > CaptureWarnings.CLIP_FRACTION
  }

  /** Called by LiveTranscriber with the VAD's speech spans (ms on the capture clock). */
  fun noteSpeechSpans(spans: List<Pair<Long, Long>>, nowMs: Long) {
    val recent = spans.filter { it.second > nowMs - 60_000 }
    speechMsIn60s = recent.sumOf { it.second - it.first }
    meanRmsInSpeech = ring.meanIn(recent)
  }

  /** Recompute; log every transition with its numbers; notify listeners when it changes. */
  fun refreshWarning(freeBytes: Long) {
    val next = CaptureWarnings.pick(
      storageMinutesLeft = CaptureWarnings.minutesLeft(freeBytes),
      loud = loud,
      faint = CaptureWarnings.isFaint(speechMsIn60s, meanRmsInSpeech),
      storageWarnAtMinutes = RecordingService.MIN_FREE_BYTES * 3 / (32L * 60_000),
    )
    if (next?.kind != warning?.kind) {
      Log.i("CaptureWarnings", "warning ${warning?.kind} -> ${next?.kind}: loud=$loud speechMs=$speechMsIn60s meanRms=%.4f free=${freeBytes / 1048576}MB".format(meanRmsInSpeech))
      warning = next
      listeners.forEach { runCatching { it.onWarningChanged(next) } }
    }
  }
```

Add `fun onWarningChanged(w: CaptureWarnings.Warning?) {}` to `CaptureListener`. The clipping window is "the last 2 s": keep a small ring of per-buffer clipped fractions in `noteBuffer` and set `loud` from the mean of the last 2 s of buffers.

- [ ] **Step 2: RecordingService.** In the read loop, after `computeLevel`: compute `rms` (the existing `computeLevel` already computes it — extract `rmsOf(buf, n)` and reuse) and `CaptureWarnings.clippedFraction(buf, n)`; call `CaptureController.noteBuffer(capturedMs, rms, clipped)`. Every `DISK_CHECK_EVERY_READS` reads (the existing site), call `CaptureController.refreshWarning(filesDir.usableSpace)`. In `buildNotification`, when `CaptureController.warning != null`, the body is the warning's string (`notif_warn_loud`, `notif_warn_faint`, `notif_warn_storage` with `%1$d`). The service implements `onWarningChanged` → `refreshNotification()`.

- [ ] **Step 3: LiveTranscriber.** After each `nativeVadFeed` (and after `nativeVadFinish`), `CaptureController.noteSpeechSpans(spans.chunked(2).map { it[0] to it[1] }, tailBytes / RecordingService.BYTES_PER_MS)`.

- [ ] **Step 4: Module + JS.** `AudioPipelineModule` listens `onWarningChanged` → emit `onCaptureWarning` `{ kind: "loud"|"faint"|"storage"|null, minutesLeft }`. `RecordScreen`: state `warning`, subscribe, render under the waveform:

```tsx
          {warning ? (
            <View style={[st.warn, { backgroundColor: colors.warningSoft }]}>
              <Icon name="alert" size={s(16)} color={colors.warning} />
              <Txt variant="chip" color={colors.warning}>{warningText(warning)}</Txt>
            </View>
          ) : null}
```

with `warningText` mapping the three kinds to the spec's sentences (storage: `About ${n} minutes of storage left.`).

- [ ] **Step 5:** Build both sides clean; `npm run gate` (host stages). **Commit** — `feat(warnings): too loud, faint, storage — inline and in the notification`.

---

### Task 9: Prove it on the Pixel

- [x] Install; record; mark from the screen, the PiP window and the notification (three marks, three captions); stop; Summary shows three highlights with the right sentences; tap one → transcript + playback; × removes one; export Markdown → Highlights section leads. Loud: play the Mac at full volume 10 cm from the phone → "Too loud" within 3 s, clears after. Faint: whisper the script at 2 m → "Voices are faint" after ~15 s of speech. Storage: unit-tested only (state so).
  Done 15 Sep on the Pixel 7 Pro — see the spec's "Device verification". Two defects found and fixed in the run (notification Mark stopped the meeting; the caption never reverted). Loud is not provokable from a speaker on the Pixel (clip=0 at full volume); unit-tested. Faint provoked at 50 % Mac volume.
- [x] Record the run in the spec (`## Device verification`), update NEXT.md §2 (bookmark ✓, warnings ✓, live transcript — decided against), memory. Commit; push (the gate runs).
