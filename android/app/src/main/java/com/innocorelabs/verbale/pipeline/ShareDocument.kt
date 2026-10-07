package com.innocorelabs.verbale.pipeline

/**
 * The document a person shares, built once and written out in every format.
 *
 * ONE SOURCE OF TRUTH. The share preview on the phone, the Markdown file, the plain-text file and
 * the PDF are all written from the [Doc] that [buildShareDocument] returns. The preview is not a
 * second description of the export that happens to look similar: it is the same text, produced by
 * the same function, so it cannot say something the file does not. `ShareDocumentTest` asserts that
 * for the same input the preview equals the Markdown body character for character.
 *
 * WHAT IT NEVER DOES: invent a missing owner or a missing date. An action nobody owns reads
 * "Owner not set"; one with no date reads "No date given". Both are statements about what the
 * meeting did not settle, written where the reader will see them, and neither is ever filled with
 * a guess. A decision or action the review queue is holding reads "Needs a look". A ticked item
 * reads "Done".
 *
 * Pure: no Android, no database. Reads (corrections, live speaker names, ticks) are done by
 * `FileExportModule.document` on the way IN, which is why a correction or a rename reaches every
 * format without any of them knowing.
 */
object ShareDocument {
  /** The single attribution line. Optional, off by default, and always the LAST thing in a file. */
  const val ATTRIBUTION = "Created with Verbale — private meeting notes"

  const val OWNER_NOT_SET = "Owner not set"
  const val DATE_NOT_GIVEN = "No date given"
  const val NEEDS_LOOK = "Needs a look"
  const val DONE = "Done"

  /** What the meeting did not settle. The preview draws these in a different style. */
  val UNRESOLVED = listOf(OWNER_NOT_SET, DATE_NOT_GIVEN, NEEDS_LOOK)

  data class Options(val attribution: Boolean = false)

  /**
   * One decision, action or question as a line of the document.
   *
   * [text] is the stamped sentence with its owner, due tail and model labels; [unresolved] and
   * [done] are the flags that follow it. They are kept apart (rather than concatenated at once) so
   * the PDF can set the flags in their own colour while Markdown and text print them inline.
   */
  data class Line(val text: String, val unresolved: List<String>, val done: Boolean) {
    val flags: List<String> get() = unresolved + if (done) listOf(DONE) else emptyList()

    /** The line as Markdown and plain text print it. */
    val inline: String get() = text + flags.joinToString("") { " · $it" }
  }

  data class Section(val kind: String, val heading: String, val lines: List<Line>)

  data class Doc(
    val title: String,
    val date: String,
    val summary: String?,
    val narrative: String?,
    val highlights: List<String>,
    val sections: List<Section>,
    val turns: List<FileExportModule.ExportTurn>,
    /** The attribution, or null. Written after everything else, never before or over content. */
    val footer: String?,
  )

  private fun isUnassigned(owner: String?) = owner == null || owner.equals("Unassigned", ignoreCase = true)

  /** One item, with what is and is not known about it made explicit. */
  fun lineOf(item: FileExportModule.ExportItem): Line {
    val unresolved = ArrayList<String>()
    var sentence = item.text.trim()
    if (item.kind == "action") {
      val p = ItemOwner.split(item.text)
      if (isUnassigned(p.owner)) {
        // "— Unassigned" is the extractor saying it could not tell. Say so in words a reader of a
        // forwarded document understands, and keep the due tail where it was.
        sentence = if (p.owner == null && p.dueSuffix == null) item.text.trim()
        else p.body + (p.dueSuffix?.let { " $it" } ?: "")
        unresolved.add(OWNER_NOT_SET)
      }
      // A date counts as given when the words carry a "(due …)" tail, the classifier normalised
      // one, or a date was said even though it could not be normalised: "No date given" must never
      // be printed over a Friday somebody actually said.
      if (!item.dated && p.dueSuffix == null) unresolved.add(DATE_NOT_GIVEN)
    }
    if (item.needsLook) unresolved.add(NEEDS_LOOK)
    val stamped =
      (if (item.anchorStartMs == null) sentence else "[" + FileExportModule.stamp(item.anchorStartMs) + "] " + sentence) +
        item.labels
    return Line(stamped, unresolved, item.done)
  }

  fun build(c: FileExportModule.Content, options: Options = Options()): Doc =
    Doc(
      title = c.title,
      date = FileExportModule.dateStr(c.createdAt),
      summary = c.summary,
      narrative = c.narrative,
      highlights = c.highlights.map { FileExportModule.highlightLine(it) },
      sections = FileExportModule.SECTIONS.mapNotNull { (kind, heading) ->
        val lines = c.items.filter { it.kind == kind }.map { lineOf(it) }
        if (lines.isEmpty()) null else Section(kind, heading, lines)
      },
      turns = c.turns,
      footer = if (options.attribution) ATTRIBUTION else null,
    )

