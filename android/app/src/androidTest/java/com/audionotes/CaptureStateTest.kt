package com.audionotes

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.audionotes.pipeline.CaptureController
import com.audionotes.pipeline.CaptureListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The capture state machine, tested without a microphone.
 *
 * These cover the failures that actually happened rather than hypotheticals: a notification button
 * that did nothing after a process restart, a mic-loss teardown that left the app believing a
 * meeting was still running forever, and — the one the whole floating-bubble dismiss design rests
 * on — the guarantee that hiding the control never stops the recording.
 *
 * Run with:  ./gradlew connectedDebugAndroidTest
 */
@RunWith(AndroidJUnit4::class)
class CaptureStateTest {

  private val ctx get() = InstrumentationRegistry.getInstrumentation().targetContext

  @After
  fun tearDown() {
    // These tests drive the singleton directly, so leave it clean for whatever runs next.
    CaptureController.onCaptureEnded(CaptureController.END_STOPPED)
  }

  /**
   * The bug that made the notification's Stop a no-op: a process restart handed the meeting id
   * back to the service but never to CaptureController, so isRecording read false while the
   * microphone was live and stop() returned at its first line.
   */
  @Test
  fun adoptRehydratesAfterProcessRestart() {
    CaptureController.onCaptureEnded(CaptureController.END_STOPPED)
    assertFalse("precondition: nothing recording", CaptureController.isRecording)

    val id = "test-meeting-adopt"
    CaptureController.adopt(ctx, id, System.currentTimeMillis() - 30_000L)

    assertTrue("adopt must make the session live", CaptureController.isRecording)
    assertEquals(id, CaptureController.currentMeetingId)
    assertTrue("elapsed must reflect the restored start", CaptureController.elapsedMs() >= 29_000L)
  }

  /** adopt() must be idempotent: onStartCommand can be called more than once for one session. */
  @Test
  fun adoptIsIdempotent() {
    val id = "test-meeting-idem"
    val start = System.currentTimeMillis() - 10_000L
    CaptureController.adopt(ctx, id, start)
    val first = CaptureController.startedAtMs
    CaptureController.adopt(ctx, id, System.currentTimeMillis())
    assertEquals("a second adopt must not restart the clock", first, CaptureController.startedAtMs)
  }

  /**
   * Mic loss and disk-full never go through stop(). Before onCaptureEnded existed they left
   * currentMeetingId set, so isRecording stayed true forever and the next start() returned the
   * dead session's id instead of opening a new one.
   */
  @Test
  fun onCaptureEndedClearsEverythingAndReportsTheReason() {
    val id = "test-meeting-miclost"
    CaptureController.adopt(ctx, id, System.currentTimeMillis())
    CaptureController.applyPause(true)
    assertTrue(CaptureController.paused)

    val seen = CountDownLatch(1)
    var reportedId: String? = null
    var reportedReason: String? = null
    val listener = object : CaptureListener {
      override fun onCaptureEnded(meetingId: String, reason: String) {
        reportedId = meetingId
        reportedReason = reason
        seen.countDown()
      }
    }
    CaptureController.addListener(listener)
    try {
      CaptureController.onCaptureEnded(CaptureController.END_MIC_LOST)
      assertTrue("the terminal event must fire", seen.await(3, TimeUnit.SECONDS))
    } finally {
      CaptureController.removeListener(listener)
    }

    assertEquals(id, reportedId)
    assertEquals(CaptureController.END_MIC_LOST, reportedReason)
    assertFalse("isRecording must be false after the terminal event", CaptureController.isRecording)
    assertNull(CaptureController.currentMeetingId)
    assertFalse("pause state must not survive the session", CaptureController.paused)
    assertEquals(0L, CaptureController.pausedTotalMs)
    assertFalse(CaptureController.stopping)
  }

  /** Paused stretches must not count as captured audio, or the timer outruns the file. */
  @Test
  fun pausedTimeIsExcludedFromElapsed() {
    val id = "test-meeting-pause"
    CaptureController.adopt(ctx, id, System.currentTimeMillis() - 10_000L)

    val before = CaptureController.elapsedMs()
    CaptureController.applyPause(true)
    Thread.sleep(1200)
    CaptureController.applyPause(false)
    val after = CaptureController.elapsedMs()

    // Roughly a second of wall clock passed and none of it was captured, so elapsed must have
    // moved by far less than that.
    assertTrue(
      "paused time leaked into elapsed (before=$before after=$after)",
      after - before < 600L,
    )
  }

  /** applyPause reports whether it changed anything, so a caller can tell "no session" apart. */
  @Test
  fun applyPauseReportsWhetherItChangedAnything() {
    CaptureController.onCaptureEnded(CaptureController.END_STOPPED)
    assertFalse("pause with no session must report no change", CaptureController.applyPause(true))

    CaptureController.adopt(ctx, "test-meeting-flag", System.currentTimeMillis())
    assertTrue(CaptureController.applyPause(true))
    assertFalse("pausing an already-paused session changes nothing", CaptureController.applyPause(true))
    assertTrue(CaptureController.applyPause(false))
  }

  /**
   * THE INVARIANT THE DISMISS GESTURE RESTS ON.
   *
   * Dragging the floating bubble into the pocket hides a control; it must never end the meeting.
   * OverlayService.dismissBubble deliberately shares no code path with stop(), and this asserts
   * the outcome so a later refactor cannot quietly join them: the promise is printed on screen at
   * the moment of the gesture ("Hide — keeps recording"), so breaking it would make the app lie.
   */
  @Test
  fun dismissingTheBubbleLeavesTheRecordingRunning() {
    val id = "test-meeting-dismiss"
    CaptureController.adopt(ctx, id, System.currentTimeMillis())
    assertTrue(CaptureController.isRecording)

    val intent = android.content.Intent(ctx, com.audionotes.pipeline.OverlayService::class.java)
      .apply { action = com.audionotes.pipeline.OverlayService.ACTION_HIDE }
    ctx.startService(intent)
    Thread.sleep(500)

    assertTrue("hiding the bubble must not stop the meeting", CaptureController.isRecording)
    assertEquals(id, CaptureController.currentMeetingId)
    assertFalse("hiding the bubble must not pause it either", CaptureController.paused)
  }
}
