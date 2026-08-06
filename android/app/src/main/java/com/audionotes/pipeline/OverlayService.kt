package com.audionotes.pipeline

import android.animation.ValueAnimator
import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationManagerCompat
import com.audionotes.overlay.BubbleView
import com.audionotes.overlay.DismissView

/**
 * The floating recorder: a small puck drawn over other apps that expands into Pause and Stop.
 *
 * Window layout is owned here; drawing and hit-testing live in [BubbleView] and [DismissView].
 * The microphone is owned by [RecordingService] — this is a remote control, and losing a remote
 * never turns off the TV. That principle is what the dismiss gesture is built around.
 */
class OverlayService : Service(), CaptureListener {

  companion object {
    const val ACTION_SHOW = "com.audionotes.overlay.SHOW"
    const val ACTION_HIDE = "com.audionotes.overlay.HIDE"
    private const val CHANNEL_ID = "audionotes.overlay"
    private const val NOTIF_ID = 43
    private const val TAG = "OverlayService"

    /** Redraw cadence for the meter. 15/s reads as smooth and costs a fraction of 60. */
    private const val FRAME_MS = 66L

    /**
     * The meeting the user last put the bubble away for.
     *
     * Dismissing has to stick, or the next app switch brings it straight back and the gesture
     * reads as broken. It is scoped to the meeting rather than forever: a fling must not be able
     * to permanently delete the app's main interface, so the next meeting starts clean. Cleared in
     * [CaptureController.onCaptureEnded] via the listener below.
     *
     * In memory rather than persisted, deliberately — both services share one process, so this
     * outlives every case that matters, and a process death is exactly when the user should get
     * their control back.
     */
    @Volatile private var dismissedFor: String? = null

    /** True if the bubble should stay away for whatever is running right now. */
    fun isDismissed(): Boolean {
      val d = dismissedFor ?: return false
      return d == (CaptureController.currentMeetingId ?: "idle")
    }
  }

  private var wm: WindowManager? = null
  private var bubble: BubbleView? = null
  private var bubbleLp: WindowManager.LayoutParams? = null
  private var dismiss: DismissView? = null
  private var dismissLp: WindowManager.LayoutParams? = null

  private val handler = Handler(Looper.getMainLooper())
  private var settle: ValueAnimator? = null
  private var enterAnim: ValueAnimator? = null

  /** Puck centre in screen pixels. The window origin is derived from it, never the other way. */
  private var puckX = 0f
  private var puckY = 0f
  private var dockedLeft = true

  private val ticker = object : Runnable {
    override fun run() {
      if (bubble?.tick() == true) bubble?.invalidate()
      handler.postDelayed(this, FRAME_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_HIDE -> {
        teardown()
        stopForegroundCompat()
        stopSelf()
        return START_NOT_STICKY
      }
      else -> {
        startAsForeground()
        showBubble()
      }
    }
    return START_STICKY
  }

  // ---------------------------------------------------------------------------------------------
  // Windows
  // ---------------------------------------------------------------------------------------------

  private fun overlayType(): Int =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
    else @Suppress("DEPRECATION") WindowManager.LayoutParams.TYPE_PHONE

  private fun showBubble() {
    if (bubble != null) return
    // Re-check rather than trust whoever started us: the user can revoke this from system settings
    // at any moment, and addView then throws BadTokenException — which, because this service shares
    // a process with the capture service, would take the live recording down with it.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(this)) {
      Log.w(TAG, "overlay permission not granted; not showing the bubble")
      stopSelf()
      return
    }
    val manager = getSystemService(WINDOW_SERVICE) as? WindowManager ?: return
    wm = manager

    val view = BubbleView(this) { onBubbleAction(it) }
    val scale = com.audionotes.overlay.Scale(this)
    val lp = WindowManager.LayoutParams(
      scale(BubbleView.COLLAPSED_W).toInt(),
      scale(BubbleView.COLLAPSED_H).toInt(),
      overlayType(),
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        layoutInDisplayCutoutMode =
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      }
    }

    view.setOnTouchListener(makeTouchListener())
    try {
      manager.addView(view, lp)
    } catch (e: Exception) {
      Log.e(TAG, "could not add the bubble window", e)
      stopSelf()
      return
    }
    bubble = view
    bubbleLp = lp

    val b = bounds()
    puckX = b.left + scale(BubbleView.PUCK / 2f) + scale(8f)
    puckY = b.top + (b.height() * 0.42f)
    dockedLeft = true
    view.dockedLeft = true
    applyPuckPosition()

