package com.innocorelabs.verbale

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.pipeline.ProcessingEngine
import com.innocorelabs.verbale.pipeline.Utt
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Phase 2 (sub-project 6a): the SQL half of meeting templates, which only SQLite can answer —
 * the tag join in rememberTemplateForTags/rememberedTemplate, and the guard that keeps a
 * person's chosen type from being overwritten by the next suggestion pass.
 */
@RunWith(AndroidJUnit4::class)
class TemplatesDbTest {
  private val db = AudioDb.get(InstrumentationRegistry.getInstrumentation().targetContext)
  private val made = ArrayList<String>()

  @After fun cleanUp() { made.forEach { db.deleteMeeting(it) } }

  private fun meeting(): String {
    val id = "test-tpl-" + System.nanoTime()
    db.insertMeeting(id, "Templates test", System.currentTimeMillis(), "free", "/dev/null")
    made.add(id)
    return id
  }

  private fun tag(meetingId: String, name: String) {
    db.exec("INSERT INTO tags(meeting_id, name) VALUES('$meetingId','$name')")
  }

  @Test fun setTemplateThenTemplateRoundTrips() {
    val m = meeting()
    assertNull(db.template(m))
    assertNull(db.templateSource(m))
    db.setTemplate(m, "client", AudioDb.TemplateSource.CHOSEN)
    assertEquals("client", db.template(m))
    assertEquals(AudioDb.TemplateSource.CHOSEN, db.templateSource(m))
  }

  @Test fun rememberTemplateForTagsWritesOneKeyPerTagAndRememberedTemplateReadsTagOrder() {
    val withAcme = meeting()
    tag(withAcme, "acme")
    db.rememberTemplateForTags(withAcme, "client")

    val withWeekly = meeting()
    tag(withWeekly, "weekly")
    db.rememberTemplateForTags(withWeekly, "standup")

    // One settings key per tag, independently readable.
    assertEquals("client", db.rememberedTemplate(listOf("acme")))
    assertEquals("standup", db.rememberedTemplate(listOf("weekly")))

    // "acme" sorts before "weekly", so a meeting tagged with both takes acme's remembered type —
    // this is what "reads it back in tag order" means: alphabetical, first match wins.
    assertEquals("client", db.rememberedTemplate(listOf("weekly", "acme")))
    // Order of the argument list must not matter — the sort happens inside rememberedTemplate.
    assertEquals("client", db.rememberedTemplate(listOf("acme", "weekly")))

    // A tag nothing has remembered contributes nothing.
    assertNull(db.rememberedTemplate(listOf("no-such-tag")))
  }

  @Test fun aChosenTemplateIsNotOverwrittenBySecondSuggestion() {
    val m = meeting()
    db.setTemplate(m, "client", AudioDb.TemplateSource.CHOSEN)

    // A transcript that would score strongly for "standup" if the suggester ran unguarded —
    // reused from the golden's own standup case.
    ProcessingEngine.suggestTemplate(db, m, standupTranscript(), speakerCount = 1)

    assertEquals("client", db.template(m))
    assertEquals(AudioDb.TemplateSource.CHOSEN, db.templateSource(m))
  }

  @Test fun aSuggestedTemplateIsWrittenWhenNothingWasChosen() {
    val m = meeting()
    assertNull(db.templateSource(m))
    ProcessingEngine.suggestTemplate(db, m, standupTranscript(), speakerCount = 1)
    assertEquals("standup", db.template(m))
    assertEquals(AudioDb.TemplateSource.SUGGESTED, db.templateSource(m))
  }

  private fun standupTranscript(): List<Utt> = listOf(
    Utt("u1", 0, 1000, "Yesterday I finished the export screen.", null),
    Utt("u2", 1000, 2000, "Today I am on the paywall.", null),
    Utt("u3", 2000, 3000, "My blocker is the licence server.", null),
  )
}
