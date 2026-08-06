package com.audionotes.overlay

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.view.View

/**
 * The drop target that appears at the bottom of the screen while the bubble is being dragged.
 *
 * This is the piece that was simply never written. The old touch handler asked one question on
 * finger-up — "did it move?" — to tell a tap from a drag, and did nothing else, so dragging Pip to
 * the bottom of the screen did exactly what dragging him anywhere else did: parked him there.
 *
 * A POCKET, NOT A BIN. It is card grey with a downward chevron, never a red X and never a trash
 * can, because the verb is HIDE and hiding the control must never read as ending the meeting. The
 * caption says so in words at the moment of decision, and changes with the state: hiding while a
 * meeting runs promises that it keeps running.
 */
@SuppressLint("ViewConstructor")
class DismissView(context: Context) : View(context) {

  private val d = Scale(context)

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textAlign = Paint.Align.CENTER
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  }
  private val rect = RectF()
  private var scrim: Shader? = null

  /** 0..1 entry progress, so the target slides up rather than appearing under the finger. */
  var enter = 0f
    set(v) { field = v; invalidate() }

  /** True once the puck is inside the capture radius: the pocket lights up and grows. */
  var armed = false
    set(v) { if (field != v) { field = v; invalidate() } }

  /** Caption copy depends on whether hiding would leave a meeting running. */
  var recording = false

  /** Centre of the pocket in view coordinates, set on layout. */
  var pocketCx = 0f
    private set
  var pocketCy = 0f
    private set

  /** Bottom inset in pixels — the pocket must clear the gesture-nav home strip. */
  var bottomInset = 0f
    set(v) { field = v; requestLayout(); invalidate() }

  val captureRadius: Float get() = d(96f)

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    pocketCx = w / 2f
    pocketCy = h - bottomInset - d(56f)
    scrim = LinearGradient(
      0f, h - d(220f), 0f, h.toFloat(),
      0x00161C2C, 0x22161C2C, Shader.TileMode.CLAMP,
    )
  }

  override fun onDraw(canvas: Canvas) {
    if (enter <= 0f) return

    // A light scrim, not a dark one: the app is light-only, and a heavy dim over the host app
    // would read as a modal takeover rather than a drop hint.
    scrim?.let {
      fill.shader = it
      fill.alpha = (255 * enter).toInt()
      canvas.drawRect(0f, height - d(220f), width.toFloat(), height.toFloat(), fill)
      fill.shader = null
      fill.alpha = 255
    }

    val lift = d(24f) * (1f - enter)
    val cy = pocketCy + lift
    val grow = if (armed) 1.12f else 1f
    val half = d(34f) * grow

    fill.color = if (armed) Palette.primarySoftEdge else Palette.lineStrong
    rect.set(pocketCx - half, cy - half + d(3f), pocketCx + half, cy + half + d(3f))
    canvas.drawRoundRect(rect, d(24f) * grow, d(24f) * grow, fill)

    fill.color = if (armed) Palette.primarySoft else Palette.cardAlt
    rect.set(pocketCx - half, cy - half, pocketCx + half, cy + half)
    canvas.drawRoundRect(rect, d(24f) * grow, d(24f) * grow, fill)

    stroke.color = if (armed) Palette.primarySoftEdge else Palette.lineStrong
    stroke.strokeWidth = d(1.5f)
    canvas.drawRoundRect(rect, d(24f) * grow, d(24f) * grow, stroke)

    // Chevron over a bar: "put this away", not "delete this".
    stroke.color = if (armed) Palette.primary else Palette.inkSoft
    stroke.strokeWidth = d(2.4f)
    stroke.strokeCap = Paint.Cap.ROUND
    val g = d(9f)
    canvas.drawLine(pocketCx - g, cy - g * 0.55f, pocketCx, cy + g * 0.35f, stroke)
    canvas.drawLine(pocketCx + g, cy - g * 0.55f, pocketCx, cy + g * 0.35f, stroke)
    canvas.drawLine(pocketCx - g * 0.8f, cy + g, pocketCx + g * 0.8f, cy + g, stroke)

    // The caption sits ABOVE the pocket. Below it is covered by the finger and the puck.
    val label = when {
      armed && recording -> "Release to hide — keeps recording"
      armed -> "Release to hide"
      recording -> "Hide — keeps recording"
      else -> "Hide Pip"
    }
    text.textSize = d(11.5f)
    val tw = text.measureText(label)
    val pillW = tw + d(22f)
    val pillH = d(28f)
    val pillCy = cy - half - d(20f)
    fill.color = Palette.card
    rect.set(pocketCx - pillW / 2f, pillCy - pillH / 2f, pocketCx + pillW / 2f, pillCy + pillH / 2f)
    canvas.drawRoundRect(rect, pillH / 2f, pillH / 2f, fill)
    text.color = if (armed) Palette.primary else Palette.ink
    canvas.drawText(label, pocketCx, pillCy + d(4f), text)
  }
}
