package com.innocorelabs.verbale.pipeline

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EndNoticeTest {
  private val someAudio = 32_000L // one second

  @Test fun aStopIsStoredAsStoppedAndExplainsNothing() {
    assertEquals("stopped", EndNotice.stored(RecordingService.END_NORMAL))
    assertFalse(EndNotice.shouldProcess(RecordingService.END_NORMAL, someAudio))
    assertNull(EndNotice.of(RecordingService.END_NORMAL, someAudio, processing = true, capMinutes = 15))
  }

  @Test fun everyOtherEndingWithAudioIsProcessedAndStoredByName() {
    for (r in listOf(
      RecordingService.END_CAP_REACHED, RecordingService.END_MIC_LOST,
      RecordingService.END_DISK_FULL, RecordingService.END_WRITE_FAILED,
    )) {
      assertTrue(r, EndNotice.shouldProcess(r, someAudio))
      assertEquals(r, EndNotice.stored(r))
    }
  }

  @Test fun nothingCapturedIsNothingToProcess() {
    assertFalse(EndNotice.shouldProcess(RecordingService.END_MIC_UNAVAILABLE, 0L))
    assertFalse(EndNotice.shouldProcess(RecordingService.END_DISK_FULL, 0L))
    val n = EndNotice.of(RecordingService.END_MIC_UNAVAILABLE, 0L, processing = false, capMinutes = 0)!!
    assertEquals("Could not start recording", n.title)
    assertTrue(n.body.contains("Nothing was recorded"))
  }

  /** The old free-limit notice promised transcription that nothing had queued. */
  @Test fun theNoticeSaysWhetherItIsBeingTranscribed() {
    val queued = EndNotice.of(RecordingService.END_MIC_LOST, someAudio, processing = true, capMinutes = 0)!!
    val refused = EndNotice.of(RecordingService.END_MIC_LOST, someAudio, processing = false, capMinutes = 0)!!
    assertTrue(queued.body.contains("It is being transcribed now."))
    assertTrue(refused.body.contains("Open Verbale to transcribe it."))
    assertFalse(refused.body.contains("being transcribed"))
  }

  @Test fun theFreeLimitNoticeNamesTheLimit() =
    assertEquals(
      "Stopped at the 15-minute Free limit",
      EndNotice.of(RecordingService.END_CAP_REACHED, someAudio, processing = true, capMinutes = 15)!!.title,
    )
}
