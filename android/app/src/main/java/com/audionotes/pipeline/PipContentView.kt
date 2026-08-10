package com.audionotes.pipeline

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Shader
import android.graphics.Typeface
import android.view.View

/**
 * The recorder drawn INSIDE the Picture-in-Picture window, natively.
 *
 * Why native and not React Native: the Android PiP surface only captures the activity's main
 * window, and react-native-screens' native-stack screen owns that window and draws above any RN
 * view — so an RN overlay, a navigator replace, a Modal and a per-screen layout all failed to
 * appear in the PiP pane. A plain Android View added on top of the content root is part of that
 * captured window and wins. It reads capture state straight from [CaptureController] (no bridge)
 * and self-invalidates each frame while recording, so it keeps animating with the JS thread busy.
 *
 * The composition mirrors src/components/PipRecorder.tsx: Pip (the mascot) listening beside a
 * coral mic button that holds the live level wave (a pause glyph when paused), a pulsing "live"
 * ring, the elapsed clock, and a corner cross — in the app's light palette with hard-shadow depth.
 */
class PipContentView(context: Context) : View(context) {

  // Light palette (the app forces light chrome). Kept in sync with src/theme/palette.ts.
  private val cCanvas = Color.parseColor("#F5F7FA")
  private val cPrimary = Color.parseColor("#4A56D2")
  private val cPrimaryEdge = Color.parseColor("#3A45B4")
  private val cDanger = Color.parseColor("#E9575A")
  private val cDangerLight = Color.parseColor("#F0696C")
  private val cDangerEdge = Color.parseColor("#C6474A")
  private val cInk = Color.parseColor("#16192C")
  private val cInkFaint = Color.parseColor("#A2A8BC")
  private val cInkDim = Color.parseColor("#8A90A6")
  private val cMuteEdge = Color.parseColor("#7C84A6")
  private val cBlush = Color.parseColor("#FFC9CE")

