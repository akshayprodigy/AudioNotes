package com.audionotes.overlay

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View
import com.audionotes.pipeline.CaptureController

/**
 * The floating recorder, drawn on one Canvas.
 *
 * COLLAPSED is a puck: Pip, a live waveform, and the running time. The waveform is the point —
 * a timer only proves the app is still counting, while bars that move with the room prove the
 * microphone is actually hearing something. That is the question you have when the phone is face
 * up on a table in the middle of a conversation.
 *
 * EXPANDED fans Pause and Stop out below Pip in a triangle, so the puck never moves: whatever the
 * thumb just touched stays exactly where it was, and the two controls arrive under it rather than
 * pushing it aside.
 *
 * Stop is the further of the two and the only saturated coral in the overlay. Pause is nearer and
 * reversible. You cannot fat-finger the end of a meeting on the way to pausing it.
 *
 * This View owns drawing and hit-testing only. Window placement, dragging and dismissal belong to
 * [com.audionotes.pipeline.OverlayService]; the two talk through [onAction] and [hitTest].
 */
@SuppressLint("ViewConstructor")
class BubbleView(context: Context, private val onAction: (Action) -> Unit) : View(context) {

  enum class Action { TOGGLE_EXPAND, START, PAUSE, RESUME, STOP, OPEN_APP }

  companion object {
    /** Design units, scaled by [Scale]. Named so the geometry reads as a layout, not magic. */
    const val PUCK = 72f
    const val BTN = 52f
    const val BTN_DX = 38f   // horizontal offset of each button from the puck centre
    const val BTN_DY = 72f   // vertical drop from the puck centre to the button centres
    const val SHADOW = 4f
    const val PAD = 8f       // slack so shadows and the press lift never clip

    const val COLLAPSED_W = PUCK + PAD * 2
    const val COLLAPSED_H = PUCK + PAD * 2 + SHADOW
    const val EXPANDED_W = BTN_DX * 2 + BTN + PAD * 2
    const val EXPANDED_H = BTN_DY + BTN / 2 + PAD * 2 + SHADOW + PUCK / 2

    private const val BARS = 5
  }

