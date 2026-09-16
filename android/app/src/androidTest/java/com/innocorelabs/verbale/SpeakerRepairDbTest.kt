package com.innocorelabs.verbale

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Re-diarization keeps human work: this is the SQL half of SpeakerRepair, which only SQLite can
 * answer. Before it, assignSpeakers deleted every speaker row and reassigned every line.
 */
@RunWith(AndroidJUnit4::class)
class SpeakerRepairDbTest {
  private val db = AudioDb.get(InstrumentationRegistry.getInstrumentation().targetContext)
  private val made = ArrayList<String>()

  @After fun cleanUp() { made.forEach { db.deleteMeeting(it) } }

  private fun meeting(): String {
    val id = "test-spk-" + System.nanoTime()
    db.insertMeeting(id, "Speaker repair test", System.currentTimeMillis(), "free", "/dev/null")
    made.add(id)
    // Three lines: 0-2 s, 3-5 s, 6-8 s.
    db.replaceUtterancesJson(
      id,
      """[{"start_ms":0,"end_ms":2000,"text":"one"},{"start_ms":3000,"end_ms":5000,"text":"two"},{"start_ms":6000,"end_ms":8000,"text":"three"}]""",
    )
    // First pass: lines 1-2 are cluster 0, line 3 is cluster 1.
    db.assignSpeakers(id, longArrayOf(0, 6000), longArrayOf(5000, 8000), intArrayOf(0, 1))
    return id
  }

  private fun sql(q: String) = db.rawQueryJson(q, arrayOfNulls(0))

  @Test fun aRenamedSpeakerAndAPersonsAssignmentSurviveAnotherPass() {
    val m = meeting()
    val utts = db.utterances(m)
    val speakers = db.speakers(m)
    assertEquals(2, speakers.size)
    val s1 = utts[0].speakerId!!
    val s2 = utts[2].speakerId!!
    assertNotEquals(s1, s2)

    // A person renames the first voice and says line 3 was really the first voice too.
    db.exec("UPDATE speakers SET display_name='Priya' WHERE id='$s1'")
    db.exec("UPDATE utterances SET speaker_id='$s1' WHERE id='${utts[2].id}'")
    db.exec(
      "INSERT OR REPLACE INTO edits(meeting_id,target_kind,target_key,content,edited_at) " +
        "VALUES('$m','speaker','${utts[2].id}','$s1',1)",
    )

    // Diarization runs again and, this time, splits everything the other way round.
    db.assignSpeakers(m, longArrayOf(0, 3000), longArrayOf(2000, 8000), intArrayOf(5, 6))

    val after = db.utterances(m)
    val names = db.speakers(m).associate { it.id to it.displayName }
    // The renamed voice survives, name and id.
    assertEquals("Priya", names[s1])
    // The line a person spoke for is still theirs.
    assertEquals(s1, after[2].speakerId)
    // The untouched lines were re-clustered: line 2 now shares cluster 6 with… line 3, which is
    // pinned, so it got a fresh machine speaker rather than Priya's row.
    assertTrue(after[1].speakerId != null && after[1].speakerId != s1)
    // No two speakers share a name.
    assertEquals(names.values.size, names.values.toSet().size)
    // The old, untouched machine speaker (s2) is gone: nothing protected it.
    assertTrue(s2 !in names)
  }

  @Test fun aHumanCreatedVoiceWithNoLinesIsKept() {
    val m = meeting()
    db.exec("INSERT INTO speakers(id,meeting_id,cluster_label,display_name) VALUES('$m:human','$m','human','Rahul')")
    db.assignSpeakers(m, longArrayOf(0), longArrayOf(8000), intArrayOf(0))
    val names = db.speakers(m).associate { it.id to it.displayName }
    assertEquals("Rahul", names["$m:human"])
  }
}
