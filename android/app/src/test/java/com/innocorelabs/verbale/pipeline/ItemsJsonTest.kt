package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Kotlin half of the evidence boundary, driven with literal JSON and no JNI.
 *
 * `Minutes.extractItems` is two things stacked: a native call and a parse. Only the first needs a
 * phone, so the parse is a separate function and this test drives it on the JVM. The strings below
 * are not invented — they are the exact bytes `audionotes::itemsToJson` emits for the goldens in
 * cpp/tests/golden, which cpp/tests/test_evidence.cpp checks field-for-field against the
 * TypeScript's own output. Between the two tests the only thing left unproven is the marshalling
 * itself, which EvidenceParityTest covers and which needs a device.
 *
 * Regenerate a literal by running itemsToJson over the named golden if a fixture ever changes.
 */
class ItemsJsonTest {
  /** cpp/tests/golden/evidence_unassigned.json — a null speakerId, which crosses JNI as "". */
  private val unassigned =
    """[{"kind":"decision","text":"We decided to ship on Friday.","sources":[{"utteranceId":"u0",""" +
      """"startMs":0,"endMs":4000,"charStart":0,"charEnd":29}],"anchorStartMs":0,""" +
      """"anchorEndMs":4000},{"kind":"action","text":"I will send the notes tomorrow. — """ +
      """Unassigned (due tomorrow)","sources":[{"utteranceId":"u1","startMs":4000,"endMs":8000,""" +
      """"charStart":0,"charEnd":31}],"anchorStartMs":4000,"anchorEndMs":8000}]"""

  /** cpp/tests/golden/evidence_dedup.json — the first item is one item with TWO sources. */
  private val dedup =
    """[{"kind":"action","text":"I'll send the report by Friday. — Speaker 1 (due by """ +
      """Friday)","sources":[{"utteranceId":"u0","startMs":0,"endMs":4000,"charStart":0,""" +
      """"charEnd":31},{"utteranceId":"u0","startMs":0,"endMs":4000,"charStart":32,""" +
      """"charEnd":63}],"anchorStartMs":0,"anchorEndMs":4000},{"kind":"action","text":"i'll """ +
      """send THE REPORT by friday! — Speaker 2 (due by friday)","sources":[""" +
      """{"utteranceId":"u1","startMs":4000,"endMs":8000,"charStart":0,"charEnd":31}],""" +
      """"anchorStartMs":4000,"anchorEndMs":8000}]"""

  @Test fun readsEveryFieldOfEveryItem() {
    val items = Minutes.parseItems(unassigned)
    assertEquals(2, items.size)

    val decision = items[0]
    assertEquals("decision", decision.kind)
    assertEquals("We decided to ship on Friday.", decision.text)
    assertEquals(0L, decision.anchorStartMs)
    assertEquals(4000L, decision.anchorEndMs)
    assertEquals(1, decision.sources.size)
    assertEquals("u0", decision.sources[0].utteranceId)
    assertEquals(0L, decision.sources[0].startMs)
    assertEquals(4000L, decision.sources[0].endMs)
    assertEquals(0, decision.sources[0].charStart)
    assertEquals(29, decision.sources[0].charEnd)

    val action = items[1]
    assertEquals("action", action.kind)
    // The owner suffix a null speakerId produces. "" and null are the same thing at this boundary
    // — Kotlin cannot put a null in an Array<String> — and the C++ treats an empty id as
    // unassigned, which is what this string is evidence of.
    assertEquals("I will send the notes tomorrow. — Unassigned (due tomorrow)", action.text)
    assertEquals(4000L, action.anchorStartMs)
    assertEquals(8000L, action.anchorEndMs)
  }

  /**
   * The reason the payload is JSON and not the parallel string arrays the rest of the bridge uses:
   * a sentence said twice is ONE item with TWO sources, and the count varies per item. Parallel
   * arrays would need a second array of per-item counts and matching index arithmetic on both
   * sides.
   */
  @Test fun anItemCarriesAVariableNumberOfSources() {
    val items = Minutes.parseItems(dedup)
    assertEquals(2, items.size)
    assertEquals(2, items[0].sources.size)
    assertEquals(1, items[1].sources.size)
    assertEquals(0, items[0].sources[0].charStart)
    assertEquals(32, items[0].sources[1].charStart)
    assertEquals(63, items[0].sources[1].charEnd)
  }

  @Test fun anEmptyMeetingIsAnEmptyList() {
    assertEquals(emptyList<Minutes.Item>(), Minutes.parseItems("[]"))
  }

  /**
   * charStart/charEnd are UTF-16 code units and cross the boundary as they are, because a Kotlin
   * string is UTF-16 and can be indexed with them directly. Converting them anywhere would be a
   * bug visible only on a transcript containing an astral character — an emoji, which is one
   * UTF-16 unit in neither bytes nor code points.
   *
   * Both rows come from cpp/tests/golden/evidence_spans.json.
   */
  @Test fun spansAreUtf16UnitsAndIndexTheTurnDirectly() {
    val json =
      """[{"kind":"question","text":"🚀🚀?","sources":[{"utteranceId":"u6",""" +
        """"startMs":26500,"endMs":30500,"charStart":0,"charEnd":5}],"anchorStartMs":26500,""" +
        """"anchorEndMs":30500}]"""
    val src = Minutes.parseItems(json).single().sources.single()
    val turn = "🚀🚀?"
    // Two astral characters plus '?': 5 UTF-16 units, 9 UTF-8 bytes, 3 code points.
    assertEquals(0, src.charStart)
    assertEquals(5, src.charEnd)
    assertEquals(turn, turn.substring(src.charStart, src.charEnd))
  }

  /**
   * The trap this whole design exists to avoid: an item's text is NOT the turn sliced by its span.
   *
   * The offsets index the turn as recorded; the text comes from a copy with U+2019 folded to an
   * ASCII apostrophe and whitespace runs collapsed. Whisper emits curly apostrophes constantly, so
   * a consumer that reconstructed the text by slicing would be wrong on most real meetings. The
   * text is carried explicitly for exactly that reason, and this pins it with a real golden row.
   */
  @Test fun theTextIsCarried_notReconstructedFromTheSpan() {
    val json =
      """[{"kind":"decision","text":"We agreed to ship on Monday.","sources":[""" +
        """{"utteranceId":"u3","startMs":14500,"endMs":18500,"charStart":25,"charEnd":55}],""" +
        """"anchorStartMs":14500,"anchorEndMs":18500}]"""
    val item = Minutes.parseItems(json).single()
    val turn = "Priya said “ship it” 🚀. We agreed   to ship on\nMonday."
    val sliced = turn.substring(item.sources[0].charStart, item.sources[0].charEnd)
    // The span is right — it selects the sentence, and it is the range to highlight in the turn.
    assertTrue(sliced.startsWith("We agreed"))
    assertTrue(sliced.endsWith("Monday."))
    // ...and it is not the item text: the whitespace run and the newline are still in the turn.
    assertNotEquals(item.text, sliced)
    assertEquals("We agreed to ship on Monday.", item.text)
  }
}
