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

    /** Where the user parked it, so it comes back where they left it. */
    private const val PREFS = "audionotes.bubble"
    private const val KEY_EDGE_LEFT = "edgeLeft"
    private const val KEY_FY = "fy"

    /** Hold to open the app. Matches the platform long-press, and leaves drag unaffected. */
    private const val LONG_PRESS_MS = 350L

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
      // FLAG_LAYOUT_NO_LIMITS is not optional here, and dropping it in the rewrite was a
      // regression: without it the window is laid out inside the system-bar inset frame, so
      // lp.x/lp.y are measured from below the status bar — while bounds(), puckX/puckY and the
      // dismiss window's pocket are all in absolute display coordinates. The whole overlay landed
      // a status-bar height too low, and every distance compared against the pocket was wrong by
      // the same amount. With the flag, lp.x/lp.y are display-absolute and applyPuckPosition's
      // clamp is the only thing keeping the window on screen — which is what it is written to do.
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
        WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
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

    // Restore where the user last parked it. Without this the bubble reappeared at the left edge
    // at 42% height every single time — so a user who had deliberately moved it out of the way of
    // something had to move it again on every app switch.
    val b = bounds()
    val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    dockedLeft = prefs.getBoolean(KEY_EDGE_LEFT, true)
    val fy = prefs.getFloat(KEY_FY, 0.42f).coerceIn(0f, 1f)
    puckX = if (dockedLeft) b.left + scale(BubbleView.PUCK / 2f) + scale(8f)
    else b.right - scale(BubbleView.PUCK / 2f) - scale(8f)
    puckY = b.top + b.height() * fy
    view.dockedLeft = dockedLeft
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

  /**
   * Place the window from the puck centre.
   *
   * The window is centred on the puck only when there is room. The puck docks 44 design units
   * from the screen edge but the expanded window is 144 wide, so centring it there put its origin
   * 28 units off-screen — and since the OS shifts rather than clips an off-screen window, the
   * ENTIRE overlay jumped sideways every time the triangle opened. The puck the thumb had just
   * touched moved out from under it, which is precisely what this design promises never happens.
   *
   * So the window is clamped into the usable area, and the puck's position WITHIN it is derived
   * afterwards. The puck therefore never moves; near an edge the triangle simply skews inward.
   */
  private fun applyPuckPosition() {
    val view = bubble ?: return
    val lp = bubbleLp ?: return
    val scale = com.audionotes.overlay.Scale(this)
    val b = bounds()
    val half = scale(BubbleView.PUCK / 2f)
    val margin = scale(6f)

    puckX = puckX.coerceIn(b.left + half + margin, b.right - half - margin)
    // Leave room below for the expanded triangle so the buttons are never off-screen.
    val below = if (view.expanded) scale(BubbleView.BTN_DY + BubbleView.BTN / 2f + 6f) else 0f
    puckY = puckY.coerceIn(b.top + half + margin, b.bottom - half - margin - below)

    val localCy = scale(BubbleView.PAD + BubbleView.PUCK / 2f)
    val wantX = puckX - (if (view.expanded) lp.width / 2f else scale(BubbleView.PAD + BubbleView.PUCK / 2f))
    lp.x = wantX.coerceIn(
      (b.left - margin).toDouble().toFloat(),
      (b.right + margin - lp.width).toDouble().toFloat(),
    ).toInt()
    lp.y = (puckY - localCy).toInt()

    // Tell the view where the puck actually landed inside the window, rather than letting it
    // assume the centre. This is what keeps the drawing and the hit-testing agreeing with the
    // window after the clamp above has moved the origin.
    view.setLocalPuckCx(puckX - lp.x)
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
    armCollapse()
  }

  /**
   * (Re)start the five-second idle timer whenever the triangle is left open.
   *
   * ACTION_DOWN cancels it so it cannot fire mid-interaction, but nothing re-armed it afterwards
   * except a fresh expand — so tapping Pause left the shelf open permanently. That matters more
   * than it sounds: the expanded window is 144x154 units of mostly transparent space sitting over
   * whatever app is in front, and it swallows every touch inside its bounds.
   */
  private fun armCollapse() {
    handler.removeCallbacks(collapse)
    if (bubble?.expanded == true) handler.postDelayed(collapse, 5000)
  }

  private val collapse = Runnable { setExpanded(false) }

  // ---------------------------------------------------------------------------------------------
  // Touch: tap, drag, snap, dismiss
  // ---------------------------------------------------------------------------------------------

  /** Set when the hold fired, so the finger-up that follows is not also treated as a tap. */
  @Volatile private var longPressed = false

  private val longPress = Runnable {
    longPressed = true
    bubble?.performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    setExpanded(false)
    onBubbleAction(BubbleView.Action.OPEN_APP)
  }

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
          longPressed = false
          handler.removeCallbacks(collapse)
          settle?.cancel()
          tracker = VelocityTracker.obtain().also { it.addMovement(event) }
          // Hold to open the app. OPEN_APP existed as an action with nothing able to reach it,
          // which meant the bubble was a control you could never get back to the app FROM.
          handler.postDelayed(longPress, LONG_PRESS_MS)
          true
        }

        MotionEvent.ACTION_MOVE -> {
          tracker?.addMovement(event)
          val dx = event.rawX - downRawX
          val dy = event.rawY - downRawY
          if (!dragging && Math.hypot(dx.toDouble(), dy.toDouble()) > slop) {
            dragging = true
            handler.removeCallbacks(longPress) // movement means drag, not hold
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
          handler.removeCallbacks(longPress)
          val wasDragging = dragging
          val wasLongPress = longPressed
          longPressed = false
          val armed = dismiss?.armed == true
          var vx = 0f
          tracker?.let {
            it.computeCurrentVelocity(1000)
            vx = it.xVelocity
            it.recycle()
          }
          tracker = null
          dragging = false

          if (wasLongPress) {
            // The hold already acted; this finger-up must not also count as a tap.
          } else if (!wasDragging) {
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
          armCollapse()
          true
        }

        // Without this branch a gesture interrupted by the system (a notification pulled down over
        // us, a call arriving) left the drag state stale: the dismiss window stayed up and the next
        // tap was treated as the tail of the old drag.
        MotionEvent.ACTION_CANCEL -> {
          handler.removeCallbacks(longPress)
          longPressed = false
          tracker?.recycle(); tracker = null
          if (dragging) { hideDismissWindow(); snapToEdge(0f) }
          dragging = false
          armCollapse()
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
    savePosition()
  }

  /** Remember the dock and the height as a fraction, so it survives rotation and a resolution change. */
  private fun savePosition() {
    val b = bounds()
    if (b.height() <= 0) return
    val fy = ((puckY - b.top) / b.height()).coerceIn(0f, 1f)
    getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
      .putBoolean(KEY_EDGE_LEFT, dockedLeft)
      .putFloat(KEY_FY, fy)
      .apply()
  }

  // ---------------------------------------------------------------------------------------------
  // Dismiss
  // ---------------------------------------------------------------------------------------------

  private fun showDismissWindow() {
    val manager = wm ?: return
    // A drag started within the exit animation of the previous one found a non-null `dismiss` and
    // returned, leaving the new gesture with a target that was fading out and about to be removed
    // — so it could never arm, and dragging to the bottom did nothing at all. Revive it instead.
    dismiss?.let { existing ->
      enterAnim?.cancel()
      existing.recording = CaptureController.isRecording
      enterAnim = ValueAnimator.ofFloat(existing.enter, 1f).apply {
        duration = 140
        interpolator = DecelerateInterpolator()
        addUpdateListener { existing.enter = it.animatedValue as Float }
        start()
      }
      return
    }
    val view = DismissView(this)
    view.recording = CaptureController.isRecording
    val b = bounds()
    val metricsBottom = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
      manager.currentWindowMetrics.bounds.bottom else resources.displayMetrics.heightPixels
    val metricsRight = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R)
      manager.currentWindowMetrics.bounds.right else resources.displayMetrics.widthPixels
    view.bottomInset = (metricsBottom - b.bottom).toFloat()
    // Seed the pocket before attaching, so the very first drag frame measures against a real
    // position instead of the origin.
    val scale = com.audionotes.overlay.Scale(this)
    view.setPocket(metricsRight / 2f, b.bottom - scale(56f))

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
    if (!view.positioned) return // never arm against an unplaced pocket
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
    // NotificationCompat, not Notification.Builder(Context, String): that constructor is API 26
    // and minSdk here is 24, so on Android 7.x it threw the moment the bubble was shown. The same
    // bug was fixed in RecordingService and missed here.
    val notif = androidx.core.app.NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("Floating recorder")
      .setContentText("Pip is on top of your other apps")
      .setSmallIcon(com.audionotes.R.drawable.ic_notification_rec)
      .setOngoing(true)
      .setSilent(true)
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
