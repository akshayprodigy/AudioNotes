package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ItemKey
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
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

  private fun itemRow(
    id: String,
    kind: String,
    text: String,
    anchorStartMs: Long,
    genVersion: String = Minutes.RULES_GEN,
  ) = JSONObject().put("id", id).put("kind", kind).put("text", text)
    .put("anchor_start_ms", anchorStartMs).put("gen_version", genVersion)

  /**
   * An item a person typed, as `document`'s SELECT really hands it over.
   *
   * The anchor is the SENTINEL and not 0, because that is what is on disk: `anchor_start_ms` is
   * `INTEGER NOT NULL`, so a row that never claimed a moment still stores a number, and the
   * derivation that turns it back into "no moment" is `gen_version` — never a comparison against
   * the number. A fixture that put 0 here would pass against a renderer that had no derivation at
   * all, which is the whole defect these tests exist to catch.
   */
  private fun typedRow(id: String, kind: String, text: String) =
    itemRow(id, kind, text, AudioDb.Gen.NO_ANCHOR, AudioDb.Gen.USER)

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
   * It is an `items` row as of Task 12, so the merge that used to bring it back from `minutes` is
   * gone — and the risk moved with it. Until the migration ran, exporting `items` alone dropped it
   * silently; now the same silence is available to a migration that did not fire, which is what
   * [aMeetingWhoseOnlyItemIsHandTypedStillFallsBackToItsMinutes] below pins.
   *
   * TWO ITEMS, with the extracted one LAST in the fixture and the typed one first, so this cannot
   * pass by rendering whatever it was handed in whatever order it arrived.
   */
  @Test fun aHandTypedRowIsStillExported() {
    val items = FileExportModule.exportItems(
      rows(
        typedRow("it-user", "decision", "Ship on the 14th"),
        itemRow("it-1", "action", "Send the report — Priya", 65_000L),
      ),
      rows(minuteRow("action", "Send the report — Priya")),
      emptyMap(),
    )
    val md = FileExportModule.renderMarkdown(content(items = items))
    assertEquals("- Ship on the 14th\n", sectionOf(md, "Decisions"))
    assertEquals("- [1:05] Send the report — Priya\n", sectionOf(md, "Action items"))
  }

  /**
   * ...and it carries no timestamp, because nobody ever said it.
   *
   * `[0:00]` would be a fabricated claim about a moment: it sends a reader to the top of the
   * recording to look for a sentence that was never spoken there. And `[2562047788:00:54]` — what
   * printing the stored sentinel gives — would be worse only in that somebody would notice.
   *
   * The extracted row is in the fixture so the assertion can fail: a renderer that had stopped
   * stamping anything at all would pass a list of one null.
   */
  @Test fun aHandTypedRowIsNotStampedWithAMomentNobodySpoke() {
    val items = FileExportModule.exportItems(
      rows(
        itemRow("it-1", "action", "Send the report — Priya", 65_000L),
        typedRow("it-user", "action", "Book the venue — Priya"),
      ),
      rows(),
      emptyMap(),
    )
    assertEquals(listOf<Long?>(65_000L, null), items.map { it.anchorStartMs })
    val md = FileExportModule.renderMarkdown(content(items = items))
    assertEquals(
      "- [1:05] Send the report — Priya\n- Book the venue — Priya\n",
      sectionOf(md, "Action items"),
    )
    assertFalse(
      "a row nobody said was stamped with the start of the meeting",
      md.contains("0:00"),
    )
  }

  /**
   * A correction to a hand-typed row is keyed on its ITEM ID now, like every other correction.
   *
   * That is the point of the move rather than a consequence of it: a hash of the text was the last
   * key this row had, and a hash moves with the text it hashes — so correcting a typed line twice
   * orphaned the first correction. `AudioDb.carryUserMinutesOntoItems` and `carryEditsOntoItems`
   * are what move the rows already on disk onto the new key.
   */
  @Test fun aCorrectionToAHandTypedRowResolvesOnItsItemId() {
    val items = FileExportModule.exportItems(
      rows(
        itemRow("it-1", "action", "Send the report — Priya", 65_000L),
        typedRow("it-user", "decision", "Ship on the 14th"),
      ),
      rows(),
      mapOf("item/it-user" to "Ship on the 21st"),
    )
    assertEquals(listOf("Send the report — Priya", "Ship on the 21st"), items.map { it.text })
  }

  /**
   * A `minutes` row somebody typed is NOT merged back into a meeting that has items.
   *
   * It was, transitionally, for as long as `db.addUserMinute` was where a typed decision landed.
   * The migration has moved it and deleted the `minutes` row, so merging one back would print the
   * same sentence twice on a document somebody forwards — once from each table.
   */
  @Test fun aHandTypedMinuteIsNotMergedIntoAMigratedMeeting() {
    val items = FileExportModule.exportItems(
      rows(
        itemRow("it-1", "action", "Send the report — Priya", 65_000L),
        typedRow("it-user", "decision", "Ship on the 14th"),
      ),
      rows(minuteRow("decision", "Ship on the 14th", source = "user")),
      emptyMap(),
    )
    assertEquals(listOf("Send the report — Priya", "Ship on the 14th"), items.map { it.text })
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

  /**
   * THE HOLE THE MOVE OPENS, and the reason the fallback asks about RULE rows rather than rows.
   *
   * `carryUserMinutesOntoItems` runs before the native load, deliberately — a phone still
   * downloading `libonnxruntime.so` must not open a meeting with the person's own notes missing.
   * So an unmigrated meeting somebody typed a decision into arrives here with EXACTLY ONE item,
   * the typed one, and every rule-extracted row still in `minutes`. Under "does this meeting have
   * any items" the fallback switches off at that moment and the exported document loses its entire
   * minutes — the summary at the top still counting seven actions above a page holding one typed
   * line. Nothing throws and nothing is deleted.
   *
   * `AudioDb.ensureItems` and `AudioDb.UNMIGRATED` ask the same narrowed question for the same
   * reason: a row a person typed is not evidence that the rules have run.
   */
  @Test fun aMeetingWhoseOnlyItemIsHandTypedStillFallsBackToItsMinutes() {
    val items = FileExportModule.exportItems(
      rows(typedRow("it-user", "decision", "Ship on the 14th")),
      rows(minuteRow("action", "Send the report — Priya"), minuteRow("summary", "One action.")),
      emptyMap(),
    )
    assertEquals(listOf("Ship on the 14th", "Send the report — Priya"), items.map { it.text })
    assertEquals(listOf<Long?>(null, null), items.map { it.anchorStartMs })
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

  /**
   * And it carries the sections themselves, under the same three headings, in the meeting's order.
   *
   * TWO actions, reverse alphabetical, and an ordered comparison rather than `contains` — the same
   * shape the Markdown and plain-text tests were rewritten into, for the same mutant. The first
   * version of this test had one item per section, so `sortedBy { it.text }` in `pdfBlocks`
   * survived it: the lesson had been written down twice and still had not crossed to the format
   * this whole commit argues is the one that actually gets forwarded.
   */
  @Test fun theForwardedPdfCarriesEverySectionInOrder() {
    val blocks = FileExportModule.pdfBlocks(
      content(
        items = listOf(
          FileExportModule.ExportItem("decision", "Ship on the 14th", 61_000L),
          FileExportModule.ExportItem("action", "Write up the notes", 125_000L),
          FileExportModule.ExportItem("action", "Book the room", 200_000L),
          FileExportModule.ExportItem("question", "Who owns renewals?", 260_000L),
        ),
      ),
    )
    val text = blocks.map { it.text }
    assertEquals(
      "the PDF lost a section, re-ordered one, or ran two together",
      listOf(
        "Decisions",
        "•  [1:01] Ship on the 14th",
        "Action items",
        "•  [2:05] Write up the notes",
        "•  [3:20] Book the room",
        "Open questions",
        "•  [4:20] Who owns renewals?",
      ),
      text.filter { it.startsWith("•  ") || it in setOf("Decisions", "Action items", "Open questions") },
    )
  }

  /**
   * The two blocks the forced-transcript warning is spliced in after.
   *
   * `document` takes the first `PDF_HEADER_BLOCKS` and puts the warning — "if it was not English,
   * the words below are invented" — immediately after them, because a reader who stops at the
   * first paragraph must still have seen it. That index is a claim about THIS function, made in
   * another one. Deleting the date block here passed every test and silently slid the warning
   * below the summary, which is the one placement its own comment forbids.
   */
  @Test fun thePdfLeadsWithExactlyATitleAndADate() {
    val blocks = FileExportModule.pdfBlocks(content(summary = "One action, no decisions."))
    assertEquals("Design review", blocks[0].text)
    assertTrue(
      "the second block is no longer the date, so the forced-transcript warning moves",
      blocks[1].text.contains("1970"),
    )
    assertEquals("One action, no decisions.", blocks[2].text)
  }

  /**
   * Finding 1: the greys, asserted rather than inspected.
   *
   * [FileExportModule] transcribes `android.graphics.Color.rgb` by hand so that a JVM test can
   * reach this renderer at all, and until now the KDoc's "value-identical by inspection" was the
   * only thing holding the value — every test asserted `Block.text` and none read `.color`. Both
   * surviving mutants are silent and catastrophic in the same way: drop the `0xFF shl 24` and the
   * alpha channel goes to zero, so the date line, every speaker label and the credit footer are
   * rendered fully transparent in every exported PDF, with nothing thrown and nothing to see.
   *
   * The default is asserted for the same reason. `Block.color` defaults to `Color.BLACK`, and the
   * argument that it is safe is that a constant FIELD is inlined by the compiler where a METHOD
   * would throw "not mocked". This turns that argument into an assertion instead of leaving it as
   * a side effect of the tests happening to pass.
   */
  @Test fun thePdfIsSetInTheGreysItIntendsAndNotInTransparentInk() {
    val blocks = FileExportModule.pdfBlocks(content(summary = "One action, no decisions."))
    assertEquals(
      "the date line is not the grey it is meant to be — a wrong alpha here is invisible ink",
      0xFF6B7080.toInt(), blocks[1].color,
    )
    assertEquals(
      "Block.color's default stopped being opaque black",
      0xFF000000.toInt(), blocks[0].color,
    )
  }

  /** A row nobody said gets no stamp in the PDF either — same rule, all four formats. */
  @Test fun theForwardedPdfDoesNotStampARowNobodySpoke() {
    val blocks = FileExportModule.pdfBlocks(
      content(items = listOf(FileExportModule.ExportItem("decision", "Ship on the 14th", null))),
    )
    assertTrue(blocks.any { it.text == "•  Ship on the 14th" })
  }

  // ---- The transcript, and the corrections that reach it --------------------------------------

  /**
   * Finding 2: three more seams that went public in the split and that no test used.
   *
   * `turnsOf` is the worst of them, because it is the SOLE caller of `said()` — so the path by
   * which a person's correction of a mis-heard line reaches an exported document was pinned by
   * nothing at all. `renderTranscript` is what the Script tab's copy button returns, and
   * `renderSrt` is the subtitle file. All three are exercised from one fixture here, because the
   * alternative to testing a seam you made public for a test is making it private again.
   *
   * The correction is keyed `utterance/<id>`, which is the one `EditTarget` this task did not move
   * and must not: an utterance has a real row id, and that id is what the key has always been.
   */
  private fun twoTurns(edits: Map<String, String> = emptyMap()) = FileExportModule.turnsOf(
    rows(
      JSONObject().put("id", "u1").put("start_ms", 61_000L).put("end_ms", 64_000L)
        .put("speaker_id", "s1").put("text", "We agreed to ship on Monday."),
      JSONObject().put("id", "u2").put("start_ms", 125_000L).put("end_ms", 129_000L)
        .put("speaker_id", "s2").put("text", "I will send the report by Friday."),
    ),
    mapOf("s1" to "Priya", "s2" to "Ravi"),
    edits,
  )

  @Test fun aTurnIsAttributedToTheSpeakerTheMeetingNamed() {
    assertEquals(listOf("Priya", "Ravi"), twoTurns().map { it.speaker })
    assertEquals(listOf(61_000L, 125_000L), twoTurns().map { it.startMs })
    assertEquals(listOf(64_000L, 129_000L), twoTurns().map { it.endMs })
  }

  /** An unnamed speaker is "Speaker", not a crash and not a blank. */
  @Test fun aTurnWithNoNamedSpeakerIsStillAttributed() {
    val turns = FileExportModule.turnsOf(
      rows(
        JSONObject().put("id", "u1").put("start_ms", 0L).put("end_ms", 1_000L)
          .put("speaker_id", "s9").put("text", "Anyone?"),
      ),
      emptyMap(), emptyMap(),
    )
    assertEquals("Speaker", turns.single().speaker)
  }

  /**
   * A correction of a mis-heard line reaches the exported document.
   *
   * The only assertion anywhere over `said()`. A transcript correction that silently failed to
   * export is the same class of loss this whole task exists to prevent, and it had no test.
   */
  @Test fun aCorrectedTurnIsExportedAsTheUserCorrectedIt() {
    val turns = twoTurns(mapOf("utterance/u2" to "I will send the deck by Friday."))
    assertEquals(
      listOf("We agreed to ship on Monday.", "I will send the deck by Friday."),
      turns.map { it.text },
    )
  }

  /**
   * The Script tab's copy button: what was said, attributed, and nothing else.
   *
   * No heading and no minutes — this is what somebody pasting into a mail that already has its own
   * context is asking for. Blank lines between turns, because a wall of "Name: sentence" is
   * unusable at meeting length.
   */
  @Test fun theTranscriptExportIsJustWhatWasSaidAttributed() {
    assertEquals(
      "Priya: We agreed to ship on Monday.\n\nRavi: I will send the report by Friday.",
      FileExportModule.renderTranscript(content(turns = twoTurns())),
    )
  }

  /** And it carries the correction too, since it reads the same turns. */
  @Test fun theTranscriptExportCarriesACorrection() {
    val txt = FileExportModule.renderTranscript(
      content(turns = twoTurns(mapOf("utterance/u1" to "We agreed to ship on Tuesday."))),
    )
    assertTrue(txt.startsWith("Priya: We agreed to ship on Tuesday."))
  }

  /**
   * The subtitle file: numbered from 1, with SRT's comma-before-milliseconds timing.
   *
   * `00:01:01,000`, not `0:01:01.000` — a player that cannot parse the timing drops the cue
   * silently, which is a subtitle track that renders as nothing at all.
   */
  @Test fun theSubtitleExportIsNumberedAndTimedTheWaySrtRequires() {
    assertEquals(
      "1\n00:01:01,000 --> 00:01:04,000\nPriya: We agreed to ship on Monday.\n\n" +
        "2\n00:02:05,000 --> 00:02:09,000\nRavi: I will send the report by Friday.\n\n",
      FileExportModule.renderSrt(content(turns = twoTurns())),
    )
  }

  // ---- The prose, and which version of it wins ------------------------------------------------

  /**
   * Finding 5: a regression that already shipped once, and was unpinned again.
   *
   * `replaceMinutes` is scoped by source, so a narrated meeting keeps its rule-composed summary
   * ALONGSIDE the model's — both rows exist, rule written first. Reading them in rowid order is
   * what this used to do, and it handed a paying subscriber the rule row. The branch that fixed it
   * could be deleted with every test in the tree green, because the only fixture that reached it
   * had a single summary row.
   *
   * The rows are in the order `replaceMinutes` really writes them: rule first, llm second. A
   * fixture with the llm row first would pass against rowid order and prove nothing.
   */
  @Test fun aNarratedMeetingExportsTheModelsSummaryAndNotTheRuleOne() {
    val minutes = rows(
      minuteRow("summary", "2 action items, 1 decision.", source = "rule"),
      minuteRow("summary", "The team agreed to ship on Monday and split the follow-ups.", source = "llm"),
    )
    assertEquals(
      "the rule summary won because it was written first — the exact defect this branch fixed",
      "The team agreed to ship on Monday and split the follow-ups.",
      FileExportModule.summaryOf(minutes, emptyMap()),
    )
  }

  /** With no model summary, the rule-composed one is the free tier's floor and must still show. */
  @Test fun aMeetingWithOnlyARuleSummaryStillExportsIt() {
    assertEquals(
      "2 action items, 1 decision.",
      FileExportModule.summaryOf(rows(minuteRow("summary", "2 action items, 1 decision.")), emptyMap()),
    )
  }

  /**
   * A summary somebody typed wins outright, whatever the model did or did not manage.
   *
   * Keyed on `summary/doc` because there is exactly one summary per meeting, so the kind already
   * identifies the thing and the key has nothing left to say.
   */
  @Test fun aHandWrittenSummaryBeatsBothOfThem() {
    val minutes = rows(
      minuteRow("summary", "2 action items, 1 decision.", source = "rule"),
      minuteRow("summary", "The team agreed to ship on Monday.", source = "llm"),
    )
    assertEquals(
      "What we actually decided: ship Monday, Priya owns the report.",
      FileExportModule.summaryOf(
        minutes, mapOf("summary/doc" to "What we actually decided: ship Monday, Priya owns the report."),
      ),
    )
  }

  /**
   * The write-up is the MODEL's prose, and a rule row of that kind is not a write-up.
   *
   * The same unpinned filter as the summary's, one line down: nothing asserted that a
   * `source='rule'` narrative is rejected, because no fixture ever had one.
   */
  @Test fun theWriteUpComesFromTheModelAndNotFromARuleRow() {
    assertNull(
      "a rule row was exported as the written-up minutes",
      FileExportModule.narrativeOf(rows(minuteRow("narrative", "Rule text", source = "rule")), emptyMap()),
    )
    assertEquals(
      "The team walked through the roadmap.",
      FileExportModule.narrativeOf(
        rows(minuteRow("narrative", "The team walked through the roadmap.", source = "llm")), emptyMap(),
      ),
    )
  }

  /** And a hand-written write-up beats the model's, on the same `doc` key. */
  @Test fun aHandWrittenWriteUpBeatsTheModels() {
    assertEquals(
      "What really happened.",
      FileExportModule.narrativeOf(
        rows(minuteRow("narrative", "The team walked through the roadmap.", source = "llm")),
        mapOf("narrative/doc" to "What really happened."),
      ),
    )
  }

  // ---- The other half of the one-sided switch -------------------------------------------------

  /**
   * Finding 7: the Kotlin mirror of "does not read an item's correction off the minute key".
   *
   * ItemProvenance.test.tsx pins this on the JavaScript side and explains why a fallback read is
   * forbidden rather than merely unnecessary: leaving the stale `minute` row in place means REVERT
   * appears to do nothing, because deleting the item-keyed row lets the minute-keyed one come
   * straight back. The whole point of that test is making the two sides one change rather than
   * two — so the side that renders the document people forward needs the same assertion. Adding
   * `?: edits["minute/" + ItemKey.of(text)]` to the item branch passed every Kotlin test.
   */
  @Test fun anItemsCorrectionIsNotReadOffTheMinuteKeyAnyMore() {
    val text = "Send the report — Priya"
    val items = FileExportModule.exportItems(
      rows(itemRow("it-1", "action", text, 3_725_000L)),
      rows(),
      mapOf("minute/" + ItemKey.of(text) to "A stale correction from before the migration"),
    )
    assertEquals(
      "the export fell back to the minute key, which makes revert silently no-op",
      listOf(text), items.map { it.text },
    )
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
   *
   * THE ROWS COME THROUGH `exportItems`, not from hand-built `ExportItem`s, and that is the whole
   * difference between this test and the claim above it. `exportItems` IS what sits between the
   * SELECT and the page — it is the function that merges the two tables — so a version that built
   * its own list left the merge outside the assertion entirely: `out.reverse()` inside it passed
   * every test in this file.
   */
  @Test fun itemsAreExportedInTheOrderTheyWereSaid() {
    val md = FileExportModule.renderMarkdown(
      content(
        items = FileExportModule.exportItems(
          rows(
            itemRow("it-1", "action", "Write up the notes", 61_000L),
            itemRow("it-2", "decision", "A decision in between", 90_000L),
            itemRow("it-3", "action", "Book the room", 125_000L),
          ),
          rows(),
          emptyMap(),
        ),
      ),
    )
    assertEquals(
      "- [1:01] Write up the notes\n- [2:05] Book the room\n", sectionOf(md, "Action items"),
    )
    assertEquals("- [1:30] A decision in between\n", sectionOf(md, "Decisions"))
  }
}
