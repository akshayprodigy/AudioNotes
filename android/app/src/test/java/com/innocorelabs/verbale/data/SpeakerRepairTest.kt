package com.innocorelabs.verbale.data

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * What re-diarization must leave alone. The defect it guards: assignSpeakers used to delete every
 * speaker row and reassign every line, so a person's renames, new voices and "no, SHE said that"
 * corrections vanished the first time diarization ran again — which it does for any meeting
 * recorded before the speaker models were on the phone.
 */
class SpeakerRepairTest {
  private val machine1 = SpeakerRepair.SpeakerRow("s1", "S0", "Speaker 1")
  private val machine2 = SpeakerRepair.SpeakerRow("s2", "S1", "Speaker 2")
  private val renamed = SpeakerRepair.SpeakerRow("s3", "S2", "Priya")
  private val human = SpeakerRepair.SpeakerRow("s4", "human", "Speaker 4")

  @Test fun aRenamedSpeakerIsProtected() {
    assertEquals(setOf("s3"), SpeakerRepair.protectedIds(listOf(machine1, renamed), emptyMap()))
  }

  @Test fun aHumanCreatedSpeakerIsProtectedEvenWithAMachineLookingName() {
    assertEquals(setOf("s4"), SpeakerRepair.protectedIds(listOf(machine1, human), emptyMap()))
  }

  @Test fun aMachineSpeakerSomebodyAssignedALineToIsProtected() {
    val edits = mapOf("u7" to "s2")
    assertEquals(setOf("s2"), SpeakerRepair.protectedIds(listOf(machine1, machine2), edits))
  }

  @Test fun anUntouchedMachineSpeakerIsNot() {
    assertEquals(emptySet<String>(), SpeakerRepair.protectedIds(listOf(machine1, machine2), emptyMap()))
  }

  @Test fun theMachineNamePatternIsExact() {
    // "Speaker 12" is machine; "Speaker", "Speaker ", "speaker 1", "Speaker 1 (Priya)" are a person's.
    assertEquals(true, SpeakerRepair.isMachineName("Speaker 12"))
    assertEquals(false, SpeakerRepair.isMachineName("Speaker"))
    assertEquals(false, SpeakerRepair.isMachineName("Speaker "))
    assertEquals(false, SpeakerRepair.isMachineName("speaker 1"))
    assertEquals(false, SpeakerRepair.isMachineName("Speaker 1 (Priya)"))
  }

  @Test fun onlyEditsWhoseSpeakerStillExistsAreReapplied() {
    val edits = mapOf("u1" to "s2", "u2" to "gone")
    assertEquals(mapOf("u1" to "s2"), SpeakerRepair.reapplicable(edits, setOf("s1", "s2")))
  }

  @Test fun pinnedLinesAreExactlyTheEditedOnes() {
    assertEquals(setOf("u1", "u2"), SpeakerRepair.pinnedLines(mapOf("u1" to "s2", "u2" to "s1")))
  }
}
