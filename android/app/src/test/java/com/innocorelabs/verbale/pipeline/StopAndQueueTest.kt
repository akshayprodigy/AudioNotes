package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** D24: the one stop-then-enqueue every Stop surface calls. The background enqueue itself is device-only. */
class StopAndQueueTest {
  private class Fakes(val stopResult: () -> String?, val enqueueThrows: Boolean = false) {
    val enqueued = ArrayList<String>()
    val logs = ArrayList<String>()
    var stops = 0
    val deps = StopAndQueue.Deps(
      stop = { stops++; stopResult() },
      enqueue = { if (enqueueThrows) throw IllegalStateException("startForegroundService not allowed"); enqueued.add(it) },
      log = { m, _ -> logs.add(m) },
    )
  }

  @Test fun aStopThatReturnsAnIdQueuesThatMeeting() {
    val f = Fakes({ "m1" })
    val o = StopAndQueue.run(f.deps)
    assertEquals(listOf("m1"), f.enqueued)
    assertEquals(StopAndQueue.Outcome("m1", queued = true, leftForSweep = false), o)
    assertEquals(1, f.stops)
    assertTrue(f.logs.isEmpty())
  }

  @Test fun aStopWithNothingRecordingQueuesNothing() {
    val f = Fakes({ null })
    val o = StopAndQueue.run(f.deps)
    assertTrue(f.enqueued.isEmpty())
    assertNull(o.meetingId)
    assertFalse(o.queued)
    assertFalse(o.leftForSweep)
  }

  @Test fun aStopThatThrowsIsContainedAndQueuesNothing() {
    val f = Fakes({ throw RuntimeException("flush timed out") })
    val o = StopAndQueue.run(f.deps)
    assertTrue(f.enqueued.isEmpty())
    assertNull(o.meetingId)
    assertEquals(listOf("stop failed"), f.logs)
  }

  @Test fun anEnqueueThatThrowsLeavesTheMeetingForTheSweepAndSaysSo() {
    val f = Fakes({ "m2" }, enqueueThrows = true)
    val o = StopAndQueue.run(f.deps)
    assertEquals("m2", o.meetingId)
    assertFalse(o.queued)
    assertTrue(o.leftForSweep)
    assertEquals(1, f.logs.size)
    assertTrue(f.logs[0].contains("m2") && f.logs[0].contains("sweep"))
  }
}
