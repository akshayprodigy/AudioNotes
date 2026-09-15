package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.pipeline.RecordingService.StartRoute
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * Where RecordingService.onStartCommand sends each intent.
 *
 * The defect this guards: a notification button carries an action and no meeting extras, so an
 * action that is not routed on its own name falls through to the "no meeting — bail" branch and
 * stopSelf() ends the meeting. Mark did exactly that on the Pixel (Task 9 of the marks plan):
 * "marked 269568ms" followed 120 ms later by "capture ended (stopped)". Every control action is
 * listed here against hasMeeting=false, which is the shape of every notification and PiP tap.
 */
class StartRouteTest {
  private fun route(action: String?, hasMeeting: Boolean) = RecordingService.routeFor(action, hasMeeting)

  @Test fun everyControlActionRoutesOnItsNameWithNoMeetingExtras() {
    assertEquals(StartRoute.MARK, route(RecordingService.ACTION_MARK, hasMeeting = false))
    assertEquals(StartRoute.PAUSE, route(RecordingService.ACTION_PAUSE, hasMeeting = false))
    assertEquals(StartRoute.RESUME, route(RecordingService.ACTION_RESUME, hasMeeting = false))
    assertEquals(StartRoute.STOP, route(RecordingService.ACTION_STOP, hasMeeting = false))
  }

  /** The extras never change what a control action means — a Pause with a meeting is still a Pause. */
  @Test fun controlActionsIgnoreTheExtras() {
    assertEquals(StartRoute.MARK, route(RecordingService.ACTION_MARK, hasMeeting = true))
    assertEquals(StartRoute.STOP, route(RecordingService.ACTION_STOP, hasMeeting = true))
  }

  @Test fun aStartWithAMeetingCapturesAndOneWithoutBails() {
    assertEquals(StartRoute.CAPTURE, route(null, hasMeeting = true))
    assertEquals(StartRoute.BAIL, route(null, hasMeeting = false))
    assertEquals(StartRoute.BAIL, route("com.innocorelabs.verbale.action.SOMETHING_ELSE", hasMeeting = false))
  }
}
