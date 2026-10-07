package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ItemKey
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Workstream E: the document a person shares, as the preview shows it and as the files carry it.
 *
 * Every test here is about one promise: what is shared is what was reviewed in the app, and it
 * says what the meeting did not settle instead of guessing.
 */
class ShareDocumentTest {

  private val on = ShareDocument.Options(attribution = true)
  private val off = ShareDocument.Options(attribution = false)

  private fun itemRow(
    id: String, kind: String, text: String, anchor: Long = 61_000L, gen: String = Minutes.RULES_GEN,
  ) = JSONObject().put("id", id).put("kind", kind).put("text", text)
    .put("anchor_start_ms", anchor).put("gen_version", gen)

  private fun rows(vararg o: JSONObject) = JSONArray().apply { o.forEach { put(it) } }

  private fun items(
    vararg r: JSONObject,
    names: Map<String, String?> = emptyMap(),
    edits: Map<String, String> = emptyMap(),
    doneIds: Set<String> = emptySet(),
    doneKeys: Set<String> = emptySet(),
  ) = FileExportModule.exportItems(rows(*r), rows(), edits, names, doneIds, doneKeys)

  private fun turns() = listOf(
    FileExportModule.ExportTurn("Priya", "We agreed to ship on Monday.", 61_000L, 64_000L),
    FileExportModule.ExportTurn("Ravi", "I will send the report by Friday.", 125_000L, 129_000L),
  )

  private fun content(
    items: List<FileExportModule.ExportItem> = emptyList(),
    summary: String? = null,
    narrative: String? = null,
    turns: List<FileExportModule.ExportTurn> = turns(),
  ) = FileExportModule.Content("Design review", 0L, summary, narrative, items, turns)

  private fun composed(c: FileExportModule.Content, format: String, o: ShareDocument.Options, marker: String? = null) =
    FileExportModule.compose(c, format, marker, o)

  private fun md(c: FileExportModule.Content, o: ShareDocument.Options = off) = composed(c, "md", o).body

  private fun actionLine(md: String, containing: String) =
    md.lines().single { it.startsWith("- ") && it.contains(containing) }

  // ---- 1. One source of truth: the preview is the file ---------------------------------------

  /** The preview of the Markdown format is the Markdown export body, character for character. */
  @Test fun thePreviewIsTheMarkdownExportBody() {
    val its = items(
      itemRow("a", "action", "Send the report — Priya (due Friday)"),
      itemRow("b", "action", "Book the room — Unassigned", 90_000L),
      itemRow("d", "decision", "Ship on the 14th", 30_000L),
    )
    val c = content(its, summary = "Two actions.", narrative = "We met.")
    for (o in listOf(off, on)) {
      val file = composed(c, "md", o)
      assertEquals(file.body, FileExportModule.previewText(file))
      assertEquals(FileExportModule.renderMarkdown(c, o), FileExportModule.previewText(file))
    }
  }

  @Test fun thePreviewOfTheTextAndSubtitleFormatsIsTheirOwnBody() {
    val c = content(items(itemRow("a", "action", "Send the report — Priya")))
    for (f in listOf("txt", "srt")) {
      val file = composed(c, f, on)
      assertEquals(file.body, FileExportModule.previewText(file))
    }
  }

  /** A PDF has no text body: its preview is the words of its blocks, in page order. */
  @Test fun thePdfPreviewIsTheWordsOnItsPages() {
    val c = content(items(itemRow("a", "action", "Send the report — Priya (due Friday)")), summary = "One action.")
    val file = composed(c, "pdf", on)
    assertEquals(file.blocks!!.joinToString("\n") { it.text }, FileExportModule.previewText(file))
    assertTrue(FileExportModule.previewText(file).contains("Send the report — Priya (due Friday)"))
    assertTrue(FileExportModule.previewText(file).endsWith(ShareDocument.ATTRIBUTION))
  }

