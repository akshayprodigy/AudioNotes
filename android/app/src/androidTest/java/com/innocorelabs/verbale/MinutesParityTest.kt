package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.ModelCatalog
import com.innocorelabs.verbale.pipeline.Minutes
import com.innocorelabs.verbale.pipeline.NativeBridge
import com.innocorelabs.verbale.pipeline.Spk
import com.innocorelabs.verbale.pipeline.Utt
import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Locks Android's minutes to the shared C++ core, on a real device.
 *
 * Two things are under test, and the second is why this file exists at all:
 *
 *  1. **The JNI binding.** `Minutes.extract` reaches libaudionotes through `nativeMinutes`, which
 *     replaced the deleted Kotlin MinutesExtractor. A wrong symbol name or descriptor is not a
 *     compile error — it is an UnsatisfiedLinkError at the minutes stage, at which point EVERY
 *     meeting silently ends up with no MOM. Nothing else in the suite would catch that.
 *  2. **Cross-platform parity.** The fixtures are the very files `cpp/tests/test_minutes.cpp`
 *     replays, generated from the real `src/pipeline/minutes.ts` by the jest golden test. Wired in
 *     via `assets.srcDirs` in build.gradle rather than copied, so device, desktop CLI and TS are
 *     all checked against one artifact and cannot quietly diverge.
 *
 * Unlike the rest of NativePipelineTest this needs NO model files — the rules are pure string work
 * — so it runs on any device. It does still need libonnxruntime.so present, because
 * libaudionotes.so carries a DT_NEEDED on it and cannot load without it.
 *
 * Run with:  ./gradlew connectedDebugAndroidTest
 *
 * Regenerating the fixtures after editing minutes.ts:  npx jest minutes.golden
 */
@RunWith(AndroidJUnit4::class)
class MinutesParityTest {

  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

  private fun ensureCore() {
    val ort = File(ModelCatalog.modelsDir(ctx), "libonnxruntime.so")
    // libaudionotes.so cannot load without it, even though minutes themselves never touch ORT.
    assumeTrue("libonnxruntime.so not downloaded yet on this device", ort.exists())
    NativeBridge.ensureLoaded(ctx)
  }

  /** Read a golden written by src/pipeline/__tests__/minutes.golden.test.ts. */
  private fun golden(name: String): org.json.JSONObject {
    val text = InstrumentationRegistry.getInstrumentation().context.assets
      .open(name).bufferedReader().use { it.readText() }
    return org.json.JSONObject(text)
  }

  /**
   * Replay one golden: feed its recorded input through the device's native minutes and require the
   * output to match the TS byte for byte, in order.
   */
  private fun assertGoldenMatches(name: String) {
    val g = golden(name)
    val input = g.getJSONObject("input")

    val utterances = input.getJSONArray("utterances").let { arr ->
      (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        // The goldens are recorded MINUTES input and never had an id or a clock; `Minutes.extract`
        // reads neither. Named, so three blanks in a five-argument constructor cannot be misread
        // as timings somebody meant.
        Utt(
          id = "",
          startMs = 0L,
          endMs = 0L,
          text = o.getString("text"),
          speakerId = o.optString("speakerId").ifEmpty { null },
        )
      }
    }
    val speakers = input.getJSONArray("speakers").let { arr ->
      (0 until arr.length()).map { i ->
        val o = arr.getJSONObject(i)
        Spk(o.getString("id"), o.optString("displayName"))
      }
    }

    val expected: JSONArray = g.getJSONArray("output")
    val actual = Minutes.extract(utterances, speakers)
    println("MINUTES[$name]: ${actual.size} item(s) from ${utterances.size} utterance(s)")

    assertEquals("$name: wrong number of minutes", expected.length(), actual.size)
    for (i in 0 until expected.length()) {
      val want = expected.getJSONObject(i)
      assertEquals("$name[$i].kind", want.getString("kind"), actual[i].kind)
      assertEquals("$name[$i].content", want.getString("content"), actual[i].content)
      assertEquals("$name[$i].source", want.getString("source"), actual[i].source)
    }
  }

  @Test
  fun meeting_transcript_matches_the_typescript_golden() {
    ensureCore()
    assertGoldenMatches("minutes_meeting.json")
  }

  /**
   * The rule-level cases inherited from the deleted MinutesExtractorTest: standalone decision,
   * named owner + due date, a question with no question mark, and the NAMED_OWNER exclusion list
   * (so "This will…" resolves to Unassigned rather than reporting "This" as a person).
   */
  @Test
  fun rule_level_cases_match_the_typescript_golden() {
    ensureCore()
    assertGoldenMatches("minutes_rules.json")
  }

  /** Dedup keys on composed content, so the same words from two speakers stay two actions. */
  @Test
  fun action_dedup_matches_the_typescript_golden() {
    ensureCore()
    assertGoldenMatches("minutes_dedup.json")
  }

  /** Decisions are stored verbatim, so norm() collapses case/punctuation variants to one. */
  @Test
  fun decision_dedup_matches_the_typescript_golden() {
    ensureCore()
    assertGoldenMatches("minutes_decision_dedup.json")
  }

  /** A question is never also an action, and a decision outranks an action. */
  @Test
  fun classification_priority_matches_the_typescript_golden() {
    ensureCore()
    assertGoldenMatches("minutes_priority.json")
  }

  /**
   * Guards the marshalling rather than the rules: every utterance is unassigned and there are no
   * speaker rows at all — the shape a single-speaker meeting (or one where diarization was
   * skipped) actually produces. A null speakerId has to survive as "" across the JNI boundary and
   * still resolve owners to Unassigned.
   */
  @Test
  fun unassigned_speakers_survive_the_jni_boundary() {
    ensureCore()
    assertGoldenMatches("minutes_unassigned.json")
  }

  /** An empty transcript must still produce the zero-counts summary, not an empty list or a crash. */
  @Test
  fun empty_transcript_yields_the_zero_summary() {
    ensureCore()
    assertGoldenMatches("minutes_empty.json")
  }
}
