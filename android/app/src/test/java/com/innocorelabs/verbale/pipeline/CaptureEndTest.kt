package com.innocorelabs.verbale.pipeline

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * N05: the capture loop's closing flush runs in a `finally`, before `stopSelf()` and the end-reason
 * bookkeeping. On a full disk it throws — and an exception out of a `finally` skipped both, so the
 * service kept saying "Recording" over a dead worker (and an uncaught exception on a plain thread
 * takes the process down). [CaptureEnd.afterFlush] is the part that can be tested off a phone; that
 * the service then really stops is a device check.
 */
class CaptureEndTest {

  @Test fun aFlushThatWorksChangesNothing() {
    var ran = false
    assertEquals(
      RecordingService.END_NORMAL,
      CaptureEnd.afterFlush(RecordingService.END_NORMAL) { ran = true },
    )
    assertTrue(ran)
    assertEquals(
      RecordingService.END_CAP_REACHED,
      CaptureEnd.afterFlush(RecordingService.END_CAP_REACHED) {},
    )
  }

  @Test fun aFlushThatThrowsOnAnOtherwiseNormalEndIsAWriteFailure() {
    // (A "no space left" error is its own reason now: see aFullDiskIsReportedAsAFullDiskNotAnUnsavedFile.)
    assertEquals(
      RecordingService.END_WRITE_FAILED,
      CaptureEnd.afterFlush(RecordingService.END_NORMAL) { throw IOException("input/output error (EIO)") },
    )
  }

  @Test fun aFlushThatThrowsNeverReplacesTheReasonTheLoopAlreadyGave() {
    // A full disk that the loop itself noticed is "disk_full", and that is the sentence the person
    // is told; the flush failing on top of it adds nothing.
    assertEquals(
      RecordingService.END_DISK_FULL,
      CaptureEnd.afterFlush(RecordingService.END_DISK_FULL) { throw IOException("ENOSPC") },
    )
    assertEquals(
      RecordingService.END_MIC_LOST,
      CaptureEnd.afterFlush(RecordingService.END_MIC_LOST) { throw IOException("ENOSPC") },
    )
  }

  @Test fun aFailureToCloseTheFileFollowsTheSameRule() {
    assertEquals(RecordingService.END_WRITE_FAILED, CaptureEnd.reasonAfterFailure(RecordingService.END_NORMAL))
    assertEquals(RecordingService.END_DISK_FULL, CaptureEnd.reasonAfterFailure(RecordingService.END_DISK_FULL))
  }

  @Test fun anyExceptionIsContained_notOnlyIo() {
    assertEquals(
      RecordingService.END_WRITE_FAILED,
      CaptureEnd.afterFlush(RecordingService.END_NORMAL) { throw IllegalStateException("closed") },
    )
  }

  // ---- CaptureLoopClose: the order, with fakes ----

  private class Steps {
    val order = ArrayList<String>()
    fun flush(throws: Boolean = false): () -> Unit = { order.add("flush"); if (throws) throw IOException("ENOSPC") }
    fun close(throws: Boolean = false): () -> Unit = { order.add("close"); if (throws) throw IOException("ENOSPC") }
    val stopSelf: () -> Unit = { order.add("stopSelf") }
  }

  @Test fun theClosingSequenceRunsFlushThenCloseThenStopSelfForAnAbnormalEnd() {
    val s = Steps()
    val r = CaptureLoopClose.run(RecordingService.END_DISK_FULL, s.flush(), s.close(), s.stopSelf)
    assertEquals(listOf("flush", "close", "stopSelf"), s.order)
    assertEquals(RecordingService.END_DISK_FULL, r)
  }

  @Test fun aFlushThatThrowsStillClosesAndStopsTheService() {
    val s = Steps()
    val r = CaptureLoopClose.run(RecordingService.END_NORMAL, s.flush(throws = true), s.close(), s.stopSelf)
    assertEquals(listOf("flush", "close", "stopSelf"), s.order)
    assertEquals(RecordingService.END_DISK_FULL, r) // the fakes throw a no-space error
  }

  @Test fun aCloseThatThrowsStillStopsTheService() {
    val s = Steps()
    val r = CaptureLoopClose.run(RecordingService.END_NORMAL, s.flush(), s.close(throws = true), s.stopSelf)
    assertEquals(listOf("flush", "close", "stopSelf"), s.order)
    assertEquals(RecordingService.END_DISK_FULL, r) // the fakes throw a no-space error
  }

  @Test fun bothThrowingStillStopsTheServiceAndKeepsTheLoopsOwnReason() {
    val s = Steps()
    val r = CaptureLoopClose.run(RecordingService.END_MIC_LOST, s.flush(throws = true), s.close(throws = true), s.stopSelf)
    assertEquals(listOf("flush", "close", "stopSelf"), s.order)
    assertEquals(RecordingService.END_MIC_LOST, r)
  }

  @Test fun aNormalStopTearsTheServiceDownElsewhereNotHere() {
    val s = Steps()
    val r = CaptureLoopClose.run(RecordingService.END_NORMAL, s.flush(), s.close(), s.stopSelf)
    assertEquals(listOf("flush", "close"), s.order)
    assertEquals(RecordingService.END_NORMAL, r)
  }

  @Test fun aFullDiskIsReportedAsAFullDiskNotAnUnsavedFile() {
    val noSpace = java.io.IOException("write failed: ENOSPC (No space left on device)")
    assertEquals(RecordingService.END_DISK_FULL, CaptureEnd.reasonAfterFailure(RecordingService.END_NORMAL, noSpace))
    // The OS often wraps it.
    val wrapped = RuntimeException("capture loop error", noSpace)
    assertEquals(RecordingService.END_DISK_FULL, CaptureEnd.reasonAfterFailure(RecordingService.END_NORMAL, wrapped))
    // Any other failure stays a write failure, and a reason already chosen is never replaced.
    assertEquals(RecordingService.END_WRITE_FAILED, CaptureEnd.reasonAfterFailure(RecordingService.END_NORMAL, java.io.IOException("EIO")))
    assertEquals(RecordingService.END_CAP_REACHED, CaptureEnd.reasonAfterFailure(RecordingService.END_CAP_REACHED, noSpace))
    assertEquals(RecordingService.END_DISK_FULL, CaptureEnd.afterFlush(RecordingService.END_NORMAL) { throw noSpace })
  }
}
