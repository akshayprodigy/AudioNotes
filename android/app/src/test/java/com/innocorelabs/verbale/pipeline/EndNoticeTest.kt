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
    assertNull(EndNotice.of(RecordingService.END_NORMAL, someAudio, processing = true, capMinutes = 60))
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

  @Test fun aPauseThatTimedOutIsKeptAndQueuedAndSaysSo() {
    val r = RecordingService.END_PAUSE_TIMEOUT
    assertTrue(EndNotice.shouldProcess(r, someAudio))
    assertEquals(r, EndNotice.stored(r))
    val n = EndNotice.of(r, someAudio, processing = true, capMinutes = 0)!!
    assertEquals("Recording ended", n.title)
    assertTrue(n.body, n.body.startsWith("Ended after an hour paused. Everything recorded was kept."))
    assertTrue(n.body.contains("It is being transcribed now."))
    val refused = EndNotice.of(r, someAudio, processing = false, capMinutes = 0)!!
    assertTrue(refused.body.contains("Open Verbale to transcribe it."))
  }

  @Test fun aPauseThatTimedOutWithNothingRecordedDoesNotBlameTheMicrophone() {
    val n = EndNotice.of(RecordingService.END_PAUSE_TIMEOUT, 0L, processing = false, capMinutes = 0)!!
    assertFalse(n.body.contains("microphone"))
    assertTrue(n.body.contains("Nothing had been recorded"))
    assertFalse(EndNotice.shouldProcess(RecordingService.END_PAUSE_TIMEOUT, 0L))
  }

  @Test fun theFreeLimitNoticeNamesTheLimit() =
    assertEquals(
      "Stopped at the 60-minute Free limit",
      EndNotice.of(RecordingService.END_CAP_REACHED, someAudio, processing = true, capMinutes = 60)!!.title,
    )
}