  // ---- 1. Unresolved details are written down, never guessed ---------------------------------

  @Test fun anActionWithNoOwnerSaysOwnerNotSet() {
    val line = actionLine(md(content(items(itemRow("a", "action", "Book the room — Unassigned (due Friday)")))), "Book the room")
    assertEquals("- [1:01] Book the room (due Friday) · Owner not set", line)
  }

  @Test fun anActionWithNoDateSaysNoDateGiven() {
    val line = actionLine(md(content(items(itemRow("a", "action", "Send the report — Priya")))), "Send the report")
    assertEquals("- [1:01] Send the report — Priya · No date given", line)
  }

  @Test fun anActionWithNeitherSaysBothAndNamesNobody() {
    val its = items(itemRow("a", "action", "Book the room"), names = mapOf("s1" to "Priya", "s2" to "Ravi"))
    val line = actionLine(md(content(its)), "Book the room")
    assertEquals("- [1:01] Book the room · Owner not set · No date given", line)
    // Nothing was invented: no speaker's name and no date appears anywhere on the line.
    assertFalse(line.contains("Priya"))
    assertFalse(line.contains("Ravi"))
    assertFalse(line.contains("due"))
  }

  /** The extractor's "— Unassigned" never reaches a reader as if it were a name. */
  @Test fun unassignedIsNeverPrintedAsAnOwner() {
    val out = md(content(items(itemRow("a", "action", "Book the room — Unassigned"))))
    assertFalse(out, out.contains("Unassigned"))
    assertTrue(out, out.contains("Owner not set"))
  }

  @Test fun anActionWithBothOwnerAndDateAddsNoFlag() {
    val line = actionLine(md(content(items(itemRow("a", "action", "Send the report — Priya (due Friday)")))), "Send")
    assertEquals("- [1:01] Send the report — Priya (due Friday)", line)
  }

  /** A date the classifier normalised counts as a date, whatever the words say. */
  @Test fun aNormalisedDateIsADate() {
    val its = items(itemRow("a", "action", "Send the report — Priya").put("date_norm", 1789689600000L).put("item_type", "commitment"))
    val line = actionLine(md(content(its)), "Send")
    assertFalse(line, line.contains("No date given"))
  }

  /** A date that was SAID but could not be normalised is not "no date given". */
  @Test fun aDateThatWasSaidIsNotNoDateGiven() {
    val its = items(itemRow("a", "action", "Send the report — Priya").put("date_said", "next Thursday"))
    assertFalse(actionLine(md(content(its)), "Send").contains("No date given"))
  }

  /** Only actions have an owner and a due date to be missing. */
  @Test fun aDecisionAndAQuestionAreNotAskedForOwnerOrDate() {
    val out = md(content(items(itemRow("d", "decision", "Ship on the 14th"), itemRow("q", "question", "Who owns renewals?", 70_000L))))
    assertFalse(out, out.contains("Owner not set"))
    assertFalse(out, out.contains("No date given"))
  }

  @Test fun anItemTheReviewQueueIsHoldingSaysNeedsALook() {
    val its = items(
      itemRow("d", "decision", "Ship on the 14th").put("review", "needs_review").put("item_type", "agreement"),
      itemRow("a", "action", "Send the report — Priya (due Friday)", 70_000L).put("review", "needs_review").put("item_type", "request"),
    )
    val out = md(content(its))
    assertTrue(out, out.contains("- [1:01] Ship on the 14th · Agreement · Needs a look\n"))
    assertTrue(out, out.contains("- [1:10] Send the report — Priya (due Friday) · Request · Needs a look\n"))
  }

  /** The reconciler's own ambiguity flag on a row nothing classified is not what the queue shows. */
  @Test fun theMachinesOwnFlagOnAnUnclassifiedRowIsNotNeedsALook() {
    val its = items(itemRow("d", "decision", "Ship on the 14th").put("review", "needs_review"))
    assertFalse(md(content(its)).contains("Needs a look"))
  }

