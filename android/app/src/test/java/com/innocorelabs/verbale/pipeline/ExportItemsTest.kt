package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.data.ItemKey
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The document people forward, and the first test it has ever had.
 *
 * Until this file the whole export renderer was untested — not thinly tested, untested: it could
 * only be reached by constructing a React module, which a JVM test cannot do, so nothing in the
 * tree had ever asserted what an exported meeting looks like. It is also the one artefact of this
 * app that travels on its own, to people who were not in the room and cannot check a claim against
 * their memory of it. That is the whole argument for the timestamps this task adds, and it is the
 * same argument for testing the thing that prints them.
 *
 * The renderers are pure functions of [FileExportModule.Content] and the reads are not, which is
 * why the class was split that way rather than given a `*ForTest` accessor: a seam that exists only
 * for a test is a second description of the export format, and the one people notice drifting is
 * the one they sent to a client.
 */
class ExportItemsTest {

  // ---- Fixtures ---------------------------------------------------------------------------

  private fun itemRow(id: String, kind: String, text: String, anchorStartMs: Long) =
    JSONObject().put("id", id).put("kind", kind).put("text", text)
      .put("anchor_start_ms", anchorStartMs)

  private fun minuteRow(kind: String, content: String, source: String = "rule") =
    JSONObject().put("kind", kind).put("content", content).put("source", source)

  private fun rows(vararg o: JSONObject) = JSONArray().apply { o.forEach { put(it) } }

  private fun content(
    items: List<FileExportModule.ExportItem> = emptyList(),
    summary: String? = null,
    narrative: String? = null,
    turns: List<FileExportModule.ExportTurn> = emptyList(),
  ) = FileExportModule.Content("Design review", 0L, summary, narrative, items, turns)

  /** The three section headings, so a test can say "under Action items" without a magic string. */
  private fun sectionOf(md: String, heading: String): String =
    md.substringAfter("## $heading\n\n").substringBefore("\n## ")

  /**
   * The same, for the plain-text format, which spells its headings in capitals.
   *
   * `substringAfter` returns the WHOLE string when the delimiter is absent, which is the property
   * that makes this an assertion about the heading as well as about the rows under it: lose the
   * heading line, or lose its `.uppercase`, and the comparison is against the entire document.
   */
  private fun textSectionOf(txt: String, heading: String): String =
    txt.substringAfter("$heading\n").substringBefore("\n\n")

  // ---- The stamp --------------------------------------------------------------------------

  /**
   * THE MIRROR. `stamp` reproduces `provenanceLabel` in src/screens/meeting/ItemProvenance.tsx, and
   * these are the same vectors ItemProvenance.test.tsx asserts — the arrangement `ItemKeyTest` and
   * `itemKey` already have, and for the same reason: two implementations of one format are two
   * chances to drift, and a shared table of values is the only thing that stops them.
   *
   * The hour boundary is in the table because it is where a format like this actually breaks: an
   * hour-long meeting is ordinary here, `59:59` and `1:00:00` are one millisecond apart, and a
   * missing `%02d` on the middle field turns the second into `1:0:00` for a whole hour of any
   * meeting that runs long. Zero is in it because an item said in the first second must read
   * `0:00`, not `:00` or `0:0`.
   */
  @Test fun theStampReadsTheWayTheScreenSaysIt() {
    assertEquals("0:00", FileExportModule.stamp(0L))
    assertEquals("1:05", FileExportModule.stamp(65_000L))
    assertEquals("59:59", FileExportModule.stamp(3_599_999L))
    assertEquals("1:00:00", FileExportModule.stamp(3_600_000L))
    assertEquals("1:02:05", FileExportModule.stamp(3_725_000L))
  }

  /**
   * A nonsense anchor reads as the start of the meeting, never as a negative time.
   *
   * A WHOLE negative second, not `-1`, and mutation testing is what said so. `-1` cannot fail this
   * assertion on THIS side of the mirror: Kotlin's integer division truncates toward zero, so
   * `-1 / 1000` is already 0 and the clamp is never reached. It does fail on the JavaScript side,
   * where `Math.floor` rounds toward negative infinity and `-1` becomes `-1` — which is exactly
   * how a shared table of vectors can be strong in one language and vacuous in the other.
   */
  @Test fun theStampDoesNotRunBackwards() {
    assertEquals("0:00", FileExportModule.stamp(-1_000L))
    assertEquals("0:00", FileExportModule.stamp(-1L))
  }

