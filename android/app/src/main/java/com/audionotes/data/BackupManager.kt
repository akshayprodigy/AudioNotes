package com.audionotes.data

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Moving a user's meetings from one device to another, without a server ever seeing them.
 *
 * The live database is encrypted with a random passphrase wrapped by a hardware-backed Keystore
 * key (see KeystoreKeyManager), which is exactly what makes the app's privacy claim true and
 * exactly what makes the database file worthless as a backup: the key cannot leave the phone, so
 * a copy of the file cannot be opened anywhere else. A backup therefore has to be a re-encrypted
 * export rather than a file copy.
 *
 * It is re-encrypted under a passphrase the USER chooses. The alternatives were both worse. A
 * plaintext archive would write every transcript of every meeting, unencrypted, to shared storage
 * where any app holding a storage permission could read it — for this product that is not a
 * trade-off, it is a contradiction. Deriving a key from the subscription account would leave free
 * users with no backup at all and tie a person's own notes to their billing status.
 *
 * The cost is real and belongs to the user: forget the passphrase and the backup is unreadable,
 * by them and by us. That is the honest shape of an export nobody else can decrypt, and the UI
 * has to say so plainly rather than bury it.
 *
 * Mechanically this is SQLCipher's own `sqlcipher_export`, which writes a complete second
 * database under a different key. Hand-serialising the tables would mean a second description of
 * the schema that drifts from the first the next time a column is added.
 */
object BackupManager {
  private const val TAG = "Backup"

  /** Bumped only when a restore would need to behave differently. Stored inside the backup. */
  private const val FORMAT_VERSION = 1

  /**
   * Tables carried across, and the reason each of the others is not.
   *
   * `models` records which model files exist on THIS device at which paths; importing it would
   * tell a new phone it already has 1.5 GB of weights it has never downloaded. `llm_notes` holds
   * mid-narration checkpoints that are meaningless once the run they belong to is over.
   */
  private val TABLES = listOf(
    "meetings", "segments", "utterances", "speakers", "minutes", "action_done", "settings",
  )

  /** Settings that describe this install rather than this user, and must not travel. */
  private const val LOCAL_SETTINGS = "'licence_token','licence_device_id','licence_clock_floor'"

  class BackupError(message: String) : Exception(message)

  fun suggestedFileName(): String {
    val stamp = SimpleDateFormat("yyyy-MM-dd-HHmm", Locale.US).format(Date())
    return "audionotes-$stamp.anbak"
  }

  /**
   * Write an encrypted backup and return the file.
   *
   * Audio is deliberately not included. Recordings are deleted after transcription by default and
   * run to roughly 115 MB an hour when kept, which would turn a portable backup into something
   * nobody can email; the transcript is what the notes are made of.
   */
  fun export(ctx: Context, passphrase: String): File {
    require(passphrase.isNotBlank()) { "passphrase required" }
    val out = File(ctx.cacheDir, suggestedFileName())
    if (out.exists() && !out.delete()) throw BackupError("Could not clear the previous backup file")

    val db = AudioDb.get(ctx)
    try {
      // sqlcipher_export copies the whole schema and every row into the attached database, which
      // is keyed separately. Doing it this way means a new column is in the backup the day it is
      // added, with nothing here to update.
      db.attach(out.absolutePath, passphrase, "bak")
      db.exportInto("bak")

      // The licence belongs to this install, not to this person's notes. Restoring it onto a
      // second phone would be a licence transfer dressed up as a backup.
      db.exec("DELETE FROM bak.settings WHERE key IN ($LOCAL_SETTINGS)")
      db.exec("DELETE FROM bak.models")
      db.exec("DELETE FROM bak.llm_notes")
      db.exec("CREATE TABLE IF NOT EXISTS bak.backup_meta(key TEXT PRIMARY KEY, value TEXT)")
      db.exec(
        "INSERT OR REPLACE INTO bak.backup_meta(key,value) VALUES('version','$FORMAT_VERSION')",
      )
      db.exec(
        "INSERT OR REPLACE INTO bak.backup_meta(key,value) " +
          "VALUES('created_at','${System.currentTimeMillis()}')",
      )
    } finally {
      // Detached even on failure: an attached database left open would hold a file handle and
      // quietly poison every later export in this process.
      runCatching { db.detach("bak") }
    }

    if (!out.exists() || out.length() == 0L) throw BackupError("The backup came out empty")
    Log.i(TAG, "exported ${out.length()} bytes to ${out.name}")
    return out
  }

  /**
   * Read a backup into this device's database.
   *
   * Merges rather than replaces. A restore usually lands on an empty phone, but not always — and
   * the version where it silently deletes meetings that only exist here is the version that
   * destroys someone's notes. Rows are matched on primary key, so importing the same backup twice
   * changes nothing.
   */
  fun import(ctx: Context, file: File, passphrase: String): Int {
    require(passphrase.isNotBlank()) { "passphrase required" }
    if (!file.exists() || file.length() == 0L) throw BackupError("That backup file is empty")

    val db = AudioDb.get(ctx)
    var restored = 0
    try {
      db.attach(file.absolutePath, passphrase, "bak")

      // ATTACH with the wrong key succeeds; it is the first read that fails, because the pages
      // decrypt to nonsense. So the passphrase is checked by reading, and the failure is reported
      // as what it almost always is rather than as a database error.
      val ok = runCatching { db.count("SELECT count(*) FROM bak.meetings") }.getOrNull()
        ?: throw BackupError("Wrong passphrase, or this file is not an AudioNotes backup")

      for (table in TABLES) {
        val moved = runCatching {
          db.exec("INSERT OR REPLACE INTO main.$table SELECT * FROM bak.$table")
        }
        if (moved.isFailure) {
          // One table failing — a backup written before a column existed — should not throw away
          // the meetings that did restore.
          Log.w(TAG, "could not restore $table", moved.exceptionOrNull())
        }
      }
      restored = ok
    } finally {
      runCatching { db.detach("bak") }
    }

    Log.i(TAG, "restored $restored meetings from ${file.name}")
    return restored
  }
}
