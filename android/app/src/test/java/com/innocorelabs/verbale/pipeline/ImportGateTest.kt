package com.innocorelabs.verbale.pipeline

import com.innocorelabs.verbale.pipeline.ImportGate.Refusal
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ImportGateTest {
  @After fun reset() = ImportGate.exit()

  @Test fun `an idle phone lets an import in and marks it running`() {
    assertFalse(ImportGate.running)
    assertNull(ImportGate.enter(recording = false))
    assertTrue(ImportGate.running)
  }

  @Test fun `a second import is refused while one is running, and the first keeps the gate`() {
    assertNull(ImportGate.enter(recording = false))
    assertEquals(Refusal.IMPORT_IN_PROGRESS, ImportGate.enter(recording = false))
    assertTrue(ImportGate.running)
  }

  @Test fun `an import while recording is refused and does not mark the gate running`() {
    assertEquals(Refusal.RECORDING_IN_PROGRESS, ImportGate.enter(recording = true))
    assertFalse(ImportGate.running)
  }

  @Test fun `recording wins when both are true, so the user is told to finish recording`() {
    assertNull(ImportGate.enter(recording = false))
    assertEquals(Refusal.RECORDING_IN_PROGRESS, ImportGate.enter(recording = true))
  }

  @Test fun `leaving the gate lets the next import in`() {
    ImportGate.enter(recording = false)
    ImportGate.exit()
    assertFalse(ImportGate.running)
    assertNull(ImportGate.enter(recording = false))
  }

  @Test fun `a recording start is blocked exactly while an import runs`() {
    assertFalse(ImportGate.blocksStart)
    ImportGate.enter(recording = false)
    assertTrue(ImportGate.blocksStart)
    ImportGate.exit()
    assertFalse(ImportGate.blocksStart)
  }

  @Test fun `the codes and messages JS matches on`() {
    assertEquals("recording_in_progress", Refusal.RECORDING_IN_PROGRESS.code)
    assertEquals("Finish recording first", Refusal.RECORDING_IN_PROGRESS.message)
    assertEquals("import_in_progress", Refusal.IMPORT_IN_PROGRESS.code)
    assertEquals("Finish the import first", Refusal.IMPORT_IN_PROGRESS.message)
  }
}