  // ---- The line ---------------------------------------------------------------------------

  /**
   * The reason this task exists: an exported action says when it was said.
   *
   * And the stamp LEADS the line. A reader scanning a forwarded document finds the moment without
   * reading the sentence, and the part of the line the reader relies on is the part the writer's
   * correction cannot reach — see [aCorrectionReplacesTheTextAndLeavesTheStampWhereItWas].
   */
  @Test fun anExportedActionCarriesTheMomentItWasSaid() {
    val md = FileExportModule.renderMarkdown(
      content(items = listOf(FileExportModule.ExportItem("action", "Send the report — Priya", 3_725_000L))),
    )
    assertTrue(
      "the timestamp is what makes a forwarded claim checkable",
      md.contains("- [1:02:05] Send the report — Priya\n"),
    )
  }

  /** The plain-text export is the same document, so it carries the same stamp. */
  @Test fun thePlainTextExportCarriesItToo() {
    val txt = FileExportModule.renderText(
      content(items = listOf(FileExportModule.ExportItem("action", "Send the report — Priya", 3_725_000L))),
    )
    assertTrue(txt.contains("  - [1:02:05] Send the report — Priya\n"))
  }

  /**
   * ...and the same headings, and the same order.
   *
   * Held to the same bar as the Markdown rather than to a single substring, because "the same
   * document in four layouts" is a claim that only holds where something checks it. A lone
   * `contains` on one bullet left three mutants alive here that the Markdown killed outright:
   * dropping `.uppercase(Locale.US)` from the headings, deleting the heading line, and sorting the
   * rows alphabetically. The two actions are in reverse alphabetical order for that last one — see
   * [itemsAreExportedInTheOrderTheyWereSaid], which learned it the hard way.
   */
  @Test fun thePlainTextExportIsTheSameDocumentInTheSameOrder() {
    val txt = FileExportModule.renderText(
      content(
        items = listOf(
          FileExportModule.ExportItem("action", "Write up the notes", 61_000L),
          FileExportModule.ExportItem("decision", "A decision in between", 90_000L),
          FileExportModule.ExportItem("action", "Book the room", 125_000L),
        ),
      ),
    )
    assertEquals(
      "  - [1:01] Write up the notes\n  - [2:05] Book the room",
      textSectionOf(txt, "ACTION ITEMS"),
    )
    assertEquals("  - [1:30] A decision in between", textSectionOf(txt, "DECISIONS"))
  }

  /**
   * A correction rewrites what was said and cannot touch WHEN it was said.
   *
   * The user owns the wording; nobody owns the moment. Keyed on the item's id rather than on a hash
   * of the text, which is what lets the correction survive the item being re-worded by a reprocess
   * — the same property `item_done` gives a tick.
   */
  @Test fun aCorrectionReplacesTheTextAndLeavesTheStampWhereItWas() {
    val items = FileExportModule.exportItems(
      rows(itemRow("it-1", "action", "Send the report — Priya", 3_725_000L)),
      rows(),
      mapOf("item/it-1" to "Send the Q3 report — Priya, by Friday"),
    )
    val md = FileExportModule.renderMarkdown(content(items = items))
    assertTrue("the user's own words did not reach the document", md.contains("Q3"))
    assertFalse("the pipeline's text was exported over the user's", md.contains("- [1:02:05] Send the report — Priya"))
    assertTrue(
      "the correction moved the moment it was said",
      md.contains("- [1:02:05] Send the Q3 report — Priya, by Friday\n"),
    )
  }

  // ---- Where the rows come from -----------------------------------------------------------