  @Test fun aTickedItemShowsAsDone() {
    val its = items(
      itemRow("a", "action", "Send the report — Priya (due Friday)"),
      itemRow("b", "action", "Book the room — Ravi (due Monday)", 90_000L),
      doneIds = setOf("a"),
    )
    val out = md(content(its))
    assertTrue(out, out.contains("- [1:01] Send the report — Priya (due Friday) · Done\n"))
    assertTrue(out, out.contains("- [1:30] Book the room — Ravi (due Monday)\n"))
  }

  /** A tick written before items had ids is keyed on a hash of the stored text. */
  @Test fun aTickKeyedOnTheOldTextHashShowsAsDone() {
    val stored = "Send the report — Priya (due Friday)"
    val its = items(itemRow("a", "action", stored), doneKeys = setOf(ItemKey.of(stored)))
    assertTrue(md(content(its)).contains("· Done"))
  }

  /** The tick is keyed on the stored words: a hand correction does not untick it. */
  @Test fun aCorrectedItemStaysDone() {
    val stored = "Send the report — Priya (due Friday)"
    val its = items(
      itemRow("a", "action", stored),
      edits = mapOf("item/a" to "Send the Q3 report — Priya (due Friday)"),
      doneKeys = setOf(ItemKey.of(stored)),
    )
    assertTrue(md(content(its)).contains("- [1:01] Send the Q3 report — Priya (due Friday) · Done"))
  }

  @Test fun aHandTypedItemIsIncludedWithNothingInventedForIt() {
    val typed = itemRow("u", "action", "Call the vendor", AudioDb.Gen.NO_ANCHOR, AudioDb.Gen.USER)
    val line = actionLine(md(content(items(typed))), "Call the vendor")
    assertEquals("- Call the vendor · Owner not set · No date given", line)
  }

  /** The owner was renamed after the meeting: the document says the new name, never the old. */
  @Test fun aRenamedOwnerIsTheNameInTheDocument() {
    val owner = JSONObject().put("kind", "speaker").put("id", "s1").toString()
    val its = items(
      itemRow("a", "action", "Send the report — Speaker 1 (due Friday)").put("owner_json", owner),
      names = mapOf("s1" to "Priya"),
    )
    val out = md(content(its))
    assertTrue(out, out.contains("- [1:01] Send the report — Priya (due Friday)\n"))
    assertFalse(out, out.contains("Speaker 1"))
    for (format in listOf("txt", "pdf")) {
      val body = FileExportModule.previewText(composed(content(its), format, off))
      assertTrue("$format: $body", body.contains("Send the report — Priya (due Friday)"))
      assertFalse(format, body.contains("Speaker 1"))
    }
  }

  // ---- PDF: unresolved flags are drawn differently --------------------------------------------

  @Test fun thePdfDrawsFlagsInTheirOwnLineInAmber() {
    val blocks = FileExportModule.pdfBlocks(content(items(itemRow("a", "action", "Book the room"))))
    val i = blocks.indexOfFirst { it.text == "•  [1:01] Book the room" }
    assertTrue(blocks.map { it.text }.toString(), i >= 0)
    val flags = blocks[i + 1]
    assertEquals("Owner not set · No date given", flags.text)
    assertTrue("bold: this is what the reader must not miss", flags.bold)
    assertNotEquals("amber, not the body's black", blocks[i].color, flags.color)
  }

  @Test fun aDoneOnlyFlagIsGreyAndNotBold() {
    val its = items(itemRow("a", "action", "Send the report — Priya (due Friday)"), doneIds = setOf("a"))
    val blocks = FileExportModule.pdfBlocks(content(its))
    val flags = blocks[blocks.indexOfFirst { it.text.startsWith("•  [1:01] Send") } + 1]
    assertEquals("Done", flags.text)
    assertFalse(flags.bold)
  }

