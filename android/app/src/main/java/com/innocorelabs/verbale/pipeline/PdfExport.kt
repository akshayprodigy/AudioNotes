package com.innocorelabs.verbale.pipeline

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.text.StaticLayout
import android.text.TextPaint
import java.io.File

/**
 * The minutes as a document somebody can send to a client.
 *
 * Markdown is what a developer wants; a PDF is what gets attached to an email and read by the
 * person who was not in the meeting. It is also the only export format that looks the same
 * everywhere — the .md file renders as raw asterisks in most mail clients.
 *
 * Drawn rather than printed. Android's PrintManager route would render nicer HTML, but it puts
 * the system print dialog between the user and the file, and the point here is to reach the share
 * sheet with the same one tap the other three formats take.
 *
 * The CONTENT comes from FileExportModule, which is the single renderer for every way a meeting
 * leaves the app; this file only decides where the ink goes. That division is what stops the PDF
 * drifting from the Markdown, and it means a hand correction reaches the PDF for free.
 */
object PdfExport {
  // A4 at 72 points to the inch, which is the unit PdfDocument works in.
  private const val PAGE_W = 595
  private const val PAGE_H = 842
  private const val MARGIN = 48f
  private const val CONTENT_W = PAGE_W - MARGIN * 2

  /** One block of text with the size and weight it is set in. */
  data class Block(
    val text: String,
    val size: Float,
    val bold: Boolean = false,
    /** Space above, in points. Absorbed at the top of a page rather than leaving a gap. */
    val spaceBefore: Float = 0f,
    val color: Int = Color.BLACK,
    val indent: Float = 0f,
  )

  private fun paintFor(b: Block) = TextPaint().apply {
    isAntiAlias = true
    textSize = b.size
    color = b.color
    typeface = Typeface.create(Typeface.SANS_SERIF, if (b.bold) Typeface.BOLD else Typeface.NORMAL)
  }

  /**
   * Lay the blocks out across as many pages as they need, and write the file.
   *
   * Lines are measured with StaticLayout — which knows about word breaking, and about scripts that
   * do not break on spaces, so a Hindi transcript wraps correctly — and then drawn one at a time.
   * Drawing per line rather than per paragraph is what makes pagination trivial: a paragraph that
   * runs past the bottom of a page simply continues on the next one, instead of being pushed whole
   * and leaving half a page empty.
   */
  fun write(blocks: List<Block>, out: File) {
    val doc = PdfDocument()
    var page: PdfDocument.Page? = null
    var canvas: Canvas? = null
    var y = 0f
    var pageNumber = 0

    fun newPage() {
      page?.let { doc.finishPage(it) }
      pageNumber++
      val p = doc.startPage(PdfDocument.PageInfo.Builder(PAGE_W, PAGE_H, pageNumber).create())
      page = p
      canvas = p.canvas
      y = MARGIN
    }

    newPage()

    for (b in blocks) {
      val paint = paintFor(b)
      val width = (CONTENT_W - b.indent).toInt().coerceAtLeast(1)
      val layout = StaticLayout.Builder
        .obtain(b.text, 0, b.text.length, paint, width)
        .setLineSpacing(0f, 1.15f)
        .build()

      // Only where something has already been drawn on this page: a heading must not push itself
      // down from the top margin just because it asked for space above it.
      if (y > MARGIN) y += b.spaceBefore

      for (i in 0 until layout.lineCount) {
        val lineHeight = (layout.getLineBottom(i) - layout.getLineTop(i)).toFloat()
        if (y + lineHeight > PAGE_H - MARGIN) newPage()
        val start = layout.getLineStart(i)
        val end = layout.getLineEnd(i)
        val baseline = y - paint.ascent()
        canvas?.drawText(b.text, start, end, MARGIN + b.indent, baseline, paint)
        y += lineHeight
      }
    }

    page?.let { doc.finishPage(it) }
    out.outputStream().use { doc.writeTo(it) }
    doc.close()
  }
}