  /**
   * Items come from `items`; the summary and the write-up still come from `minutes`.
   *
   * The tables split at Task 5 and only half of the meeting moved. An export that read one table
   * would lose whichever half it did not.
   */
  @Test fun theProseStillComesFromTheMinutes() {
    val minutes = rows(
      minuteRow("summary", "1 action item, 0 decisions."),
      minuteRow("narrative", "The team walked through the roadmap.", source = "llm"),
      minuteRow("action", "Send the report — Priya"),
    )
    val md = FileExportModule.renderMarkdown(
      content(
        summary = FileExportModule.summaryOf(minutes, emptyMap()),
        narrative = FileExportModule.narrativeOf(minutes, emptyMap()),
        items = FileExportModule.exportItems(
          rows(itemRow("it-1", "action", "Send the report — Priya", 65_000L)), minutes, emptyMap(),
        ),
      ),
    )
    assertTrue(md.contains("1 action item, 0 decisions."))
    assertTrue(md.contains("## Minutes\n\nThe team walked through the roadmap."))
    assertEquals(
      "the rule minute was exported alongside the item that replaced it — every action twice",
      "- [1:05] Send the report — Priya\n", sectionOf(md, "Action items"),
    )
  }

  /**
   * A decision somebody typed themselves still reaches the document they typed it for.
   *
   * `db.addUserMinute` writes a `minutes` row with no item until Task 12, so an export that read
   * `items` alone would drop it — silently, since nothing counts the rows. The same merge
   * `toItemRows` makes for the tabs, for the same reason.
   */
  @Test fun aHandTypedRowIsStillExported() {
    val items = FileExportModule.exportItems(
      rows(itemRow("it-1", "action", "Send the report — Priya", 65_000L)),
      rows(
        minuteRow("action", "Send the report — Priya"),
        minuteRow("decision", "Ship on the 14th", source = "user"),
      ),
      emptyMap(),
    )
    val md = FileExportModule.renderMarkdown(content(items = items))
    assertEquals("- Ship on the 14th\n", sectionOf(md, "Decisions"))
  }

  /**
   * ...and it carries no timestamp, because nobody ever said it.
   *
   * `[0:00]` would be a fabricated claim about a moment: it sends a reader to the top of the
   * recording to look for a sentence that was never spoken there. Task 12's rule, arrived at
   * early — an item with no evidence is not a failure to find any; it is one that never claimed any.
   */
  @Test fun aHandTypedRowIsNotStampedWithAMomentNobodySpoke() {
    val items = FileExportModule.exportItems(
      rows(), rows(minuteRow("decision", "Ship on the 14th", source = "user")), emptyMap(),
    )
    assertEquals(listOf<Long?>(null), items.map { it.anchorStartMs })
    assertFalse(
      "a row nobody said was stamped with the start of the meeting",
      FileExportModule.renderMarkdown(content(items = items)).contains("0:00"),
    )
  }

  /**
   * A correction to a hand-typed row still resolves, because that row has no id to key it on.
   *
   * Both key shapes are live at once until Task 12 moves these rows into `items`, exactly as two
   * tick stores are live at once for the same population and the same reason.
   */
  @Test fun aCorrectionToAHandTypedRowStillResolvesOnItsTextHash() {
    val items = FileExportModule.exportItems(
      rows(),
      rows(minuteRow("decision", "Ship on the 14th", source = "user")),
      mapOf("minute/" + ItemKey.of("Ship on the 14th") to "Ship on the 21st"),
    )
    assertEquals(listOf("Ship on the 21st"), items.map { it.text })
  }

  /**
   * A meeting whose migration has not run exports its `minutes` rather than nothing.
   *
   * `ensureItems` needs the native core and the meeting screen swallows its failure on purpose, so
   * a pre-items meeting can be on screen and exported. Items-only would hand somebody a document
   * whose summary counts seven actions above a page with no actions on it. It heals on the next
   * open, and it costs one boolean — the alternative is exporting somebody nothing.
   */
  @Test fun aMeetingWithNoItemsFallsBackToItsMinutes() {
    val items = FileExportModule.exportItems(
      rows(),
      rows(minuteRow("action", "Send the report — Priya"), minuteRow("summary", "One action.")),
      emptyMap(),
    )
    assertEquals(listOf("Send the report — Priya"), items.map { it.text })
    assertEquals("a minutes fallback row invented an anchor", listOf<Long?>(null), items.map { it.anchorStartMs })
  }

