package com.audionotes.pipeline

import android.app.Service
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.abs

/**
 * A small draggable floating "recorder bubble" drawn on top of other apps (and visible with the
 * screen on over any app). Tap toggles recording; drag to move. This is what lets the user set the
 * phone down and keep recording without the app's own screen showing.
 *
 * Requires the "display over other apps" permission (SYSTEM_ALERT_WINDOW) — see OverlayModule.
 * The actual mic capture is owned by RecordingService via CaptureController; this is just the UI.
 */
class OverlayService : Service() {

  companion object {
    const val ACTION_SHOW = "com.audionotes.overlay.SHOW"
    const val ACTION_HIDE = "com.audionotes.overlay.HIDE"
  }

  private var wm: WindowManager? = null
  private var bubble: View? = null
  private var label: TextView? = null
  private var params: WindowManager.LayoutParams? = null
  private val handler = Handler(Looper.getMainLooper())
  private val ticker = object : Runnable {
    override fun run() {
      updateLabel()
      handler.postDelayed(this, 1000)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_HIDE -> { removeBubble(); stopSelf() }
      else -> showBubble()
    }
    return START_STICKY
  }

  private fun showBubble() {
    if (bubble != null) return
    wm = getSystemService(WINDOW_SERVICE) as WindowManager

    val size = (64 * resources.displayMetrics.density).toInt()
    val container = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      background = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(Color.parseColor("#171B22"))
        setStroke((2 * resources.displayMetrics.density).toInt(), Color.parseColor("#4F8CFF"))
      }
    }
    val text = TextView(this).apply {
      setTextColor(Color.WHITE)
      textSize = 11f
      gravity = Gravity.CENTER
    }
    container.addView(text)
    label = text

    val type =
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
      else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

    val lp = WindowManager.LayoutParams(
      size, size, type,
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      x = 24
      y = 240
    }

    container.setOnTouchListener(makeTouchListener(lp))
    wm?.addView(container, lp)
    bubble = container
    params = lp
    updateLabel()
    handler.post(ticker)
  }

  private fun makeTouchListener(lp: WindowManager.LayoutParams): View.OnTouchListener {
    var downX = 0f
    var downY = 0f
    var startX = 0
    var startY = 0
    var moved = false
    return View.OnTouchListener { _, event ->
      when (event.action) {
        MotionEvent.ACTION_DOWN -> {
          downX = event.rawX; downY = event.rawY
          startX = lp.x; startY = lp.y; moved = false
          true
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = (event.rawX - downX).toInt()
          val dy = (event.rawY - downY).toInt()
          if (abs(dx) > 8 || abs(dy) > 8) moved = true
          lp.x = startX + dx
          lp.y = startY + dy
          try { wm?.updateViewLayout(bubble, lp) } catch (_: Exception) {}
          true
        }
        MotionEvent.ACTION_UP -> {
          if (!moved) toggleRecording()
          true
        }
        else -> false
      }
    }
  }

  private fun toggleRecording() {
    if (CaptureController.isRecording) {
      CaptureController.stop(applicationContext)
    } else {
      CaptureController.start(applicationContext)
    }
    updateLabel()
  }

  private fun updateLabel() {
    val rec = CaptureController.isRecording
    val stroke = (2 * resources.displayMetrics.density).toInt()
    (bubble?.background as? GradientDrawable)?.setStroke(
      stroke, if (rec) Color.parseColor("#FF5C5C") else Color.parseColor("#4F8CFF"),
    )
    label?.text = if (rec) {
      val s = CaptureController.elapsedMs() / 1000
      "● %02d:%02d".format(s / 60, s % 60)
    } else {
      "REC"
    }
  }

  private fun removeBubble() {
    handler.removeCallbacks(ticker)
    bubble?.let { try { wm?.removeView(it) } catch (_: Exception) {} }
    bubble = null
    label = null
    params = null
  }

  override fun onDestroy() {
    removeBubble()
    super.onDestroy()
  }
}