    CaptureController.addListener(this)
    handler.post(ticker)
  }

  private fun teardown() {
    handler.removeCallbacks(ticker)
    settle?.cancel(); settle = null
    enterAnim?.cancel(); enterAnim = null
    CaptureController.removeListener(this)
    removeDismissWindow()
    bubble?.let { v -> try { wm?.removeView(v) } catch (_: Exception) {} }
    bubble = null
    bubbleLp = null
  }

  /**
   * Usable screen area, excluding the status bar, navigation bar and any cutout.
   *
   * Read from the WindowManager rather than the service's own resources: a Service has no window,
   * so its DisplayMetrics describe the whole display and would let the puck be parked underneath
   * the status bar or behind the gesture-nav home strip.
   */
  private fun bounds(): android.graphics.Rect {
    val out = android.graphics.Rect()
    val manager = wm ?: return out
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val metrics = manager.currentWindowMetrics
      val insets = metrics.windowInsets.getInsets(
        android.view.WindowInsets.Type.systemBars() or
          android.view.WindowInsets.Type.systemGestures() or
          android.view.WindowInsets.Type.displayCutout(),
      )
      out.set(
        metrics.bounds.left + insets.left,
        metrics.bounds.top + insets.top,
        metrics.bounds.right - insets.right,
        metrics.bounds.bottom - insets.bottom,
      )
    } else {
      val dm = resources.displayMetrics
      val bar = (24 * dm.density).toInt()
      out.set(0, bar, dm.widthPixels, dm.heightPixels - bar)
    }
    return out
  }

  /** Window origin from the puck centre, clamped so the puck can never leave the usable area. */
  private fun applyPuckPosition() {
    val view = bubble ?: return
    val lp = bubbleLp ?: return
    val scale = com.audionotes.overlay.Scale(this)
    val b = bounds()
    val half = scale(BubbleView.PUCK / 2f)
    val margin = scale(6f)

    puckX = puckX.coerceIn(b.left + half + margin, b.right - half - margin)
    // Leave room below for the expanded triangle so the buttons are never off-screen.
    val below = scale(BubbleView.BTN_DY + BubbleView.BTN / 2f + 6f)
    puckY = puckY.coerceIn(b.top + half + margin, b.bottom - half - margin - below)

    val localCx = if (view.expanded) lp.width / 2f else scale(BubbleView.PAD + BubbleView.PUCK / 2f)
    val localCy = scale(BubbleView.PAD + BubbleView.PUCK / 2f)
    lp.x = (puckX - localCx).toInt()
    lp.y = (puckY - localCy).toInt()
    try { wm?.updateViewLayout(view, lp) } catch (_: Exception) {}
  }

  /**
   * Resize the window for the expanded triangle. One updateViewLayout per state change, never per
   * frame: each one is an IPC to the window manager, and doing it on a drag frame janks visibly.
   */
  private fun setExpanded(value: Boolean) {
    val view = bubble ?: return
    val lp = bubbleLp ?: return
    if (view.expanded == value) return
    val scale = com.audionotes.overlay.Scale(this)
    lp.width = scale(if (value) BubbleView.EXPANDED_W else BubbleView.COLLAPSED_W).toInt()
    lp.height = scale(if (value) BubbleView.EXPANDED_H else BubbleView.COLLAPSED_H).toInt()
    view.setExpanded(value)
    applyPuckPosition()
    if (value) handler.postDelayed(collapse, 5000)
    else handler.removeCallbacks(collapse)
  }

  private val collapse = Runnable { setExpanded(false) }

  // ---------------------------------------------------------------------------------------------
  // Touch: tap, drag, snap, dismiss
  // ---------------------------------------------------------------------------------------------

  private fun makeTouchListener(): android.view.View.OnTouchListener {
    var downRawX = 0f
    var downRawY = 0f
    var startX = 0f
    var startY = 0f
    var dragging = false
    var tracker: VelocityTracker? = null
    val slop = ViewConfiguration.get(this).scaledTouchSlop

    return android.view.View.OnTouchListener { v, event ->
      when (event.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          downRawX = event.rawX; downRawY = event.rawY
          startX = puckX; startY = puckY
          dragging = false
          handler.removeCallbacks(collapse)
          settle?.cancel()
          tracker = VelocityTracker.obtain().also { it.addMovement(event) }
          true
        }

        MotionEvent.ACTION_MOVE -> {
          tracker?.addMovement(event)
          val dx = event.rawX - downRawX
          val dy = event.rawY - downRawY
          if (!dragging && Math.hypot(dx.toDouble(), dy.toDouble()) > slop) {
            dragging = true
            // Opening the shelf and reaching the dismiss target must never be possible within one
            // gesture, or Stop and Hide become neighbours.
            setExpanded(false)
            v.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            showDismissWindow()
          }
          if (dragging) {
            puckX = startX + dx
            puckY = startY + dy
            updateArmed()
            applyPuckPosition()
          }
          true
        }

        MotionEvent.ACTION_UP -> {
          val wasDragging = dragging
          val armed = dismiss?.armed == true
          var vx = 0f
          tracker?.let {
            it.computeCurrentVelocity(1000)
            vx = it.xVelocity
            it.recycle()
          }
          tracker = null
          dragging = false

          if (!wasDragging) {
            val hit = bubble?.hitTest(event.x, event.y)
            if (hit != null) {
              v.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
              onBubbleAction(hit)
            } else if (bubble?.expanded == true) {
              // A tap inside the expanded window but on none of the controls. The window is
              // mostly empty space around the triangle and it swallows touches that would
              // otherwise reach the app underneath, so treat that as "close it" rather than
              // silently eating the tap.
              setExpanded(false)
            }
          } else if (armed) {
            v.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
            hideDismissWindow()
            dismissBubble()
          } else {
            hideDismissWindow()
            snapToEdge(vx)
          }
          true
        }

        // Without this branch a gesture interrupted by the system (a notification pulled down over
        // us, a call arriving) left the drag state stale: the dismiss window stayed up and the next
        // tap was treated as the tail of the old drag.
        MotionEvent.ACTION_CANCEL -> {
          tracker?.recycle(); tracker = null
          if (dragging) { hideDismissWindow(); snapToEdge(0f) }
          dragging = false
          true
        }

        else -> false
      }
    }
  }

  /** Fling toward an edge, else settle to whichever is nearer. */
  private fun snapToEdge(vx: Float) {
    val scale = com.audionotes.overlay.Scale(this)
    val b = bounds()
    val half = scale(BubbleView.PUCK / 2f)
    val margin = scale(8f)
    val goLeft = when {
      Math.abs(vx) > scale.dp(800f) -> vx < 0
      else -> puckX < b.centerX()
    }
    val targetX = if (goLeft) b.left + half + margin else b.right - half - margin
    val fromX = puckX
    dockedLeft = goLeft
    bubble?.dockedLeft = goLeft

    settle?.cancel()
    settle = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 320
      interpolator = OvershootInterpolator(1.1f)
      addUpdateListener {
        val t = it.animatedValue as Float
        puckX = fromX + (targetX - fromX) * t
        applyPuckPosition()
      }
      start()
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Dismiss
  // ---------------------------------------------------------------------------------------------

  private fun showDismissWindow() {
    if (dismiss != null) return
    val manager = wm ?: return
    val view = DismissView(this)
    view.recording = CaptureController.isRecording
    val b = bounds()
    val metricsBottom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
      manager.currentWindowMetrics.bounds.bottom else resources.displayMetrics.heightPixels
    view.bottomInset = (metricsBottom - b.bottom).toFloat()

    val lp = WindowManager.LayoutParams(
      WindowManager.LayoutParams.MATCH_PARENT,
      WindowManager.LayoutParams.MATCH_PARENT,
      overlayType(),
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
      PixelFormat.TRANSLUCENT,
    ).apply {
      gravity = Gravity.TOP or Gravity.START
      // Android 12+ drops touches that pass through an untrusted overlay above 0.8 opacity, so a
      // full-screen window at the default 1.0 would make the app underneath dead to touch. The
      // scrim's own alpha carries the visual weight instead.
      alpha = 0.79f
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        layoutInDisplayCutoutMode =
          WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      }
    }
    try {
      manager.addView(view, lp)
    } catch (e: Exception) {
      Log.w(TAG, "could not add the dismiss window", e)
      return
    }
    dismiss = view
    dismissLp = lp

    enterAnim?.cancel()
    enterAnim = ValueAnimator.ofFloat(0f, 1f).apply {
      duration = 200
      interpolator = DecelerateInterpolator()
      addUpdateListener { view.enter = it.animatedValue as Float }
      start()
    }
  }

  private fun updateArmed() {
    val view = dismiss ?: return
    val dx = puckX - view.pocketCx
    val dy = puckY - view.pocketCy
    view.armed = Math.hypot(dx.toDouble(), dy.toDouble()) <= view.captureRadius
  }

  private fun hideDismissWindow() {
    val view = dismiss ?: return
    enterAnim?.cancel()
    enterAnim = ValueAnimator.ofFloat(view.enter, 0f).apply {
      duration = 160
      addUpdateListener { view.enter = it.animatedValue as Float }
      addListener(object : android.animation.AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: android.animation.Animator) = removeDismissWindow()
      })
      start()
    }
  }

  private fun removeDismissWindow() {
    dismiss?.let { v -> try { wm?.removeView(v) } catch (_: Exception) {} }
    dismiss = null
    dismissLp = null
  }

  /**
   * Put the bubble away. Emphatically NOT a stop: the recording continues and the notification is
   * still there to control it. Sharing no code path with CaptureController.stop() is deliberate —
   * it is what guarantees the two can never be confused by a later change.
   */
  private fun dismissBubble() {
    dismissedFor = CaptureController.currentMeetingId ?: "idle"
    Log.i(TAG, "bubble dismissed by drag (recording=${CaptureController.isRecording})")
    teardown()
    stopForegroundCompat()
    stopSelf()
  }

  // ---------------------------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------------------------

  private fun onBubbleAction(action: BubbleView.Action) {
    when (action) {
      BubbleView.Action.START -> {
        Thread {
          val id = CaptureController.start(applicationContext)
          handler.post { if (id != null) bubble?.invalidate() }
        }.start()
      }
      BubbleView.Action.TOGGLE_EXPAND -> setExpanded(!(bubble?.expanded ?: false))
      BubbleView.Action.PAUSE -> { CaptureController.applyPause(true); refresh() }
      BubbleView.Action.RESUME -> { CaptureController.applyPause(false); refresh() }
      BubbleView.Action.STOP -> {
        setExpanded(false)
        // stop() blocks until the PCM is flushed; on the UI thread that is an ANR.
        Thread { CaptureController.stop(applicationContext) }.start()
        refresh()
      }
      BubbleView.Action.OPEN_APP -> {
        try {
          startActivity(
            Intent(this, com.audionotes.MainActivity::class.java)
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
          )
        } catch (e: Exception) {
          Log.w(TAG, "could not open the app", e)
        }
      }
    }
  }

  private fun refresh() {
    handler.post { bubble?.invalidate() }
  }

  // ---- CaptureListener: the bubble follows state changed from anywhere else ----

  override fun onCaptureStarted(meetingId: String) = refresh()
  override fun onPausedChanged(paused: Boolean) = refresh()
  override fun onSilencedChanged(silenced: Boolean) = refresh()
  override fun onCaptureEnded(meetingId: String, reason: String) {
    // The next meeting gets its control back regardless of what was done to this one's.
    dismissedFor = null
    handler.post {
      setExpanded(false)
      bubble?.invalidate()
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Service plumbing
  // ---------------------------------------------------------------------------------------------

  private fun startAsForeground() {
    createChannel()
    val notif = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("Floating recorder")
      .setContentText("Pip is on top of your other apps")
      .setSmallIcon(com.audionotes.R.drawable.ic_notification_rec)
      .setOngoing(true)
      .build()
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
        startForeground(NOTIF_ID, notif, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
      } else {
        startForeground(NOTIF_ID, notif)
      }
    } catch (e: Exception) {
      Log.w(TAG, "could not start in the foreground", e)
    }
  }

  private fun stopForegroundCompat() {
    try { stopForeground(STOP_FOREGROUND_REMOVE) } catch (_: Exception) {}
  }

  private fun createChannel() {
    val channel = NotificationChannelCompat.Builder(CHANNEL_ID, NotificationManagerCompat.IMPORTANCE_MIN)
      .setName("Floating recorder")
      .setDescription("Keeps the floating recorder alive while it is showing")
      .setShowBadge(false)
      .build()
    NotificationManagerCompat.from(this).createNotificationChannel(channel)
  }

  /**
   * Swiped out of Recents. A running meeting keeps its control; an idle bubble left floating over
   * the launcher after the user cleared the app away is the app refusing to leave.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    if (!CaptureController.isRecording) {
      Log.i(TAG, "task removed while idle — removing the bubble")
      teardown()
      stopForegroundCompat()
      stopSelf()
    }
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    teardown()
    super.onDestroy()
  }
}
