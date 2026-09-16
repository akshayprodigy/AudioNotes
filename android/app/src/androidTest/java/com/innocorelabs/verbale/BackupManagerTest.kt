package com.innocorelabs.verbale

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.BackupManager
import com.innocorelabs.verbale.pipeline.Minutes
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A backup is only worth what comes back out of it.
 *
 * Nothing tested `BackupManager` before this, and its shape is exactly the shape that hides a
 * loss: `TABLES` is a private list of strings, `import` catches each table's failure into a
 * `Log.w` and carries on, and the count the user is shown comes from `countPresent` — which
 * counts MEETINGS. So a table dropped from the list, or listed in the wrong place, restores a
 * library that looks complete and has had its evidence removed. There is no error, no crash and
 * no number that changes.
 *
 * Two tests, for the two paths a restore actually takes:
 *
 *  - [aRestoredMeetingKeepsItsItemsAndTicks] deletes the meeting first, so every insert lands in
 *    empty space. The new-phone case.
 *  - [aRestoreOntoALibraryThatAlreadyHasTheMeetingKeepsItsEvidence] deletes nothing, so every
 *    insert is a REPLACE onto a live row. The merge case, which is not the exotic one: `import`
 *    merges rather than replaces on purpose — the version that deletes what only exists on this
 *    phone is the version that destroys somebody's notes.
 *
 * Both catch all four mutations tried against `TABLES` (each of the three names removed, and
 * `item_sources` moved ahead of `items`), which is NOT what the review that asked for them
 * predicted, and the measured reasons are worth writing down because they are different reasons:
 *
 *  - On the empty path, `item_sources` listed before `items` does not silently lose a race — the
 *    rows reference items that do not exist yet and SQLite's foreign key check REJECTS the
 *    statement. `import` catches that per table into a `Log.w` and carries on, so the failure is
 *    still invisible to the user; it is the catch, not the cascade, that hides it there.
 *  - On the merge path the destruction comes first: `INSERT OR REPLACE INTO meetings` deletes the
 *    conflicting meetings row and cascades that meeting's items, item_sources and item_done away
 *    before anything is re-imported. So a wrong list here does not merely fail to ADD the donor's
 *    evidence, it removes what this phone already had — which is why the merge case is the one
 *    that turns a bad `TABLES` into data loss rather than an incomplete restore.
 *
 * Keeping both is therefore about the paths, not about a division of labour between them.
 *
 * Both tests run the REAL export and the REAL import, which means the whole library on the phone,
 * because that is the only shape BackupManager offers and a hand-rolled copy of its column
 * intersection would test this file's own idea of `TABLES` rather than the list users' data goes
 * through. `import` merges on primary key and is idempotent by design — importing a backup twice
 * changes nothing — so restoring the device's own export over itself is the no-op it looks like.
 */
@RunWith(AndroidJUnit4::class)
class BackupManagerTest {
  private val ctx: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
  private val db = AudioDb.get(ctx)

  private val PASS = "backup-test-passphrase"

  private val anItem = Minutes.Item(
    "action", "Send the vendor mapping — Ana (due tomorrow)",
    listOf(
      Minutes.Source("u1", 61_000L, 64_000L, 0, 27),
      Minutes.Source("u4", 120_000L, 123_000L, 5, 32),
    ),
    61_000L, 123_000L,
  )

  /**
   * A meeting with an item, two pieces of evidence and a tick — then [body] with the backup file.
   *
   * The meeting is torn down in the `finally` whatever happens, and so is the backup: it is
   * written to the cache directory under a name that includes the time, so a leaked one is a file
   * nobody deletes rather than a file that breaks the next run.
   */
  private fun withABackedUpMeeting(body: (meetingId: String, file: java.io.File) -> Unit) {
    val m = "test-backup-" + System.nanoTime()
    db.insertMeeting(m, "Backup test", System.currentTimeMillis(), "free", "/dev/null")
    var file: java.io.File? = null
    try {
      db.replaceItems(m, Minutes.RULES_GEN, listOf(anItem))
      val id = db.items(m).single().id
      db.setItemDone(m, id, true)
      db.addMark(m, 61_000L)
      db.insertAsk(m, "ask-$m", "who owns the mapping?", "Ana [1].", """[{"n":1,"refId":"u1","startMs":61000,"speaker":"Ana"}]""")
      file = BackupManager.export(ctx, PASS)
      body(m, file)
    } finally {
      file?.delete()
      db.deleteMeeting(m)
    }
  }

  /**
   * The gap that made this a regression rather than an omission.
   *
   * `action_done` was carried across and `item_done` was not, so a tick recorded by an older build
   * survived a restore and a tick recorded by this one did not — the tables that give an item a
   * stable identity gave it one that did not survive a phone.
   */
  @Test fun aRestoredMeetingKeepsItsItemsAndTicks() {
    withABackedUpMeeting { m, file ->
      db.deleteMeeting(m)
      assertTrue("precondition: the meeting is gone before the restore", db.items(m).isEmpty())

      BackupManager.import(ctx, file, PASS)

      val restored = db.items(m).singleOrNull()
      assertNotNull("the restore brought back the meeting but not its items", restored)
      assertEquals("Send the vendor mapping — Ana (due tomorrow)", restored!!.text)
      assertEquals(
        "the item came back with no evidence: item_sources did not travel",
        listOf("u1", "u4"), restored.sources.map { it.utteranceId },
      )
      assertEquals(listOf(61_000L, 120_000L), restored.sources.map { it.startMs })
      assertTrue(
        "the item came back unticked: the person's finished work did not survive their new phone",
        db.doneItemIds(m).contains(restored.id),
      )
      // The two tables that hang off a meeting and were, or would have been, left behind.
      assertEquals("the Highlight did not travel", listOf(61_000L), db.marks(m).map { it.atMs })
      assertTrue("the ask did not travel", db.asksJson(m).contains("who owns the mapping?"))
    }
  }

  /**
   * Restoring onto a library that still has the meeting keeps the evidence, and this is the test
   * that pins the ORDER of `BackupManager.TABLES`.
   *
   * Every insert here lands on a row that already exists, so every one is a REPLACE — which is a
   * DELETE followed by an INSERT, and the delete cascades. `item_sources` imported before `items`
   * is therefore written and then wiped out by the parent's replacement, and the evidence is gone
   * from a restore that reported success and returned the right number of meetings.
   */
  @Test fun aRestoreOntoALibraryThatAlreadyHasTheMeetingKeepsItsEvidence() {
    withABackedUpMeeting { m, file ->
      val before = db.items(m).single()
      assertEquals("precondition: two sources to lose", 2, before.sources.size)

      // Nothing is deleted first. This is the merge path: a restore onto a phone that already has
      // some of the library, which is the ordinary case and the only one where order matters.
      BackupManager.import(ctx, file, PASS)

      val after = db.items(m).singleOrNull()
      assertNotNull("the meeting itself did not survive being restored over", after)
      assertEquals("the item's identity changed under a merge restore", before.id, after!!.id)
      assertEquals(
        "the evidence was imported and then cascaded away by its own parent being replaced",
        listOf("u1", "u4"), after.sources.map { it.utteranceId },
      )
      assertTrue("the tick did not survive a merge restore", db.doneItemIds(m).contains(after.id))
    }
  }
}