  // ---- The PDF ------------------------------------------------------------------------------

  /**
   * THE FORMAT THE ARGUMENT IS ABOUT, and the one nothing was checking.
   *
   * The case for stamping an item at all is that an exported document gets forwarded to people who
   * were not in the room, which is exactly where an unverifiable claim does harm. The PDF is the
   * format that gets forwarded — the Markdown renders as raw asterisks in most mail clients, which
   * is why PdfExport exists at all. It satisfied the rule in production because it calls the same
   * `bullet`, and nothing whatever pinned that: stripping the stamp from every PDF bullet passed
   * all 162 Kotlin tests, and so did deleting the three item sections from the PDF outright.
   *
   * `pdfBlocks` was made public and moved into the companion PRECISELY so a JVM test could reach
   * it, and then no test reached it. A seam built for a test that no test uses is the same defect
   * twice over.
   */
  @Test fun theForwardedPdfCarriesTheStampToo() {
    val blocks = FileExportModule.pdfBlocks(
      content(items = listOf(FileExportModule.ExportItem("action", "Send the report — Priya", 3_725_000L))),
    )
    assertTrue(
      "the PDF is the format people actually forward, and it lost the moment",
      blocks.any { it.text == "•  [1:02:05] Send the report — Priya" },
    )
  }

  /** And it carries the sections themselves, under the same three headings as every other format. */
  @Test fun theForwardedPdfCarriesEverySection() {
    val blocks = FileExportModule.pdfBlocks(
      content(
        items = listOf(
          FileExportModule.ExportItem("decision", "Ship on the 14th", 61_000L),
          FileExportModule.ExportItem("action", "Send the report — Priya", 125_000L),
          FileExportModule.ExportItem("question", "Who owns renewals?", 200_000L),
        ),
      ),
    )
    val text = blocks.map { it.text }
    assertEquals(
      "the PDF lost a whole section of the meeting",
      listOf("Decisions", "Action items", "Open questions"),
      text.filter { it in setOf("Decisions", "Action items", "Open questions") },
    )
    assertTrue(text.contains("•  [1:01] Ship on the 14th"))
    assertTrue(text.contains("•  [2:05] Send the report — Priya"))
    assertTrue(text.contains("•  [3:20] Who owns renewals?"))
  }

  /** A row nobody said gets no stamp in the PDF either — same rule, all four formats. */
  @Test fun theForwardedPdfDoesNotStampARowNobodySpoke() {
    val blocks = FileExportModule.pdfBlocks(
      content(items = listOf(FileExportModule.ExportItem("decision", "Ship on the 14th", null))),
    )
    assertTrue(blocks.any { it.text == "•  Ship on the 14th" })
  }

  // ---- Order --------------------------------------------------------------------------------

  /**
   * The document reads in the order the meeting happened.
   *
   * The SELECT orders by `anchor_start_ms`; this pins that nothing between it and the page
   * re-orders the rows — the grouping into sections is a filter, and a filter that sorted, or a
   * map that lost the order, would put the last decision of the meeting at the top of the page
   * with a timestamp beside it saying otherwise.
   *
   * The two actions are in REVERSE alphabetical order on purpose. The first version of this test
   * used "First thing" and "Second thing", which are already sorted, so inserting a `sortedBy` into
   * the renderer changed nothing and the test could not fail on the defect it names — found by
   * mutating the renderer rather than by reading it. The decision between them is there so a filter
   * that leaked one kind into another's section would fail too.
   */
  @Test fun itemsAreExportedInTheOrderTheyWereSaid() {
    val md = FileExportModule.renderMarkdown(
      content(
        items = listOf(
          FileExportModule.ExportItem("action", "Write up the notes", 61_000L),
          FileExportModule.ExportItem("decision", "A decision in between", 90_000L),
          FileExportModule.ExportItem("action", "Book the room", 125_000L),
        ),
      ),
    )
    assertEquals(
      "- [1:01] Write up the notes\n- [2:05] Book the room\n", sectionOf(md, "Action items"),
    )
  }
}
