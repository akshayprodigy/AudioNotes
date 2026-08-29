package com.audionotes.data

import android.content.Context
import com.audionotes.pipeline.DraftMinute
import com.audionotes.pipeline.ResumePlan
import com.audionotes.pipeline.Spk
import com.audionotes.pipeline.Utt
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

  /**
   * Overwrite the meeting title. Mirrors db.setTitle() in src/db/queries.ts. Caller guards WHICH
   * titles may be overwritten (e.g. only auto-generated placeholders, never a user-edited one).
   */
  fun setTitle(id: String, title: String) {
    db.execSQL("UPDATE meetings SET title=? WHERE id=?", arrayOf<Any?>(title, id))
  }

  /**
   * Read a user setting from native. The JS layer owns this table, but the capture services run
   * with no React context — and often with no JS at all, after a process restart — so anything
   * that changes native behaviour has to be readable from here too.
   */
  fun getSetting(key: String): String? {
    return try {
      db.rawQuery("SELECT value FROM settings WHERE key=?", arrayOf(key)).use { c ->
        if (c.moveToFirst()) c.getString(0) else null
      }
    } catch (_: Exception) {
      null
    }
  }

  // ---- Backup support. See BackupManager, which is the only caller. ----

  /**
   * Attach a second SQLCipher database under its own key.
   *
   * The path and passphrase are bound rather than interpolated: a passphrase is user-chosen text
   * and may contain a quote, which string-building would turn into a syntax error at best.
   */
  fun attach(path: String, passphrase: String, alias: String) {
    db.execSQL("ATTACH DATABASE ? AS $alias KEY ?", arrayOf<Any?>(path, passphrase))
  }

  fun detach(alias: String) = db.execSQL("DETACH DATABASE $alias")

  /** SQLCipher's whole-database copy into an attached, differently-keyed database. */
  fun exportInto(alias: String) {
    db.rawQuery("SELECT sqlcipher_export(?)", arrayOf(alias)).use { it.moveToFirst() }
  }

  fun exec(sql: String) = db.execSQL(sql)

  fun count(sql: String): Int =
    db.rawQuery(sql, null).use { if (it.moveToFirst()) it.getInt(0) else 0 }

  /**
   * Write a user setting from native.
   *
   * The JS layer owns most of this table, but the licence lives here too and is read and written
   * by code that runs with no React context — the capture and processing services, and the
   * opportunistic token refresh. See billing/LicenceStore.
   */
  fun putSetting(key: String, value: String) {
    db.execSQL("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)", arrayOf<Any?>(key, value))
  }

  fun getAudioPath(id: String): String? {
    db.rawQuery("SELECT audio_path FROM meetings WHERE id=?", arrayOf(id)).use { c ->
      return if (c.moveToFirst()) c.getString(0) else null
    }
  }

  /**
   * Read the meeting's current title. Needed natively so ProcessingEngine's retitle step can
   * apply the same "only overwrite an app-generated title" guard as
   * PipelineController.retitleFromTranscript does on the JS side.
   */
  fun getTitle(id: String): String? {
    db.rawQuery("SELECT title FROM meetings WHERE id=?", arrayOf(id)).use { c ->
      return if (c.moveToFirst()) c.getString(0) else null
    }
  }

  /**
   * The facts the resume planner needs, in one read: current status and whether each stage's
   * output rows exist. Rows (not status) decide what to skip — see ResumePlan.
   *
   * Callers must resolve a meeting still in 'recording' to 'captured'/'error' (via
   * recoverOrphanedRecordings) BEFORE calling this — ResumePlan assumes it never sees 'recording'.
   */
  fun pipelineState(meetingId: String): ResumePlan.State {
    fun exists(table: String): Boolean =
      db.rawQuery("SELECT 1 FROM $table WHERE meeting_id=? LIMIT 1", arrayOf(meetingId)).use { it.moveToFirst() }
    val status = db.rawQuery("SELECT status FROM meetings WHERE id=? LIMIT 1", arrayOf(meetingId)).use {
      if (it.moveToFirst()) it.getString(0) else "captured"
    }
    // Narration is done when its summary row exists. Keyed on the row for the same reason every
    // other stage is: status advances when a stage STARTS, so a process killed mid-generation
    // leaves status claiming work that was never committed.
    val hasNarrative = db.rawQuery(
      "SELECT 1 FROM minutes WHERE meeting_id=? AND source='llm' AND kind='summary' LIMIT 1",
      arrayOf(meetingId),
    ).use { it.moveToFirst() }
    return ResumePlan.State(
      status = status,
      hasSegments = exists("segments"),
      hasUtterances = exists("utterances"),
      hasSpeakers = exists("speakers"),
      hasNarrative = hasNarrative,
    )
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

  /**
   * Utterances for a meeting in the shape [com.audionotes.pipeline.Minutes] consumes.
   * Mirrors the `text, speakerId` projection of db.utterances() in src/db/queries.ts.
   */
  fun utterances(meetingId: String): List<Utt> {
    val out = ArrayList<Utt>()
    db.rawQuery(
      "SELECT text, speaker_id FROM utterances WHERE meeting_id=? ORDER BY start_ms",
      arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) out.add(Utt(c.getString(0), c.getString(1)))
    }
    return out
  }

  /**
   * Speakers for a meeting in the shape [com.audionotes.pipeline.Minutes] consumes.
   * Mirrors the `id, displayName` projection of db.speakers() in src/db/queries.ts.
   */
  fun speakers(meetingId: String): List<Spk> {
    val out = ArrayList<Spk>()
    db.rawQuery(
      "SELECT id, display_name FROM speakers WHERE meeting_id=?",
      arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) out.add(Spk(c.getString(0), c.getString(1)))
    }
    return out
  }

  /**
   * Replace ONE SOURCE's minutes rows for a meeting, leaving the other source untouched.
   *
   * This used to delete every row for the meeting. The rule extractor is extractive — measured
   * invented=0 across four AMI fixtures, every item quoting something that was said — and the LLM
   * is not, so an LLM pass that found 2 actions silently destroyed the 7 quoted ones. Both tiers
   * coexist now: rules own the list items, the LLM owns the prose. See MinutesSourceTest.
   *
   * Mirrors db.replaceMinutes() in src/db/queries.ts and the DELETE+INSERT idiom used by
   * replaceUtterancesJson/replaceSegments. `content_json` stores the plain string content
   * (aliased `content` on the JS side).
   */
  fun replaceMinutes(meetingId: String, source: String, rows: List<DraftMinute>) {
    db.beginTransaction()
    try {
      db.execSQL("DELETE FROM minutes WHERE meeting_id=? AND source=?",
                 arrayOf<Any?>(meetingId, source))
      for (r in rows) {
        db.execSQL(
          "INSERT INTO minutes(id,meeting_id,kind,content_json,source) VALUES(?,?,?,?,?)",
          arrayOf<Any?>(UUID.randomUUID().toString(), meetingId, r.kind, r.content, r.source),
        )
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  fun minutesBySource(meetingId: String, source: String): List<DraftMinute> {
    val out = ArrayList<DraftMinute>()
    db.rawQuery(
      "SELECT kind, content_json, source FROM minutes WHERE meeting_id=? AND source=? ORDER BY rowid",
      arrayOf(meetingId, source),
    ).use { c ->
      while (c.moveToNext()) out.add(DraftMinute(c.getString(0), c.getString(1), c.getString(2)))
    }
    return out
  }

  /** Digests already generated for this meeting, by chunk index — the narration checkpoint. */
  fun notes(meetingId: String): Map<Int, String> {
    val out = HashMap<Int, String>()
    db.rawQuery(
      "SELECT chunk_index, note FROM llm_notes WHERE meeting_id=? ORDER BY chunk_index",
      arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) out[c.getInt(0)] = c.getString(1)
    }
    return out
  }

  fun putNote(meetingId: String, chunkIndex: Int, note: String) {
    db.execSQL(
      "INSERT OR REPLACE INTO llm_notes(meeting_id,chunk_index,note) VALUES(?,?,?)",
      arrayOf<Any?>(meetingId, chunkIndex, note),
    )
  }

  fun clearNotes(meetingId: String) {
    db.execSQL("DELETE FROM llm_notes WHERE meeting_id=?", arrayOf<Any?>(meetingId))
  }

  fun setSummaryLine(meetingId: String, line: String) {
    db.execSQL("UPDATE meetings SET summary_line=? WHERE id=?", arrayOf<Any?>(line, meetingId))
  }

  fun summaryLine(meetingId: String): String? {
    db.rawQuery("SELECT summary_line FROM meetings WHERE id=?", arrayOf(meetingId)).use { c ->
      return if (c.moveToFirst()) c.getString(0) else null
    }
  }

  /** Remove a meeting and, by ON DELETE CASCADE, everything derived from it. */
  fun deleteMeeting(id: String) {
    db.beginTransaction()
    try {
      // meetings_fts is an FTS5 virtual table, so it has no foreign key and never cascades.
      db.execSQL("DELETE FROM meetings_fts WHERE meeting_id=?", arrayOf<Any?>(id))
      db.execSQL("DELETE FROM meetings WHERE id=?", arrayOf<Any?>(id))
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

  /**
   * Read back persisted VAD segments in the same flat `[start0,end0,start1,end1,...]` shape
   * `NativeBridge.nativeVad` returns (ms), ordered by start_ms — mirrors the JS-side
   * `db.segments()` query in src/db/queries.ts. Lets ASR resume from a prior session's VAD
   * output when the VAD stage itself is skipped (see ResumePlan / ProcessingEngine).
   */
  fun segments(meetingId: String): LongArray {
    val out = ArrayList<Long>()
    db.rawQuery(
      "SELECT start_ms, end_ms FROM segments WHERE meeting_id=? ORDER BY start_ms",
      arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) {
        out.add(c.getLong(0))
        out.add(c.getLong(1))
      }
    }
    return out.toLongArray()
  }

  companion object {
    @Volatile private var instance: AudioDb? = null

    private val SCHEMA = arrayOf(
      """CREATE TABLE IF NOT EXISTS meetings(
           id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
           duration_ms INTEGER NOT NULL DEFAULT 0, language TEXT,
           status TEXT NOT NULL DEFAULT 'recording', tier_used TEXT NOT NULL DEFAULT 'free',
           audio_path TEXT, audio_retained INTEGER NOT NULL DEFAULT 1,
           archived_at INTEGER);""",
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
      // Per-chunk checkpoint for the narration stage. Keyed on (meeting, chunk) so a retried
      // chunk overwrites rather than duplicating, and a process killed at chunk 5 of 9 resumes at
      // 5 instead of regenerating eight minutes of work it already did.
      """CREATE TABLE IF NOT EXISTS llm_notes(
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           chunk_index INTEGER NOT NULL, note TEXT NOT NULL,
           PRIMARY KEY (meeting_id, chunk_index));""",
      // Ticked-off actions, keyed by a hash of the item text rather than the minutes row id.
      // Minutes rows are deleted and re-inserted whenever a meeting is reprocessed, so a row-id
      // key would silently uncheck everything the user had worked through.
      """CREATE TABLE IF NOT EXISTS action_done(
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           item_key TEXT NOT NULL, done_at INTEGER NOT NULL,
           PRIMARY KEY (meeting_id, item_key));""",
      "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);",
      "CREATE VIRTUAL TABLE IF NOT EXISTS meetings_fts USING fts5(meeting_id UNINDEXED, text);",
    )

    fun get(context: Context): AudioDb =
      instance ?: synchronized(this) {
        instance ?: open(context.applicationContext).also { instance = it }
      }

    /**
     * Columns added after a release shipped. `CREATE TABLE IF NOT EXISTS` is a no-op against an
     * existing table, so a new column in SCHEMA reaches fresh installs only — every phone that
     * already has a database keeps the old shape and every query naming the column fails. These
     * run on open and are idempotent by inspection rather than by catching the duplicate-column
     * error, so a genuine failure still surfaces.
     */
    private val ADDED_COLUMNS = arrayOf(
      Triple("meetings", "archived_at", "INTEGER"),
      // The library row's one-line description. On the meeting row, not in minutes, so listing the
      // library needs no join and no second query per row.
      Triple("meetings", "summary_line", "TEXT"),
    )

    private fun addMissingColumns(db: SQLiteDatabase) {
      for ((table, column, decl) in ADDED_COLUMNS) {
        var present = false
        db.rawQuery("PRAGMA table_info($table)", null).use { c ->
          val name = c.getColumnIndex("name")
          while (c.moveToNext()) if (c.getString(name) == column) present = true
        }
        if (!present) db.execSQL("ALTER TABLE $table ADD COLUMN $column $decl")
      }
    }

    private fun open(context: Context): AudioDb {
      System.loadLibrary("sqlcipher")
      val file = File(context.filesDir, "audionotes.db")
      val pass = KeystoreKeyManager.getOrCreatePassphrase(context)
      val db = SQLiteDatabase.openOrCreateDatabase(file, pass, null, null)
      db.execSQL("PRAGMA foreign_keys=ON;")
      SCHEMA.forEach { db.execSQL(it) }
      addMissingColumns(db)
      return AudioDb(db)
    }
  }
}
