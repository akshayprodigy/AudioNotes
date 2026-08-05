package com.audionotes.data

import android.content.Context
import net.zetetic.database.sqlcipher.SQLiteDatabase
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/**
 * Single shared handle to the encrypted (SQLCipher) database. Both the RN Storage module and
 * the native capture/pipeline code write through this, so there is exactly one DB connection
 * and one canonical schema. Key comes from [KeystoreKeyManager].
 *
 * This Kotlin schema is the source of truth; src/db/schema.ts mirrors it for the JS layer.
 */
class AudioDb private constructor(private val db: SQLiteDatabase) {

  fun rawQueryJson(sql: String, args: Array<String?>): String {
    val trimmed = sql.trimStart()
    if (!trimmed.regionMatches(0, "SELECT", 0, 6, ignoreCase = true)) {
      db.execSQL(sql, args)
      return "[]"
    }
    val out = JSONArray()
    db.rawQuery(sql, args).use { c ->
      val cols = c.columnNames
      while (c.moveToNext()) {
        val row = JSONObject()
        for (i in cols.indices) {
          when (c.getType(i)) {
            android.database.Cursor.FIELD_TYPE_NULL -> row.put(cols[i], JSONObject.NULL)
            android.database.Cursor.FIELD_TYPE_INTEGER -> row.put(cols[i], c.getLong(i))
            android.database.Cursor.FIELD_TYPE_FLOAT -> row.put(cols[i], c.getDouble(i))
            else -> row.put(cols[i], c.getString(i))
          }
        }
        out.put(row)
      }
    }
    return out.toString()
  }

  fun searchJson(term: String): String {
    val sql =
      "SELECT meeting_id AS meeting_id, text AS snippet " +
        "FROM meetings_fts WHERE meetings_fts MATCH ? LIMIT 50"
    return try {
      rawQueryJson(sql, arrayOf(term))
    } catch (_: Exception) {
      "[]"
    }
  }

  // ---- Helpers used by native capture / pipeline ----

  /**
   * `audioPath` is written up front, at creation, NOT when capture finishes. The path is
   * deterministic and known before the service starts, and recording it here is what lets
   * process() find the audio even if it is called the instant stop() returns — previously
   * audio_path was only set in RecordingService.onDestroy, which races with stopService().
   */
  fun insertMeeting(id: String, title: String, createdAt: Long, tier: String, audioPath: String) {
    db.execSQL(
      "INSERT INTO meetings(id,title,created_at,status,tier_used,audio_path) VALUES(?,?,?, 'recording', ?,?)",
      arrayOf<Any?>(id, title, createdAt, tier, audioPath),
    )
  }

  /**
   * Rescue meetings stranded in 'recording'.
   *
   * A row only leaves 'recording' in RecordingService.onDestroy. If the process is killed
   * mid-capture (OEM battery manager, low memory, crash) that never runs, so the meeting sits
   * in 'recording' forever — and processPending() only looks at 'captured', which means the
   * audio on disk is never transcribed and the user silently loses the meeting.
   *
   * Call on startup, once capture is known to be idle. Rows with real audio are promoted to
   * 'captured' with the duration derived from the byte count; rows with no usable audio are
   * marked 'error' so they stop looking like they are still recording.
   *
   * @param excludeId the meeting currently being captured, if any. It is legitimately in
   *   'recording' and must be left alone — promoting it would stop the live meeting from ever
   *   being finalised properly.
   * @return number of rows recovered.
   */
  fun recoverOrphanedRecordings(excludeId: String?): Int {
    var recovered = 0
    val stranded = mutableListOf<Pair<String, String?>>()
    db.rawQuery("SELECT id, audio_path FROM meetings WHERE status='recording'", null).use { c ->
      while (c.moveToNext()) {
        val id = c.getString(0)
        if (id != excludeId) stranded.add(id to c.getString(1))
      }
    }
    for ((id, path) in stranded) {
      val bytes = if (path != null) java.io.File(path).length() else 0L
      // Under ~1s of PCM is not a meeting; treat it as a failed start.
      if (bytes > 32_000L) {
        markCaptured(id, bytes / 32L, path!!)
        recovered++
      } else {
        setStatus(id, "error")
      }
    }
    return recovered
  }

  fun markCaptured(id: String, durationMs: Long, audioPath: String) {
    db.execSQL(
      "UPDATE meetings SET status='captured', duration_ms=?, audio_path=? WHERE id=?",
      arrayOf<Any?>(durationMs, audioPath, id),
    )
  }

  /** Track whether the raw PCM still exists, so the UI can offer/hide Reprocess honestly. */
  fun setAudioRetained(id: String, retained: Boolean) {
    db.execSQL(
      "UPDATE meetings SET audio_retained=? WHERE id=?",
      arrayOf<Any?>(if (retained) 1 else 0, id),
    )
  }

