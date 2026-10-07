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
    assertEquals(
      RecordingService.END_WRITE_FAILED,
      CaptureEnd.afterFlush(RecordingService.END_NORMAL) { throw IOException("ENOSPC (No space left on device)") },
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
}