  fun markdown(d: Doc): String {
    val sb = StringBuilder()
    sb.append("# ").append(d.title).append("\n\n")
    sb.append("_").append(d.date).append("_\n\n")
    d.summary?.let { sb.append(it).append("\n\n") }
    d.narrative?.let { sb.append("## Minutes\n\n").append(it).append("\n\n") }
    if (d.highlights.isNotEmpty()) {
      sb.append("## Highlights\n\n")
      for (h in d.highlights) sb.append("- ").append(h).append("\n")
      sb.append("\n")
    }
    for (s in d.sections) {
      sb.append("## ").append(s.heading).append("\n\n")
      for (l in s.lines) sb.append("- ").append(l.inline).append("\n")
      sb.append("\n")
    }
    sb.append("## Transcript\n\n")
    for (t in d.turns) sb.append("**").append(t.speaker).append(":** ").append(t.text).append("\n\n")
    return sb.toString()
  }

  fun text(d: Doc): String {
    val sb = StringBuilder()
    sb.append(d.title).append("\n").append(d.date).append("\n\n")
    d.summary?.let { sb.append(it).append("\n\n") }
    d.narrative?.let { sb.append("MINUTES\n").append(it).append("\n\n") }
    if (d.highlights.isNotEmpty()) {
      sb.append("HIGHLIGHTS\n")
      for (h in d.highlights) sb.append("  - ").append(h).append("\n")
      sb.append("\n")
    }
    for (s in d.sections) {
      sb.append(s.heading.uppercase(java.util.Locale.US)).append("\n")
      for (l in s.lines) sb.append("  - ").append(l.inline).append("\n")
      sb.append("\n")
    }
    sb.append("TRANSCRIPT\n")
    for (t in d.turns) sb.append(t.speaker).append(": ").append(t.text).append("\n")
    return sb.toString()
  }

  /** The Markdown file's footer, in the shape Markdown reads as one: a rule, then the line. */
  fun withMarkdownFooter(body: String, d: Doc): String =
    if (d.footer == null) body else body.trimEnd() + "\n\n---\n\n*" + d.footer + "*\n"

  fun withTextFooter(body: String, d: Doc): String =
    if (d.footer == null) body else body.trimEnd() + "\n\n" + d.footer + "\n"

  private fun rgb(r: Int, g: Int, b: Int): Int = (0xFF shl 24) or (r shl 16) or (g shl 8) or b

  /**
   * The same document as blocks for the page, in the Markdown's order and under its headings.
   *
   * A flagged item is its bullet plus one small line beneath it carrying the flags, in amber when
   * something is unresolved and grey when it is only done — the PDF's way of drawing "Owner not
   * set" differently from the sentence, since a block is one run of one style.
   */
  fun pdfBlocks(d: Doc): List<PdfExport.Block> {
    val grey = rgb(0x6B, 0x70, 0x80)
    val amber = rgb(0x8A, 0x5A, 0x00)
    val blocks = ArrayList<PdfExport.Block>()
    blocks.add(PdfExport.Block(d.title, 22f, bold = true))
    blocks.add(PdfExport.Block(d.date, 10f, color = grey, spaceBefore = 2f))
    d.summary?.let { blocks.add(PdfExport.Block(it, 11f, spaceBefore = 18f)) }
    d.narrative?.let {
      blocks.add(PdfExport.Block("Minutes", 14f, bold = true, spaceBefore = 22f))
      blocks.add(PdfExport.Block(it, 11f, spaceBefore = 8f))
    }
    if (d.highlights.isNotEmpty()) {
      blocks.add(PdfExport.Block("Highlights", 14f, bold = true, spaceBefore = 22f))
      for (h in d.highlights) blocks.add(PdfExport.Block("•  $h", 11f, spaceBefore = 6f, indent = 8f))
    }
    for (s in d.sections) {
      blocks.add(PdfExport.Block(s.heading, 14f, bold = true, spaceBefore = 22f))
      for (l in s.lines) {
        // The bullet is part of the string so a wrapped item indents under its words.
        blocks.add(PdfExport.Block("•  " + l.text, 11f, spaceBefore = 6f, indent = 8f))
        if (l.flags.isNotEmpty()) {
          blocks.add(
            PdfExport.Block(
              l.flags.joinToString(" · "), 9f, bold = l.unresolved.isNotEmpty(),
              color = if (l.unresolved.isNotEmpty()) amber else grey, spaceBefore = 1f, indent = 8f + 12f,
            ),
          )
        }
      }
    }
    if (d.turns.isNotEmpty()) {
      blocks.add(PdfExport.Block("Transcript", 14f, bold = true, spaceBefore = 24f))
      for (t in d.turns) {
        blocks.add(PdfExport.Block(t.speaker, 9f, bold = true, color = grey, spaceBefore = 10f))
        blocks.add(PdfExport.Block(t.text, 11f, spaceBefore = 2f))
      }
    }
    return blocks
  }

  /** Grey and small: a footer, never a stamp, and always after the last block of content. */
  const val FOOTER_SIZE = 8f
  const val FOOTER_SPACE_BEFORE = 20f
  const val FOOTER_RGB = 0x8A8FA2

  fun footerBlock(footer: String): PdfExport.Block =
    PdfExport.Block(
      footer, FOOTER_SIZE,
      color = (0xFF shl 24) or FOOTER_RGB, spaceBefore = FOOTER_SPACE_BEFORE,
    )
}