  private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
  private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    style = Paint.Style.STROKE
    strokeCap = Paint.Cap.ROUND
    strokeJoin = Paint.Join.ROUND
  }
  private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
    textAlign = Paint.Align.LEFT
  }
  private val oval = RectF()
  private val rrect = RectF()
  private val path = Path()

  private val startNanos = System.nanoTime()
  private fun seconds(): Float = (System.nanoTime() - startNanos) / 1_000_000_000f

  init {
    // Purely decorative: never take touch or focus, so nothing here can interfere with the
    // system's tap-to-reveal PiP controls (Pause/Stop/close).
    isClickable = false
    isFocusable = false
    isFocusableInTouchMode = false
  }

  override fun onDraw(canvas: Canvas) {
    val w = width.toFloat()
    val h = height.toFloat()
    if (w <= 0f || h <= 0f) return
    canvas.drawColor(cCanvas)

    val recording = CaptureController.isRecording
    val paused = CaptureController.paused
    val active = recording && !paused
    val level = CaptureController.level.coerceIn(0f, 1f)
    val t = seconds()

    // Row: [ mascot | mic ], clock beneath, cross top-right.
    val rowCy = h * 0.42f
    val mascotSize = minOf(h * 0.52f, w * 0.30f)
    val micR = minOf(h * 0.58f, w * 0.36f) * 0.5f
    val gap = w * 0.05f
    val rowW = mascotSize + gap + micR * 2f
    val startX = (w - rowW) / 2f

    val bob = if (active) (Math.sin((t * 3.6).toDouble()) * mascotSize * 0.05f).toFloat() else 0f
    drawMascot(canvas, startX + mascotSize / 2f, rowCy + bob, mascotSize, active)

    drawMic(canvas, startX + mascotSize + gap + micR, rowCy, micR, level, active, paused, t)

    drawClock(canvas, w * 0.5f, h * 0.85f, h, paused)

    // Animate only while capturing, and throttled to ~20fps rather than every vsync frame:
    // continuously invalidating hammered the compositor and could keep the PiP surface "busy"
    // enough to swallow the system's tap-to-reveal controls. 20fps keeps the wave alive cheaply.
    if (recording) postInvalidateDelayed(50L)
  }

  /** Pip, transcribed from Mascot.tsx's SVG (viewBox 120), scaled around its visual centre (60,62). */
  private fun drawMascot(canvas: Canvas, cx: Float, cy: Float, size: Float, active: Boolean) {
    val scale = size / 92f // the character body spans ~ -8..108 of the 120 box; 92 frames it tightly
    canvas.save()
    canvas.translate(cx, cy)
    canvas.scale(scale, scale)
    canvas.translate(-60f, -62f)

    fill.color = cPrimary
    canvas.drawCircle(60f, 58f, 38f, fill) // body
    fill.color = cPrimaryEdge
    rrect.set(12f, 46f, 30f, 76f); canvas.drawRoundRect(rrect, 9f, 9f, fill) // ear cups
    rrect.set(90f, 46f, 108f, 76f); canvas.drawRoundRect(rrect, 9f, 9f, fill)

    stroke.color = cPrimary; stroke.strokeWidth = 7f // headband (top semicircle)
    oval.set(20f, 10f, 100f, 90f)
    canvas.drawArc(oval, 180f, -180f, false, stroke)

    fill.color = Color.WHITE
    canvas.drawCircle(60f, 63f, 27f, fill) // face

    fill.color = cInk
    if (active) {
      canvas.drawCircle(51f, 59f, 4.6f, fill)
      canvas.drawCircle(69f, 59f, 4.6f, fill)
      canvas.drawOval(RectF(55f, 67f, 65f, 79f), fill) // open "listening" mouth
    } else {
      canvas.drawCircle(51f, 60f, 4.6f, fill)
      canvas.drawCircle(69f, 60f, 4.6f, fill)
      stroke.color = cInk; stroke.strokeWidth = 3.4f // gentle smile
      path.reset(); path.moveTo(52f, 72f); path.quadTo(60f, 80f, 68f, 72f)
      canvas.drawPath(path, stroke)
    }
    fill.color = cBlush
    canvas.drawCircle(40f, 68f, 5f, fill)
    canvas.drawCircle(80f, 68f, 5f, fill)
    canvas.restore()
  }

  private fun drawMic(
    canvas: Canvas, cx: Float, cy: Float, r: Float,
    level: Float, active: Boolean, paused: Boolean, t: Float,
  ) {
    // Pulsing "live" ring (2.2s loop): scale 0.9 -> 1.45 while fading out.
    if (active) {
      val phase = (t % 2.2f) / 2.2f
      fill.color = cDanger
      fill.alpha = (255 * 0.3f * (1f - phase)).toInt()
      canvas.drawCircle(cx, cy, r * (0.9f + 0.55f * phase), fill)
      fill.alpha = 255
    }

    // Hard offset shadow, then the gradient face.
    fill.color = if (active) cDangerEdge else cMuteEdge
    canvas.drawCircle(cx, cy, r, fill)
    canvas.save()
    canvas.translate(0f, -r * 0.055f)
    fill.shader = LinearGradient(
      cx, cy - r, cx, cy + r,
      if (active) cDangerLight else cInkFaint,
      if (active) cDanger else cInkDim,
      Shader.TileMode.CLAMP,
    )
    canvas.drawCircle(cx, cy, r, fill)
    fill.shader = null

    if (paused) {
      // Two rounded bars = pause.
      fill.color = Color.WHITE
      val bw = r * 0.18f; val gap = r * 0.16f; val bh = r * 0.52f
      rrect.set(cx - gap - bw, cy - bh / 2f, cx - gap, cy + bh / 2f)
      canvas.drawRoundRect(rrect, bw * 0.4f, bw * 0.4f, fill)
      rrect.set(cx + gap, cy - bh / 2f, cx + gap + bw, cy + bh / 2f)
      canvas.drawRoundRect(rrect, bw * 0.4f, bw * 0.4f, fill)
    } else {
      // Live wave: 7 white bars modulated by the mic level with a travelling ripple.
      fill.color = Color.WHITE
      val n = 7
      val bw = r * 0.11f
      val step = r * 0.24f
      val maxH = r * 0.78f
      val lvl = Math.pow(level.toDouble(), 0.65).toFloat()
      val first = cx - step * (n - 1) / 2f
      for (i in 0 until n) {
        val ripple = 1f + 0.3f * Math.sin((t * 6.0 + i * 0.7)).toFloat()
        val s = (0.3f + lvl * ripple * 0.7f).coerceIn(0.28f, 1f)
        val bh = maxH * s
        val x = first + i * step
        rrect.set(x - bw / 2f, cy - bh / 2f, x + bw / 2f, cy + bh / 2f)
        canvas.drawRoundRect(rrect, bw / 2f, bw / 2f, fill)
      }
    }
    canvas.restore()
  }

  private fun drawClock(canvas: Canvas, cx: Float, cy: Float, h: Float, paused: Boolean) {
    val ms = CaptureController.elapsedMs()
    val sec = (ms / 1000).coerceAtLeast(0)
    val label = "%02d:%02d".format(sec / 60, sec % 60)
    text.color = cInk
    text.textSize = h * 0.16f
    val tw = text.measureText(label)
    val dotR = h * 0.028f
    val gap = h * 0.035f
    val totalW = dotR * 2f + gap + tw
    val left = cx - totalW / 2f
    fill.color = if (paused) cInkFaint else cDanger
    canvas.drawCircle(left + dotR, cy, dotR, fill)
    val fm = text.fontMetrics
    canvas.drawText(label, left + dotR * 2f + gap, cy - (fm.ascent + fm.descent) / 2f, text)
  }
}
