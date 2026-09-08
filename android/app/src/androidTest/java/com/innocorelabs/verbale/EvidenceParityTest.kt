package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.ModelCatalog
import com.innocorelabs.verbale.pipeline.Minutes
import com.innocorelabs.verbale.pipeline.NativeBridge
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The evidence pass across the JNI boundary, on a real device.
 *
 * Parity with the TypeScript is already held by the goldens — cpp/tests/test_evidence.cpp replays
 * every one of them on the host, and it now also checks the exact JSON `audionotes::itemsToJson`
 * emits, which is the whole of what nativeItems serializes. ItemsJsonTest then drives
 * `Minutes.parseItems` with those same bytes on the JVM.
 *
 * So what is left for this file is the one thing neither can reach: the MARSHALLING. A changed
 * native signature that compiles and returns nonsense passes every host test in the project. Three
 * specific things only run here —
 *
 *  1. the symbol and descriptor of `nativeItems` resolve at all (otherwise UnsatisfiedLinkError,
 *     at the items stage, on every meeting);
 *  2. the `jlongArray` timings arrive as the numbers that were sent, in order, and are not
 *     transposed with each other or truncated to int;
 *  3. non-ASCII text survives GetStringUTFChars/NewStringUTF, and the UTF-16 spans still index the
 *     Kotlin string — evidence_spans.json carries curly quotes and an astral emoji for exactly
 *     that, and a byte- or codepoint-based offset would throw out of bounds here.
 *
 * The goldens come from `assets.srcDirs` (see build.gradle), the same files the desktop C++ test
 * replays, so device and host cannot quietly diverge.
 *
 * Run with:  ./gradlew connectedDebugAndroidTest   — or  npm run test:device
 *
 * Regenerating the fixtures after editing evidence.ts:  npx jest minutes.golden
 */
@RunWith(AndroidJUnit4::class)
class EvidenceParityTest {

  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

  private fun ensureCore() {
    val ort = File(ModelCatalog.modelsDir(ctx), "libonnxruntime.so")
    // libaudionotes.so cannot load without it, even though the rules never touch ORT.
    assumeTrue("libonnxruntime.so not downloaded yet on this device", ort.exists())
    NativeBridge.ensureLoaded(ctx)
  }

  private fun golden(name: String): JSONObject {
    val text = InstrumentationRegistry.getInstrumentation().context.assets
      .open(name).bufferedReader().use { it.readText() }
    return JSONObject(text)
  }

  /**
   * Replay one golden through the device's native items and require every field to match what the
   * TypeScript recorded — including the spans, which is the half a struct-level port can get right
   * and a marshalling layer can still lose.
   */
  private fun assertGoldenMatches(name: String) {
    val g = golden(name)
    val input = g.getJSONObject("input")
    val uarr = input.getJSONArray("utterances")
    val n = uarr.length()

    val ids = Array(n) { uarr.getJSONObject(it).getString("id") }
    val startsMs = LongArray(n) { uarr.getJSONObject(it).getLong("startMs") }
    val endsMs = LongArray(n) { uarr.getJSONObject(it).getLong("endMs") }
    val texts = Array(n) { uarr.getJSONObject(it).getString("text") }
    // A null speakerId crosses as "": Array<String> cannot carry a null, and the C++ treats an
    // empty id as unassigned. isNull() rather than optString(), which differs between org.json
    // implementations on an explicit JSON null.
    val speakerIds = Array(n) {
      val o = uarr.getJSONObject(it)
      if (o.isNull("speakerId")) "" else o.getString("speakerId")
    }

    val sarr = input.getJSONArray("speakers")
    val spkIds = Array(sarr.length()) { sarr.getJSONObject(it).getString("id") }
    val spkNames = Array(sarr.length()) { sarr.getJSONObject(it).getString("displayName") }

    val actual = Minutes.extractItems(ids, startsMs, endsMs, texts, speakerIds, spkIds, spkNames)
    val expected = g.getJSONArray("output")
    println("ITEMS[$name]: ${actual.size} item(s) from $n utterance(s)")

    assertEquals("$name: wrong number of items", expected.length(), actual.size)
    for (i in 0 until expected.length()) {
      val want = expected.getJSONObject(i)
      assertEquals("$name[$i].kind", want.getString("kind"), actual[i].kind)
      assertEquals("$name[$i].text", want.getString("text"), actual[i].text)
      assertEquals("$name[$i].anchorStartMs", want.getLong("anchorStartMs"), actual[i].anchorStartMs)
      assertEquals("$name[$i].anchorEndMs", want.getLong("anchorEndMs"), actual[i].anchorEndMs)

      val ws = want.getJSONArray("sources")
      assertEquals("$name[$i].sources.size", ws.length(), actual[i].sources.size)
      for (j in 0 until ws.length()) {
        val w = ws.getJSONObject(j)
        val got = actual[i].sources[j]
        assertEquals("$name[$i].sources[$j].utteranceId", w.getString("utteranceId"), got.utteranceId)
        assertEquals("$name[$i].sources[$j].startMs", w.getLong("startMs"), got.startMs)
        assertEquals("$name[$i].sources[$j].endMs", w.getLong("endMs"), got.endMs)
        assertEquals("$name[$i].sources[$j].charStart", w.getInt("charStart"), got.charStart)
        assertEquals("$name[$i].sources[$j].charEnd", w.getInt("charEnd"), got.charEnd)

        // The spans are UTF-16 code units and cross unconverted, so they must index the turn as a
        // Kotlin string. Bytes or code points would land past the end of an emoji-bearing turn and
        // throw here — evidence_spans.json is the fixture that reaches this.
        val turn = texts[ids.indexOf(got.utteranceId)]
        assertTrue(
          "$name[$i].sources[$j] span ${got.charStart}..${got.charEnd} outside a ${turn.length}-unit turn",
          got.charStart in 0..turn.length && got.charEnd in got.charStart..turn.length,
        )
      }
    }
  }