  // ---- 2. The attribution ------------------------------------------------------------------

  private fun everyFormat(c: FileExportModule.Content, o: ShareDocument.Options) =
    mapOf(
      "md" to FileExportModule.previewText(composed(c, "md", o)),
      "txt" to FileExportModule.previewText(composed(c, "txt", o)),
      "pdf" to FileExportModule.previewText(composed(c, "pdf", o)),
      "srt" to FileExportModule.previewText(composed(c, "srt", o)),
      "transcript" to FileExportModule.previewText(composed(c, "transcript", o)),
    )

  private fun full() = content(
    items(itemRow("a", "action", "Send the report — Priya (due Friday)")),
    summary = "One action.", narrative = "We met and agreed.",
  )

  @Test fun offTheAttributionIsInNoFormat() {
    for ((f, out) in everyFormat(full(), off)) {
      assertFalse("$f: $out", out.contains("Created with Verbale"))
    }
  }

  @Test fun theAttributionIsOffByDefault() {
    assertFalse(ShareDocument.Options().attribution)
    assertFalse(FileExportModule.renderMarkdown(full()).contains("Created with Verbale"))
    assertFalse(FileExportModule.renderText(full()).contains("Created with Verbale"))
    assertFalse(FileExportModule.pdfBlocks(full()).any { it.text.contains("Created with Verbale") })
  }

  @Test fun onTheAttributionIsOneLineAtTheEndOfMarkdownAndText() {
    val all = everyFormat(full(), on)
    for (f in listOf("md", "txt")) {
      val out = all.getValue(f)
      assertEquals("$f: exactly once", 1, Regex(Regex.escape(ShareDocument.ATTRIBUTION)).findAll(out).count())
      assertTrue("$f: at the very end", out.trimEnd().endsWith(ShareDocument.ATTRIBUTION) || out.trimEnd().endsWith("*" + ShareDocument.ATTRIBUTION + "*"))
      // Never above content: nothing of the document comes after it.
      assertEquals("$f", "", out.substringAfter(ShareDocument.ATTRIBUTION).replace("*", "").trim())
      assertTrue("$f: below the transcript", out.indexOf("Transcript", ignoreCase = true) < out.indexOf("Created with Verbale"))
    }
  }

  @Test fun theAttributionTextIsExactlyThePromisedLine() {
    assertEquals("Created with Verbale — private meeting notes", ShareDocument.ATTRIBUTION)
  }

  @Test fun subtitlesAndTheCopiedTranscriptNeverCarryIt() {
    val all = everyFormat(full(), on)
    assertFalse(all.getValue("srt").contains("Created with Verbale"))
    assertFalse(all.getValue("transcript").contains("Created with Verbale"))
  }

  /** The PDF: one small grey block, last, after the body — placement and look, no device needed. */
  @Test fun thePdfAttributionIsASmallGreyLastBlock() {
    val blocks = composed(full(), "pdf", on).blocks!!
    assertEquals(1, blocks.count { it.text == ShareDocument.ATTRIBUTION })
    val footer = blocks.last()
    assertEquals(ShareDocument.ATTRIBUTION, footer.text)
    assertTrue("smaller than every body block", footer.size < blocks.dropLast(1).minOf { it.size })
    assertEquals("grey, not black", (0xFF shl 24) or ShareDocument.FOOTER_RGB, footer.color)
    assertTrue("it is not over the page: it only ever flows after the body", footer.spaceBefore > 0f)
  }

  @Test fun thePdfWithoutItHasNoFooterBlock() {
    val blocks = composed(full(), "pdf", off).blocks!!
    assertEquals(0, blocks.count { it.text.contains("Created with Verbale") })
    assertEquals(full().let { FileExportModule.pdfBlocks(it) }, blocks)
  }