  fun setStatus(id: String, status: String) {
    db.execSQL("UPDATE meetings SET status=? WHERE id=?", arrayOf<Any?>(status, id))
  }

  fun getAudioPath(id: String): String? {
    db.rawQuery("SELECT audio_path FROM meetings WHERE id=?", arrayOf(id)).use { c ->
      return if (c.moveToFirst()) c.getString(0) else null
    }
  }

  /**
   * Non-speech annotations whisper emits in place of words: `[BLANK_AUDIO]`, `[SILENCE]`,
   * `(music playing)`, `[ Applause ]`. VAD trims most silence, but a span that is quiet rather
   * than empty still reaches the decoder and comes back as one of these, which then becomes a
   * transcript bubble, an FTS hit, a candidate meeting title and a line in every export.
   *
   * Anything left of the text once bracketed and parenthesised runs are removed is real speech, so
   * a segment is dropped only when NOTHING but annotation and punctuation remains. A caption that
   * happens to contain "[laughs]" mid-sentence keeps the sentence.
   */
  private val ANNOTATION = Regex("""[\[(][^\])]*[\])]""")

  private fun isNonSpeech(text: String): Boolean =
    ANNOTATION.replace(text, "").none { it.isLetterOrDigit() }

  /** Replace the transcript for a meeting from a JSON array of {start_ms,end_ms,text}. Returns count. */
  fun replaceUtterancesJson(meetingId: String, json: String): Int {
    val arr = JSONArray(json)
    var kept = 0
    db.beginTransaction()
    try {
      db.execSQL("DELETE FROM utterances WHERE meeting_id=?", arrayOf<Any?>(meetingId))
      db.execSQL("DELETE FROM meetings_fts WHERE meeting_id=?", arrayOf<Any?>(meetingId))
      for (i in 0 until arr.length()) {
        val o = arr.getJSONObject(i)
        val text = o.getString("text").trim()
        if (isNonSpeech(text)) continue
        db.execSQL(
          "INSERT INTO utterances(id,meeting_id,start_ms,end_ms,speaker_id,text) VALUES(?,?,?,?,NULL,?)",
          arrayOf<Any?>(UUID.randomUUID().toString(), meetingId, o.getLong("start_ms"), o.getLong("end_ms"), text),
        )
        db.execSQL(
          "INSERT INTO meetings_fts(meeting_id,text) VALUES(?,?)",
          arrayOf<Any?>(meetingId, text),
        )
        kept++
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    // The count downstream decides "did this meeting have speech", so it has to be what was
    // actually stored — returning the raw segment count marks an all-silence recording as ready
    // with an empty transcript instead of "no speech found".
    return kept
  }

  /**
   * Assign a speaker to each utterance from diarization output. Creates one speaker row per cluster
   * and picks, per utterance, the cluster with the greatest temporal overlap. Arrays are parallel:
   * diar segment i is [starts[i], ends[i]] with cluster clusters[i] (all in ms).
   */
  fun assignSpeakers(meetingId: String, starts: LongArray, ends: LongArray, clusters: IntArray) {
    if (starts.isEmpty()) return
    db.beginTransaction()
    try {
      db.execSQL("DELETE FROM speakers WHERE meeting_id=?", arrayOf<Any?>(meetingId))

      // One speaker row per distinct cluster.
      val idFor = HashMap<Int, String>()
      var n = 1
      for (cl in clusters.toSortedSet()) {
        val sid = UUID.randomUUID().toString()
        idFor[cl] = sid
        db.execSQL(
          "INSERT INTO speakers(id,meeting_id,cluster_label,display_name) VALUES(?,?,?,?)",
          arrayOf<Any?>(sid, meetingId, "S$cl", "Speaker $n"),
        )
        n++
      }

      // Read utterance timings, then assign by max overlap.
      data class U(val id: String, val s: Long, val e: Long)
      val utts = ArrayList<U>()
      db.rawQuery(
        "SELECT id,start_ms,end_ms FROM utterances WHERE meeting_id=? ORDER BY start_ms",
        arrayOf(meetingId),
      ).use { c ->
        while (c.moveToNext()) utts.add(U(c.getString(0), c.getLong(1), c.getLong(2)))
      }

      for (u in utts) {
        val overlapByCluster = HashMap<Int, Long>()
        for (i in starts.indices) {
          val ov = minOf(u.e, ends[i]) - maxOf(u.s, starts[i])
          if (ov > 0) overlapByCluster[clusters[i]] = (overlapByCluster[clusters[i]] ?: 0L) + ov
        }
        val best = overlapByCluster.maxByOrNull { it.value }?.key ?: continue
        val sid = idFor[best] ?: continue
        db.execSQL(
          "UPDATE utterances SET speaker_id=? WHERE id=?",
          arrayOf<Any?>(sid, u.id),
        )
      }

      // Drop clusters that ended up owning no speech, then renumber what is left.
      //
      // Clustering runs with an automatic speaker count, and on real room audio it over-splits:
      // a two-person conversation recorded through the mic produced SIX clusters, of which only
      // two ever won an utterance. Keeping the empty ones is not harmless — the meeting header
      // claimed "6 speakers" for a two-person call, and the Speakers screen listed four phantom
      // people with nothing to merge. The transcript was right the whole time; only the roster
      // was wrong.
      //
      // Renumbering matters too: without it the survivors keep their original ordinals, so a
      // two-speaker meeting shows "Speaker 1" and "Speaker 3" and the missing 2 looks like a bug.
      db.execSQL(
        "DELETE FROM speakers WHERE meeting_id=? AND id NOT IN " +
          "(SELECT speaker_id FROM utterances WHERE meeting_id=? AND speaker_id IS NOT NULL)",
        arrayOf<Any?>(meetingId, meetingId),
      )
      val survivors = ArrayList<String>()
      db.rawQuery(
        "SELECT id FROM speakers WHERE meeting_id=? ORDER BY cluster_label",
        arrayOf(meetingId),
      ).use { c -> while (c.moveToNext()) survivors.add(c.getString(0)) }
      survivors.forEachIndexed { i, sid ->
        db.execSQL(
          "UPDATE speakers SET display_name=? WHERE id=?",
          arrayOf<Any?>("Speaker ${i + 1}", sid),
        )
      }

      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun upsertModel(id: String, name: String, kind: String, path: String, sha256: String, size: Long, installedAt: Long) {
    db.execSQL(
      "INSERT OR REPLACE INTO models(id,name,kind,path,sha256,size_bytes,installed_at) VALUES(?,?,?,?,?,?,?)",
      arrayOf<Any?>(id, name, kind, path, sha256, size, installedAt),
    )
  }

  fun deleteModel(id: String) {
    db.execSQL("DELETE FROM models WHERE id=?", arrayOf<Any?>(id))
  }

  /** Replace VAD segments for a meeting. [segments] is flat [start0,end0,start1,end1,...] in ms. */
  fun replaceSegments(meetingId: String, segments: LongArray) {
    db.beginTransaction()
    try {
      db.execSQL("DELETE FROM segments WHERE meeting_id=?", arrayOf<Any?>(meetingId))
      var i = 0
      while (i + 1 < segments.size) {
        db.execSQL(
          "INSERT INTO segments(meeting_id,start_ms,end_ms) VALUES(?,?,?)",
          arrayOf<Any?>(meetingId, segments[i], segments[i + 1]),
        )
        i += 2
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  companion object {
    @Volatile private var instance: AudioDb? = null

    private val SCHEMA = arrayOf(
      """CREATE TABLE IF NOT EXISTS meetings(
           id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
           duration_ms INTEGER NOT NULL DEFAULT 0, language TEXT,
           status TEXT NOT NULL DEFAULT 'recording', tier_used TEXT NOT NULL DEFAULT 'free',
           audio_path TEXT, audio_retained INTEGER NOT NULL DEFAULT 1);""",
      """CREATE TABLE IF NOT EXISTS utterances(
           id TEXT PRIMARY KEY,
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
           speaker_id TEXT, text TEXT NOT NULL);""",
      """CREATE TABLE IF NOT EXISTS speakers(
           id TEXT PRIMARY KEY,
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           cluster_label TEXT NOT NULL, display_name TEXT NOT NULL);""",
      """CREATE TABLE IF NOT EXISTS minutes(
           id TEXT PRIMARY KEY,
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           kind TEXT NOT NULL, content_json TEXT NOT NULL, source TEXT NOT NULL);""",
      """CREATE TABLE IF NOT EXISTS segments(
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL);""",
      """CREATE TABLE IF NOT EXISTS models(
           id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, version TEXT,
           path TEXT, sha256 TEXT, size_bytes INTEGER, installed_at INTEGER);""",
      "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);",
      "CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(meeting_id UNINDEXED, text);",
    )

    fun get(context: Context): AudioDb =
      instance ?: synchronized(this) {
        instance ?: open(context.applicationContext).also { instance = it }
      }

    private fun open(context: Context): AudioDb {
      System.loadLibrary("sqlcipher")
      val file = File(context.filesDir, "audionotes.db")
      val pass = KeystoreKeyManager.getOrCreatePassphrase(context)
      val db = SQLiteDatabase.openOrCreateDatabase(file, pass, null, null)
      db.execSQL("PRAGMA foreign_keys=ON;")
      SCHEMA.forEach { db.execSQL(it) }
      return AudioDb(db)
    }
  }
}