  @Test fun meeting_transcript_matches_the_typescript_golden() {
    ensureCore(); assertGoldenMatches("evidence_meeting.json")
  }

  /** One item, two pieces of evidence — the variable source count the JSON payload exists for. */
  @Test fun repeated_items_carry_every_source() {
    ensureCore(); assertGoldenMatches("evidence_dedup.json")
  }

  /**
   * Curly quotes, a whitespace run, a newline inside a turn and an astral emoji. This is the row
   * that separates a correct UTF-16 span from the two plausible wrong answers, and it is also the
   * only fixture whose text has to survive GetStringUTFChars and NewStringUTF unmangled.
   */
  @Test fun spans_and_non_ascii_survive_the_boundary() {
    ensureCore(); assertGoldenMatches("evidence_spans.json")
  }

  @Test fun decision_dedup_matches_the_typescript_golden() {
    ensureCore(); assertGoldenMatches("evidence_decision_dedup.json")
  }

  @Test fun classification_priority_matches_the_typescript_golden() {
    ensureCore(); assertGoldenMatches("evidence_priority.json")
  }

  /** Every turn unassigned and no speaker rows: a null speakerId has to arrive as "". */
  @Test fun unassigned_speakers_survive_the_jni_boundary() {
    ensureCore(); assertGoldenMatches("evidence_unassigned.json")
  }

  /** An empty transcript must give an empty list, not a crash and not a JSONException on "". */
  @Test fun empty_transcript_yields_no_items() {
    ensureCore(); assertGoldenMatches("evidence_empty.json")
  }

  @Test fun caps_match_the_typescript_golden() {
    ensureCore(); assertGoldenMatches("evidence_caps.json")
  }

  /**
   * The timings, on their own and away from the goldens.
   *
   * The goldens all carry ascending, distinct startMs and endMs, so a boundary that swapped the two
   * jlongArrays would still produce plausible-looking output there. Here the anchor is checked
   * against values chosen so that a swap, a truncation to int, or an off-by-one index cannot
   * survive: the second turn's END is what the anchor of a repeated item must take.
   *
   * The expected strings and numbers were produced by running audionotes::extractItems over these
   * exact inputs on the host, so a failure is the marshalling and not a rules change.
   */
  @Test fun anchors_survive_the_boundary() {
    ensureCore()
    val items = Minutes.extractItems(
      ids = arrayOf("u0", "u1"),
      startsMs = longArrayOf(0L, 4000L),
      endsMs = longArrayOf(4000L, 8000L),
      texts = arrayOf("We agreed to ship on Monday.", "I'll send the report by Friday."),
      speakerIds = arrayOf("S0", "S0"),
      spkIds = arrayOf("S0"),
      spkNames = arrayOf("Speaker 1"),
    )

    val decision = items.first { it.kind == "decision" }
    assertEquals("We agreed to ship on Monday.", decision.text)
    assertEquals(0L, decision.anchorStartMs)
    assertEquals(4000L, decision.anchorEndMs)
    assertEquals(1, decision.sources.size)
    assertEquals("u0", decision.sources[0].utteranceId)
    assertEquals(0, decision.sources[0].charStart)
    assertEquals(28, decision.sources[0].charEnd)

    val action = items.first { it.kind == "action" }
    assertEquals("I'll send the report by Friday. — Speaker 1 (due by Friday)", action.text)
    assertEquals(4000L, action.anchorStartMs)
    assertEquals(8000L, action.anchorEndMs)
    assertEquals("u1", action.sources[0].utteranceId)
    assertEquals(4000L, action.sources[0].startMs)
    assertEquals(8000L, action.sources[0].endMs)
    assertEquals(31, action.sources[0].charEnd)
  }

  /**
   * The same sentence in two different turns is ONE item with TWO sources, and the anchor is the
   * envelope of both — min of the starts, max of the ends. A boundary that dropped every source
   * after the first, or that reused one turn's timings for both, fails here and nowhere else.
   */
  @Test fun a_repeated_item_carries_both_sources() {
    ensureCore()
    val items = Minutes.extractItems(
      ids = arrayOf("u0", "u1"),
      startsMs = longArrayOf(0L, 9000L),
      endsMs = longArrayOf(3000L, 12000L),
      texts = arrayOf("I'll send the report by Friday.", "I'll send the report by Friday."),
      speakerIds = arrayOf("S0", "S0"),
      spkIds = arrayOf("S0"),
      spkNames = arrayOf("Speaker 1"),
    )
    val action = items.first { it.kind == "action" }
    assertEquals(2, action.sources.size)
    assertEquals("u0", action.sources[0].utteranceId)
    assertEquals(0L, action.sources[0].startMs)
    assertEquals(3000L, action.sources[0].endMs)
    assertEquals("u1", action.sources[1].utteranceId)
    assertEquals(9000L, action.sources[1].startMs)
    assertEquals(12000L, action.sources[1].endMs)
    assertEquals(0L, action.anchorStartMs)
    assertEquals(12000L, action.anchorEndMs)
  }
}