  /** The forced-transcript warning stays on top, and the attribution still comes last. */
  @Test fun theWarningLeadsAndTheAttributionTrails() {
    val marker = FileExportModule.forcedMarker("tr")
    for (f in listOf("md", "txt")) {
      val out = FileExportModule.previewText(composed(full(), f, on, marker))
      assertTrue(f, out.indexOf("Forced transcript") < out.indexOf("One action."))
      assertTrue(f, out.trimEnd().removeSuffix("*").endsWith(ShareDocument.ATTRIBUTION))
    }
    val pdf = composed(full(), "pdf", on, marker).blocks!!
    assertTrue(pdf[2].text.startsWith("Forced transcript"))
    assertEquals(ShareDocument.ATTRIBUTION, pdf.last().text)
  }

  // ---- 4. Honest content ---------------------------------------------------------------------

  /** The transcript shared is the corrected one, under the speaker's current name. */
  @Test fun theTranscriptIsTheCorrectedOneUnderTheCurrentName() {
    val ts = FileExportModule.turnsOf(
      rows(
        JSONObject().put("id", "u1").put("start_ms", 61_000L).put("end_ms", 64_000L)
          .put("speaker_id", "s1").put("text", "We agreed to ship on Monday."),
      ),
      mapOf("s1" to "Priya"),
      mapOf("utterance/u1" to "We agreed to ship on Tuesday."),
    )
    val out = md(content(turns = ts))
    assertTrue(out, out.contains("**Priya:** We agreed to ship on Tuesday."))
    assertFalse(out, out.contains("Monday"))
  }

  /** No summary and no minutes: only what exists is shown, and no placeholder prose stands in. */
  @Test fun aMeetingWithNoSummaryShowsOnlyWhatExists() {
    val out = md(content(items(itemRow("d", "decision", "Ship on the 14th"))))
    assertEquals(
      "# Design review\n\n_" + FileExportModule.dateStr(0L) + "_\n\n## Decisions\n\n- [1:01] Ship on the 14th\n\n" +
        "## Transcript\n\n**Priya:** We agreed to ship on Monday.\n\n**Ravi:** I will send the report by Friday.\n\n",
      out,
    )
    for (placeholder in listOf("No summary", "not available", "Summary", "Minutes", "Nothing", "N/A")) {
      assertFalse(placeholder, out.contains(placeholder))
    }
  }

  /** The sample's in-app banner is screen chrome; no format carries it. */
  @Test fun theSampleBannerIsNotInTheDocument() {
    val banner = "This is a sample so you can see the notes before recording"
    for ((f, out) in everyFormat(full(), on)) assertFalse(f, out.contains(banner))
  }

  /** The same Content, rendered four ways, has the same items on every line of every format. */
  @Test fun everyFormatCarriesTheSameFlags() {
    val its = items(itemRow("a", "action", "Book the room"))
    val all = everyFormat(content(its), off)
    for (f in listOf("md", "txt", "pdf")) {
      assertTrue(f, all.getValue(f).contains("Owner not set"))
      assertTrue(f, all.getValue(f).contains("No date given"))
    }
  }

  // ---- 3. Availability: nothing on this path asks about a licence or an allowance ------------

  /**
   * Building and composing a document takes a Content and Options and nothing else: there is no
   * parameter through which a licence, a plan or an allowance could reach it. This pins the
   * signature — it fails to compile if someone adds one — and runs every format with no Android
   * and no store in sight.
   */
  @Test fun buildingADocumentDependsOnNoLicenceOrAllowance() {
    val build: (FileExportModule.Content, ShareDocument.Options) -> ShareDocument.Doc = { c, o -> ShareDocument.build(c, o) }
    val compose: (FileExportModule.Content, String, String?, ShareDocument.Options) -> FileExportModule.Document =
      { c, f, m, o -> FileExportModule.compose(c, f, m, o) }
    assertEquals("Design review", build(full(), off).title)
    for (f in listOf("md", "txt", "pdf", "srt")) assertTrue(f, compose(full(), f, null, off).title.isNotEmpty())
  }
}
