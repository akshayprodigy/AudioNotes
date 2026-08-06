package com.audionotes.overlay

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF

/**
 * Pip, drawn on a Canvas.
 *
 * Every coordinate is transcribed from `src/components/Mascot.tsx`, which draws into a 120x120
 * SVG viewBox — so this takes a target box and scales by `size / 120`, and any change to the
 * mascot must be mirrored here. Drawn rather than exported as a PNG so he stays crisp at any
 * density and can change expression without shipping five bitmaps.
 *
 * The ink does NOT fill the viewBox: the round-capped stroke-7 headband tops out at y≈6.5, the ear
 * cups span x 12..108, and the body circle bottoms at y=96. Centring on the viewBox would leave
 * him visibly low and left inside a circular puck, so [draw] centres on the inked bounds instead.
 */
object PipDrawer {

  enum class Mood { IDLE, LISTENING, THINKING, HAPPY, ASLEEP }

  // Inked bounds within the 120-unit viewBox.
  private const val INK_L = 12f
  private const val INK_T = 6.5f
  private const val INK_R = 108f
  private const val INK_B = 96f
  private const val INK_CX = (INK_L + INK_R) / 2f       // 60
  private const val INK_CY = (INK_T + INK_B) / 2f       // 51.25
  private const val INK_W = INK_R - INK_L               // 96
  private const val INK_H = INK_B - INK_T               // 89.5

  /** Widest inked extent, used to work out the scale that fits a requested box. */
  const val INK_SPAN = 96f

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
  }
  private val rect = RectF()
  private val path = Path()

  /**
   * Draw Pip centred on ([cx], [cy]) at [size] device pixels across his inked width.
   *
   * @param tiltDeg the mascot's resting tilt; Mascot.tsx animates between -2 and +2 degrees.
   */
  fun draw(
    canvas: Canvas,
    cx: Float,
    cy: Float,
    size: Float,
    mood: Mood,
    bodyColor: Int,
    cupColor: Int,
    tiltDeg: Float = -2f,
  ) {
    val k = size / INK_SPAN
    val save = canvas.save()
    canvas.rotate(tiltDeg, cx, cy)
    // Map viewBox units to canvas: translate the ink centre onto (cx, cy), then scale.
    canvas.translate(cx - INK_CX * k, cy - INK_CY * k)
    canvas.scale(k, k)

    // Ear cups first so the body circle overlaps them, matching the SVG's paint order.
    fill.color = cupColor
    rect.set(12f, 46f, 30f, 76f)
    canvas.drawRoundRect(rect, 9f, 9f, fill)
    rect.set(90f, 46f, 108f, 76f)
    canvas.drawRoundRect(rect, 9f, 9f, fill)

    // Headband: "M20 50 a40 40 0 0 1 80 0" — a semicircular arc over the top.
    stroke.color = bodyColor
    stroke.strokeWidth = 7f
    path.reset()
    rect.set(20f, 10f, 100f, 90f)
    path.arcTo(rect, 180f, 180f, true)
    canvas.drawPath(path, stroke)

    fill.color = bodyColor
    canvas.drawCircle(60f, 58f, 38f, fill)

    fill.color = Palette.card
    canvas.drawCircle(60f, 63f, 27f, fill)

    drawFace(canvas, mood)

    fill.color = Palette.blush
    canvas.drawCircle(40f, 68f, 5f, fill)
    canvas.drawCircle(80f, 68f, 5f, fill)

    canvas.restoreToCount(save)
  }

  private fun drawFace(canvas: Canvas, mood: Mood) {
    fill.color = Palette.ink
    stroke.color = Palette.ink
    // 3.4 viewBox units, as in Mascot.tsx. At the sizes the bubble uses this lands near one
    // physical pixel, so the caller's scale is what keeps it visible — see BubbleView.
    stroke.strokeWidth = 3.4f

    when (mood) {
      Mood.LISTENING -> {
        canvas.drawCircle(51f, 59f, 4.6f, fill)
        canvas.drawCircle(69f, 59f, 4.6f, fill)
        rect.set(55f, 67f, 65f, 79f) // open "o" mouth: rx 5, ry 6 about (60, 73)
        canvas.drawOval(rect, fill)
      }
      Mood.HAPPY -> {
        arc(canvas, "M46 60q5-6 10 0")
        arc(canvas, "M64 60q5-6 10 0")
        arc(canvas, "M50 70q10 10 20 0")
      }
      Mood.THINKING -> {
        canvas.drawCircle(53f, 57f, 4.6f, fill)
        canvas.drawCircle(71f, 57f, 4.6f, fill)
        arc(canvas, "M52 71q8 7 16 0")
      }
      Mood.ASLEEP -> {
        arc(canvas, "M46 60q5 5 10 0")
        arc(canvas, "M64 60q5 5 10 0")
        path.reset(); path.moveTo(55f, 72f); path.lineTo(65f, 72f)
        canvas.drawPath(path, stroke)
      }
      Mood.IDLE -> {
        canvas.drawCircle(51f, 60f, 4.6f, fill)
        canvas.drawCircle(69f, 60f, 4.6f, fill)
        arc(canvas, "M52 72q8 8 16 0")
      }
    }
  }

  /** Minimal "Mx y q dx1 dy1 dx dy" reader, so the curves stay copy-pasteable from Mascot.tsx. */
  private fun arc(canvas: Canvas, d: String) {
    val n = Regex("-?\\d+(?:\\.\\d+)?").findAll(d).map { it.value.toFloat() }.toList()
    if (n.size < 6) return
    path.reset()
    path.moveTo(n[0], n[1])
    path.rQuadTo(n[2], n[3], n[4], n[5])
    canvas.drawPath(path, stroke)
  }
}
