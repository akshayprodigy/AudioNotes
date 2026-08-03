package com.audionotes.pipeline

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
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
    private const val CHANNEL_ID = "audionotes.overlay"
    private const val NOTIF_ID = 43
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
      ACTION_HIDE -> {
        removeBubble()
        stopForegroundCompat()
        stopSelf()
        return START_NOT_STICKY
      }
      else -> {
        // Run in the foreground so the bubble survives memory pressure. As a plain started
        // service it was among the first things the system reclaimed, and losing the bubble
        // mid-meeting means losing the only on-screen way to stop the recording.
        //
        // FGS type is specialUse, not microphone: this service draws a window, it does not
        // capture audio (RecordingService owns the mic). Claiming `microphone` here would be
        // a second, false mic-usage signal to the user and to Play review.
        startAsForeground()
        showBubble()
      }
    }
    return START_STICKY
  }

  private fun startAsForeground() {
    createChannel()
    val notif = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("AudioNotes recorder")
      .setContentText("Floating recorder is available")
      .setSmallIcon(android.R.drawable.ic_menu_view)
      .setOngoing(true)
      .build()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(NOTIF_ID, notif)
      }
    } catch (e: Exception) {
      // If the OS refuses (background-start restrictions), the bubble still works for as long
      // as the process lives — it just is not protected from being reclaimed.
      android.util.Log.w("OverlayService", "could not start in foreground", e)
    }
  }

  private fun stopForegroundCompat() {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(STOP_FOREGROUND_REMOVE)
      } else {
        @Suppress("DEPRECATION")
        stopForeground(true)
      }
    } catch (_: Exception) {}
  }

  private fun createChannel() {
    val mgr = getSystemService(NotificationManager::class.java)
    val channel = NotificationChannel(CHANNEL_ID, "Floating recorder", NotificationManager.IMPORTANCE_MIN)
    channel.description = "Keeps the floating recorder bubble alive while it is showing"
    mgr.createNotificationChannel(channel)
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
      // stop() blocks until RecordingService flushes the PCM. This runs from a touch
      // handler on the UI thread, so it must go to a worker or it ANRs.
      Thread {
        CaptureController.stop(applicationContext)
        bubble?.post { updateLabel() }
      }.start()
      // isRecording is cleared synchronously inside stop(), but repaint now so the bubble
      // reacts to the tap immediately rather than after the flush.
      bubble?.post { updateLabel() }
    } else {
      CaptureController.start(applicationContext)
      updateLabel()
    }
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
