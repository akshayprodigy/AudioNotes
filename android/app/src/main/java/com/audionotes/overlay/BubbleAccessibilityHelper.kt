package com.audionotes.overlay

import android.graphics.Rect
import android.view.accessibility.AccessibilityEvent
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.customview.widget.ExploreByTouchHelper
import com.audionotes.pipeline.CaptureController

/**
 * Makes the Canvas-drawn bubble reachable by TalkBack.
 *
 * Everything in [BubbleView] is painted onto a single View, so to an accessibility service the
 * whole control is one unlabelled rectangle: no way to know a recording is running, and no way to
 * reach Pause or Stop at all. A screen-reader user could start a meeting and then have no means of
 * ending it except finding the app again.
 *
 * ExploreByTouchHelper synthesises one virtual node per drawn control, with bounds matching what
 * is actually painted, so exploring by touch lands on the same targets a sighted user taps.
 */
class BubbleAccessibilityHelper(
  private val view: BubbleView,
  private val onAction: (BubbleView.Action) -> Unit,
) : ExploreByTouchHelper(view) {

  companion object {
    const val ID_PUCK = 1
    const val ID_PAUSE = 2
    const val ID_STOP = 3
  }

  override fun getVirtualViewAt(x: Float, y: Float): Int {
    val hit = view.hitTest(x, y)
    return when (hit) {
      BubbleView.Action.PAUSE, BubbleView.Action.RESUME -> ID_PAUSE
      BubbleView.Action.STOP -> ID_STOP
      BubbleView.Action.START, BubbleView.Action.TOGGLE_EXPAND -> ID_PUCK
      else -> HOST_ID
    }
  }

  override fun getVisibleVirtualViews(ids: MutableList<Int>) {
    ids.add(ID_PUCK)
    // The two controls only exist while the triangle is open, and only while there is a meeting
    // to act on. Advertising them otherwise would let a screen reader announce a Stop button that
    // is not drawn and would do nothing.
    if (view.expanded && CaptureController.isRecording) {
      ids.add(ID_PAUSE)
      ids.add(ID_STOP)
    }
  }

  override fun onPopulateNodeForVirtualView(id: Int, node: AccessibilityNodeInfoCompat) {
    val bounds = Rect()
    when (id) {
      ID_PUCK -> {
        node.contentDescription = puckDescription()
        node.className = "android.widget.Button"
        view.puckBounds(bounds)
      }
      ID_PAUSE -> {
        node.contentDescription =
          if (CaptureController.paused) "Resume recording" else "Pause recording"
        node.className = "android.widget.Button"
        view.pauseBounds(bounds)
      }
      ID_STOP -> {
        node.contentDescription = "Stop and save this meeting"
        node.className = "android.widget.Button"
        view.stopBounds(bounds)
      }
      else -> bounds.set(0, 0, 1, 1)
    }
    node.addAction(AccessibilityNodeInfoCompat.ACTION_CLICK)
    node.setBoundsInParent(bounds)
  }

  /** The puck carries the state, because for a screen reader it is the only thing always present. */
  private fun puckDescription(): String = when {
    !CaptureController.isRecording -> "AudioNotes. Not recording. Double tap to start."
    CaptureController.silenced ->
      "AudioNotes. Microphone unavailable, nothing is being captured. Double tap for controls."
    CaptureController.paused ->
      "AudioNotes. Paused at ${spoken(CaptureController.elapsedMs())}. Double tap for controls."
    else ->
      "AudioNotes. Recording, ${spoken(CaptureController.elapsedMs())}. Double tap for controls."
  }

  /** "3 minutes 20 seconds" rather than "3:20", which TalkBack reads as a time of day. */
  private fun spoken(ms: Long): String {
    val total = (ms / 1000).coerceAtLeast(0)
    val m = total / 60
    val s = total % 60
    return when {
      m == 0L -> "$s seconds"
      s == 0L -> "$m minute${if (m == 1L) "" else "s"}"
      else -> "$m minute${if (m == 1L) "" else "s"} $s seconds"
    }
  }

  override fun onPerformActionForVirtualView(id: Int, action: Int, arguments: android.os.Bundle?): Boolean {
    if (action != AccessibilityNodeInfoCompat.ACTION_CLICK) return false
    val a = when (id) {
      ID_PUCK ->
        if (CaptureController.isRecording) BubbleView.Action.TOGGLE_EXPAND else BubbleView.Action.START
      ID_PAUSE ->
        if (CaptureController.paused) BubbleView.Action.RESUME else BubbleView.Action.PAUSE
      ID_STOP -> BubbleView.Action.STOP
      else -> return false
    }
    onAction(a)
    // Re-announce so the change is confirmed out loud; without it a screen-reader user gets no
    // feedback that pause actually took effect.
    invalidateVirtualView(ID_PUCK, AccessibilityEvent.CONTENT_CHANGE_TYPE_CONTENT_DESCRIPTION)
    return true
  }
}