  private val d = Scale(context)

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
  private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    textAlign = Paint.Align.CENTER
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
  }
  private val rect = RectF()

  var expanded = false
    private set

  private val a11y = BubbleAccessibilityHelper(this) { onAction(it) }

  init {
    androidx.core.view.ViewCompat.setAccessibilityDelegate(this, a11y)
  }

  override fun dispatchHoverEvent(event: android.view.MotionEvent): Boolean =
    a11y.dispatchHoverEvent(event) || super.dispatchHoverEvent(event)

  /** Re-announce the puck when state changes under a screen reader. */
  fun announceState() {
    a11y.invalidateVirtualView(
      BubbleAccessibilityHelper.ID_PUCK,
      android.view.accessibility.AccessibilityEvent.CONTENT_CHANGE_TYPE_CONTENT_DESCRIPTION,
    )
  }

  /** Smoothed bar heights 0..1, so the meter falls gently rather than flickering. */
  private val bars = FloatArray(BARS) { 0.18f }
  private var phase = 0f

  /** Puck centre in this view's own coordinates. Recomputed whenever the window resizes. */
  private var puckCx = 0f
  private var puckCy = 0f

  /** Which edge the bubble is docked to; the triangle mirrors so it never opens off-screen. */
  var dockedLeft = true

  fun setExpanded(value: Boolean) {
    if (expanded == value) return
    expanded = value
    invalidate()
  }

  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    // The window is sized explicitly by the service; the view simply fills it. Measuring
    // WRAP_CONTENT here would fight the window and cause a relayout on every state change.
    setMeasuredDimension(
      MeasureSpec.getSize(widthMeasureSpec),
      MeasureSpec.getSize(heightMeasureSpec),
    )
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    puckCx = if (expanded) w / 2f else d(PAD) + d(PUCK) / 2f
    puckCy = d(PAD) + d(PUCK) / 2f
  }

  /** Advance the meter. Called on a timer while recording; returns true if a redraw is needed. */
  fun tick(): Boolean {
    if (!CaptureController.isRecording || CaptureController.paused) {
      var moved = false
      for (i in bars.indices) {
        if (bars[i] > 0.19f) { bars[i] += (0.18f - bars[i]) * 0.35f; moved = true }
      }
      return moved
    }
    phase += 0.45f
    // The capture level is already dBFS-mapped, which puts ordinary speech at 0.3-0.5; the power
    // curve expands that into a range the eye can read. Same 0.65 as the in-app meter.
    val level = Math.pow(CaptureController.level.coerceIn(0f, 1f).toDouble(), 0.65).toFloat()
    for (i in bars.indices) {
      val ripple = 1f + 0.3f * Math.sin((phase + i * 0.7f).toDouble()).toFloat()
      val target = (0.18f + level * ripple * 0.82f).coerceIn(0.18f, 1f)
      bars[i] += (target - bars[i]) * 0.5f
    }
    return true
  }

  override fun onDraw(canvas: Canvas) {
    val recording = CaptureController.isRecording
    val paused = CaptureController.paused
    val silenced = CaptureController.silenced

    if (expanded) drawButtons(canvas, paused)
    drawPuck(canvas, recording, paused, silenced)
  }

  private fun drawPuck(canvas: Canvas, recording: Boolean, paused: Boolean, silenced: Boolean) {
    val r = d(PUCK) / 2f

    // Hard offset shadow, never a blur — the app's whole surface language, and the only thing
    // keeping a white puck legible on top of a white host app.
    fill.color = Palette.primarySoftEdge
    canvas.drawCircle(puckCx, puckCy + d(3f), r, fill)

    fill.color = Palette.card
    canvas.drawCircle(puckCx, puckCy, r, fill)

    val ring = when {
      silenced -> Palette.warning
      paused -> Palette.warning
      recording -> Palette.danger
      else -> Palette.line
    }
    stroke.color = ring
    stroke.strokeWidth = d(2.5f)
    canvas.drawCircle(puckCx, puckCy, r - d(1.5f), stroke)

    val mood = when {
      silenced || paused -> PipDrawer.Mood.THINKING
      recording -> PipDrawer.Mood.LISTENING
      else -> PipDrawer.Mood.IDLE
    }
    // Pip sits in the upper half; the lower third is the meter and the clock.
    PipDrawer.draw(
      canvas, puckCx, puckCy - d(13f), d(34f), mood,
      bodyColor = Palette.primary, cupColor = Palette.primaryEdge,
    )

    if (recording || paused) {
      drawMeter(canvas, paused, silenced)
      drawClock(canvas, paused, silenced)
    } else {
      // Idle: one word, so the puck is never a mystery button.
      text.color = Palette.inkFaint
      text.textSize = d(9f)
      canvas.drawText("TAP", puckCx, puckCy + d(20f), text)
    }
  }

  private fun drawMeter(canvas: Canvas, paused: Boolean, silenced: Boolean) {
    val barW = d(3f)
    val gap = d(3f)
    val total = BARS * barW + (BARS - 1) * gap
    var x = puckCx - total / 2f
    val baseY = puckCy + d(11f)
    val maxH = d(13f)
    val shades = intArrayOf(Palette.wave1, Palette.wave2, Palette.wave3)
    for (i in 0 until BARS) {
      val h = (maxH * bars[i]).coerceAtLeast(d(2.5f))
      fill.color = when {
        silenced || paused -> Palette.warningEdge
        else -> shades[i % shades.size]
      }
      rect.set(x, baseY - h / 2f, x + barW, baseY + h / 2f)
      canvas.drawRoundRect(rect, barW / 2f, barW / 2f, fill)
      x += barW + gap
    }
  }

  private fun drawClock(canvas: Canvas, paused: Boolean, silenced: Boolean) {
    text.textSize = d(10f)
    text.color = when {
      silenced -> Palette.warningDeep
      paused -> Palette.warningDeep
      else -> Palette.danger
    }
    val label = when {
      silenced -> "NO MIC"
      paused -> "PAUSED"
      else -> clock(CaptureController.elapsedMs())
    }
    canvas.drawText(label, puckCx, puckCy + d(27f), text)
  }

  /** mm:ss under an hour, then h:mm — never the 123:07 a bare minute count would produce. */
  private fun clock(ms: Long): String {
    val s = (ms / 1000).coerceAtLeast(0)
    return if (s < 3600) String.format("%d:%02d", s / 60, s % 60)
    else String.format("%dh%02d", s / 3600, (s % 3600) / 60)
  }

  private fun drawButtons(canvas: Canvas, paused: Boolean) {
    val (pauseC, stopC) = buttonCentres()
    val r = d(BTN) / 2f

    // Pause / Resume — white with a ring while running, amber while paused so the whole assembly
    // reads amber and Resume can never be mistaken for Pause.
    val pFill = if (paused) Palette.warningSoft2 else Palette.card
    val pEdge = if (paused) Palette.warningEdge else Palette.lineStrong
    fill.color = pEdge
    canvas.drawCircle(pauseC[0], pauseC[1] + d(3f), r, fill)
    fill.color = pFill
    canvas.drawCircle(pauseC[0], pauseC[1], r, fill)
    stroke.color = pEdge
    stroke.strokeWidth = d(1.5f)
    canvas.drawCircle(pauseC[0], pauseC[1], r - d(0.75f), stroke)
    if (paused) drawPlay(canvas, pauseC[0], pauseC[1]) else drawPauseBars(canvas, pauseC[0], pauseC[1])

    // Stop — the only saturated coral fill anywhere in the overlay.
    fill.color = Palette.dangerEdge
    canvas.drawCircle(stopC[0], stopC[1] + d(4f), r, fill)
    fill.color = Palette.danger
    canvas.drawCircle(stopC[0], stopC[1], r, fill)
    fill.color = Palette.onPrimary
    val h = d(16f) / 2f
    rect.set(stopC[0] - h, stopC[1] - h, stopC[0] + h, stopC[1] + h)
    canvas.drawRoundRect(rect, d(4f), d(4f), fill)
  }

  private fun drawPauseBars(canvas: Canvas, cx: Float, cy: Float) {
    fill.color = Palette.primary
    val w = d(4.5f)
    val h = d(18f)
    val gap = d(5f)
    rect.set(cx - gap / 2f - w, cy - h / 2f, cx - gap / 2f, cy + h / 2f)
    canvas.drawRoundRect(rect, w / 2f, w / 2f, fill)
    rect.set(cx + gap / 2f, cy - h / 2f, cx + gap / 2f + w, cy + h / 2f)
    canvas.drawRoundRect(rect, w / 2f, w / 2f, fill)
  }

  private fun drawPlay(canvas: Canvas, cx: Float, cy: Float) {
    fill.color = Palette.warningDeep
    val s = d(9f)
    val p = android.graphics.Path()
    p.moveTo(cx - s * 0.6f, cy - s)
    p.lineTo(cx + s, cy)
    p.lineTo(cx - s * 0.6f, cy + s)
    p.close()
    canvas.drawPath(p, fill)
  }

  /** Centres of the two buttons, mirrored so the triangle always opens toward the screen. */
  private fun buttonCentres(): Pair<FloatArray, FloatArray> {
    val dy = puckCy + d(BTN_DY)
    val near = puckCx + if (dockedLeft) -d(BTN_DX) else d(BTN_DX)
    val far = puckCx + if (dockedLeft) d(BTN_DX) else -d(BTN_DX)
    // Near the docked edge is Pause; the far one — the deliberate reach — is Stop.
    return Pair(floatArrayOf(near, dy), floatArrayOf(far, dy))
  }

  /** Which control, if any, a touch at ([x], [y]) in view coordinates lands on. */
  fun hitTest(x: Float, y: Float): Action? {
    val pr = d(PUCK) / 2f
    if (dist(x, y, puckCx, puckCy) <= pr) {
      return if (!CaptureController.isRecording) Action.START else Action.TOGGLE_EXPAND
    }
    if (!expanded) return null
    val (pauseC, stopC) = buttonCentres()
    // A slightly generous radius: these are reached for without looking.
    val br = d(BTN) / 2f + d(4f)
    if (dist(x, y, pauseC[0], pauseC[1]) <= br) {
      return if (CaptureController.paused) Action.RESUME else Action.PAUSE
    }
    if (dist(x, y, stopC[0], stopC[1]) <= br) return Action.STOP
    return null
  }

  fun emit(a: Action) = onAction(a)

  // ---- Bounds for the accessibility node provider, matching exactly what is drawn ----

  fun puckBounds(out: android.graphics.Rect) {
    val r = d(PUCK) / 2f
    out.set((puckCx - r).toInt(), (puckCy - r).toInt(), (puckCx + r).toInt(), (puckCy + r).toInt())
  }

  fun pauseBounds(out: android.graphics.Rect) = buttonBounds(out, buttonCentres().first)
  fun stopBounds(out: android.graphics.Rect) = buttonBounds(out, buttonCentres().second)

  private fun buttonBounds(out: android.graphics.Rect, c: FloatArray) {
    val r = d(BTN) / 2f
    out.set((c[0] - r).toInt(), (c[1] - r).toInt(), (c[0] + r).toInt(), (c[1] + r).toInt())
  }

  private fun dist(x1: Float, y1: Float, x2: Float, y2: Float): Float {
    val dx = x1 - x2
    val dy = y1 - y2
    return Math.sqrt((dx * dx + dy * dy).toDouble()).toFloat()
  }
}
