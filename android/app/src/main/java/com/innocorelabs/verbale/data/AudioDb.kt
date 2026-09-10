package com.innocorelabs.verbale.data

import android.content.Context
import com.innocorelabs.verbale.pipeline.DraftMinute
import com.innocorelabs.verbale.pipeline.Minutes
import com.innocorelabs.verbale.pipeline.Reconciler
import com.innocorelabs.verbale.pipeline.ResumePlan
import com.innocorelabs.verbale.pipeline.Spk
import com.innocorelabs.verbale.pipeline.Utt
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

  /**
   * Turn what a person typed into an FTS5 MATCH expression.
   *
   * The raw string used to be passed straight to MATCH, which made an apostrophe, a hyphen or a
   * stray quote a syntax error — and searchJson swallowed the exception into an empty array, so a
   * perfectly ordinary query looked like "no results" rather than like a bug. Every token is
   * quoted as a literal instead, which cannot be a syntax error whatever the user types, and the
   * last one gets a prefix `*` so results narrow as they type rather than only on a whole word.
   */
  private fun ftsQuery(term: String): String? {
    val tokens = term.split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }
    if (tokens.isEmpty()) return null
    return tokens.mapIndexed { i, t ->
      val quoted = "\"" + t.replace("\"", "\"\"") + "\""
      if (i == tokens.lastIndex) "$quoted*" else quoted
    }.joinToString(" AND ")
  }

  /**
   * Ranked full-text search across transcripts, minutes, titles and summaries.
   *
   * Errors are NOT swallowed any more. The old catch-all turned every failure — a bad MATCH
   * expression, a missing table after a partial migration — into "[]", which is indistinguishable
   * from an honest empty result and hid exactly the bugs worth seeing. Malformed input is handled
   * by [ftsQuery] instead, and anything left is a real fault that StorageModule reports to JS.
   *
   * `snippet(search_fts, 4, ...)` marks the matched terms inside the returned excerpt; 4 is the
   * index of the `text` column and the UNINDEXED columns occupy 0-3.
   */
  fun searchJson(term: String): String {
    val match = ftsQuery(term) ?: return "[]"
    val sql =
      "SELECT meeting_id AS meetingId, kind AS kind, ref_id AS refId, start_ms AS startMs, " +
        "snippet(search_fts, 4, '\u0002', '\u0003', '…', 14) AS snippet, " +
        "bm25(search_fts, 0.0, 0.0, 0.0, 0.0, 1.0) AS score " +
        "FROM search_fts WHERE search_fts MATCH ? ORDER BY score LIMIT 120"
    return rawQueryJson(sql, arrayOf(match))
  }

  // ---- Full-text index maintenance -------------------------------------------------------
  //
  // Every writer of indexed content calls the matching index* helper. They are scoped by `kind`
  // so a retitle does not rewrite six hundred utterance rows, and they are individually
  // idempotent so calling one twice is a no-op rather than a duplicate hit.

  private fun indexDelete(meetingId: String, kind: String) =
    db.execSQL("DELETE FROM search_fts WHERE meeting_id=? AND kind=?", arrayOf<Any?>(meetingId, kind))

  private fun indexInsert(meetingId: String, kind: String, refId: String?, startMs: Long, text: String) {
    if (text.isBlank()) return
    db.execSQL(
      "INSERT INTO search_fts(meeting_id,kind,ref_id,start_ms,text) VALUES(?,?,?,?,?)",
      arrayOf<Any?>(meetingId, kind, refId, startMs, text),
    )
  }

  /** Re-index the meeting's title. Cheap, and called from every title writer. */
  fun indexTitle(meetingId: String) {
    val t = getTitle(meetingId) ?: return
    indexDelete(meetingId, "title")
    indexInsert(meetingId, "title", null, 0L, t)
  }

  /** Re-index the meeting's minutes — the decisions and actions people actually search for. */
  fun indexMinutes(meetingId: String) {
    indexDelete(meetingId, "minute")
    db.rawQuery(
      "SELECT id, kind, content_json FROM minutes WHERE meeting_id=? AND kind <> 'summary'",
      arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) {
        indexInsert(meetingId, "minute", c.getString(0), 0L, plainText(c.getString(2)))
      }
    }
  }

  /** Re-index the narrated summary/one-liner. */
  fun indexSummary(meetingId: String) {
    indexDelete(meetingId, "summary")
    db.rawQuery(
      "SELECT content_json FROM minutes WHERE meeting_id=? AND kind='summary'",
      arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) indexInsert(meetingId, "summary", null, 0L, plainText(c.getString(0)))
    }
    summaryLine(meetingId)?.let { indexInsert(meetingId, "summary", null, 0L, it) }
  }

  /**
   * Re-index the meeting's items, each at the moment it was said.
   *
   * `start_ms` is the item's anchor, so a search hit on an item opens the meeting where it was
   * said. Minutes rows are indexed at 0 and a hit therefore opens at the beginning; `SearchHit` has
   * always carried a `startMs` field with nothing to put in it.
   */
  fun indexItems(meetingId: String) {
    indexDelete(meetingId, "item")
    db.rawQuery(
      "SELECT id, anchor_start_ms, text FROM items WHERE meeting_id=? ORDER BY anchor_start_ms",
      arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) {
        indexInsert(meetingId, "item", c.getString(0), c.getLong(1), c.getString(2))
      }
    }
  }

  /**
   * Minute content is stored as JSON — sometimes a bare string, sometimes an object or array.
   * Indexing the raw JSON would make every hit match on braces and key names, so it is flattened
   * to the string leaves before it reaches the index.
   */
  private fun plainText(json: String?): String {
    if (json.isNullOrBlank()) return ""
    val out = StringBuilder()
    fun walk(v: Any?) {
      when (v) {
        is JSONObject -> for (k in v.keys()) walk(v.get(k))
        is JSONArray -> for (i in 0 until v.length()) walk(v.get(i))
        is String -> { out.append(v); out.append(' ') }
        null, JSONObject.NULL -> {}
        else -> { out.append(v.toString()); out.append(' ') }
      }
    }
    walk(
      runCatching { JSONObject(json) as Any }
        .recoverCatching { JSONArray(json) as Any }
        .getOrElse { json.trim().trim('"') },
    )
    return out.toString().trim()
  }

  /** Everything except the utterances, which only replaceUtterancesJson can write. */
  private fun indexDerived(meetingId: String) {
    indexTitle(meetingId)
    indexMinutes(meetingId)
    indexSummary(meetingId)
    // Items belong here and not only in replaceItems: reindexMeeting deletes every index row for
    // the meeting first, and it runs on the backlog sweep, after a speaker merge and after every
    // hand edit. Left out, an item's search hits disappear the first time anybody corrects a word.
    indexItems(meetingId)
  }

  /** Rebuild every index row for one meeting, transcript included. */
  fun reindexMeeting(meetingId: String) {
    db.beginTransaction()
    try {
      db.execSQL("DELETE FROM search_fts WHERE meeting_id=?", arrayOf<Any?>(meetingId))
      db.rawQuery(
        "SELECT id, start_ms, text FROM utterances WHERE meeting_id=? ORDER BY start_ms",
        arrayOf(meetingId),
      ).use { c ->
        while (c.moveToNext()) {
          indexInsert(meetingId, "utterance", c.getString(0), c.getLong(1), c.getString(2))
        }
      }
      indexDerived(meetingId)
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  /**
   * Meetings whose content exists but has never been indexed.
   *
   * This is the backfill driver, and it is deliberately derived from the DATA rather than from a
   * "have we migrated yet" flag in `settings`. That table travels inside a backup
   * (BackupManager.TABLES), so a flag would arrive from the donor phone already set and the
   * restored meetings would stay unsearchable forever, with nothing to notice it. Asking the
   * index what it is missing is self-healing: a restore, a partial run, or a killed process all
   * converge on the next sweep.
   */
  fun unindexedMeetings(limit: Int = 25): List<String> {
    val out = ArrayList<String>()
    db.rawQuery(
      "SELECT id FROM meetings m WHERE EXISTS(SELECT 1 FROM utterances u WHERE u.meeting_id=m.id) " +
        "AND NOT EXISTS(SELECT 1 FROM search_fts f WHERE f.meeting_id=m.id) " +
        "ORDER BY created_at DESC LIMIT ?",
      arrayOf(limit.toString()),
    ).use { c -> while (c.moveToNext()) out.add(c.getString(0)) }
    return out
  }

  /**
   * Re-index every meeting that just arrived from an attached backup.
   *
   * Necessary because `search_fts` is a virtual table with no foreign key: the import's
   * `INSERT OR REPLACE` on a meetings row cascades that meeting's utterances and minutes away and
   * re-imports them, but the old index rows survive untouched — leaving search pointed at text
   * that no longer exists while the restored text is unfindable.
   */
  fun reindexImported(alias: String): Int {
    val ids = ArrayList<String>()
    db.rawQuery("SELECT id FROM $alias.meetings", null).use { c ->
      while (c.moveToNext()) ids.add(c.getString(0))
    }
    for (id in ids) runCatching { reindexMeeting(id) }
    return ids.size
  }

  /** How many of [ids] actually landed in the main database. */
  fun countPresent(alias: String): Int {
    db.rawQuery(
      "SELECT count(*) FROM main.meetings WHERE id IN (SELECT id FROM $alias.meetings)",
      null,
    ).use { c -> return if (c.moveToFirst()) c.getInt(0) else 0 }
  }

  /** Column names of one table in an attached (or the main) database. */
  fun columnsOf(alias: String, table: String): List<String> {
    val out = ArrayList<String>()
    db.rawQuery("PRAGMA $alias.table_info($table)", null).use { c ->
      val name = c.getColumnIndex("name")
      while (c.moveToNext()) out.add(c.getString(name))
    }
    return out
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

  /**
   * Record which language a meeting was actually transcribed in.
   *
   * Written after ASR rather than at capture, because the setting is read at transcription time —
   * that is what lets somebody whose meeting came back in the wrong script pin the language and
   * reprocess. The column is therefore a record of what happened, not an instruction.
   */
  fun setLanguage(id: String, language: String) {
    db.execSQL("UPDATE meetings SET language=? WHERE id=?", arrayOf<Any?>(language, id))
  }

  /**
   * Null when this meeting was never forced.
   *
   * Read-only here on purpose. The write lives in src/db/queries.ts, which already updates
   * `meetings` directly through Storage.query the same way clearNarration does — forcing is always
   * a tap in the app, and a second writer in Kotlin would be a second place for one rule to live.
   */
  fun transcribeForcedAt(id: String): Long? {
    db.rawQuery("SELECT transcribe_forced_at FROM meetings WHERE id=?", arrayOf(id)).use { c ->
      if (!c.moveToFirst() || c.isNull(0)) return null
      return c.getLong(0)
    }
  }

  /** Stamp the moment the room was told. Only ever called for Outcome.PLAYED. */
  fun markAnnounced(id: String, atMs: Long) {
    db.execSQL("UPDATE meetings SET announced_at=? WHERE id=?", arrayOf<Any?>(atMs, id))
  }

  /**
   * Record that diarization was skipped, and why, or clear it when a later run succeeds.
   *
   * Cleared on every attempt rather than only on success: a meeting reprocessed on a phone with
   * memory free must not keep telling the user it ran out, and a stale explanation is worse than
   * none because it is specific.
   */
  fun setDiarSkippedReason(id: String, reason: String?) {
    db.execSQL("UPDATE meetings SET diar_skipped_reason=? WHERE id=?", arrayOf<Any?>(reason, id))
  }

  /** Null when this meeting carries no announcement. */
  fun announcedAt(id: String): Long? {
    db.rawQuery("SELECT announced_at FROM meetings WHERE id=?", arrayOf(id)).use { c ->
      if (!c.moveToFirst() || c.isNull(0)) return null
      return c.getLong(0)
    }
  }

  /**
   * Record one egress event from the native side. Never throws.
   *
   * Mirrors src/privacy/ledger.ts `record`. The download loop must not die because the ledger is
   * busy — but a silent drop makes the privacy screen read low, so a failure is counted in the
   * same settings key the TypeScript side uses and surfaced on the screen.
   */
  fun recordNetworkEvent(kind: String, host: String, sent: Long, received: Long, detail: String?) {
    try {
      db.execSQL(
        "INSERT INTO network_events(at, kind, host, sent, received, detail) VALUES(?,?,?,?,?,?)",
        arrayOf<Any?>(System.currentTimeMillis(), kind, host, sent, received, detail),
      )
    } catch (e: Exception) {
      try {
        val current = getSetting("network_ledger_drops")?.toLongOrNull() ?: 0L
        db.execSQL(
          "INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)",
          arrayOf<Any?>("network_ledger_drops", (current + 1).toString()),
        )
      } catch (inner: Exception) {
        // Both paths gone. Losing a download to bookkeeping would be the worse outcome.
      }
    }
  }

  fun setStatus(id: String, status: String) {
    db.execSQL("UPDATE meetings SET status=? WHERE id=?", arrayOf<Any?>(status, id))
  }

  /**
   * Overwrite the meeting title. Mirrors db.setTitle() in src/db/queries.ts. Caller guards WHICH
   * titles may be overwritten (e.g. only auto-generated placeholders, never a user-edited one).
   */
  /**
   * Write a meeting's title and keep the search index in step.
   *
   * [userEdited] stamps `title_edited_at`, which is what the pipeline's auto-retitle checks before
   * overwriting. Pass it only from a real rename; the pipeline's own retitle must not stamp it or
   * it would immediately protect the placeholder it just wrote.
   */
  fun setTitle(id: String, title: String, userEdited: Boolean = false) {
    if (userEdited) {
      db.execSQL(
        "UPDATE meetings SET title=?, title_edited_at=? WHERE id=?",
        arrayOf<Any?>(title, System.currentTimeMillis(), id),
      )
    } else {
      db.execSQL("UPDATE meetings SET title=? WHERE id=?", arrayOf<Any?>(title, id))
    }
    indexTitle(id)
  }

  /** True once a person has renamed this meeting by hand — the auto-retitle must then leave it alone. */
  fun titleEdited(id: String): Boolean {
    db.rawQuery("SELECT title_edited_at FROM meetings WHERE id=?", arrayOf(id)).use { c ->
      return c.moveToFirst() && !c.isNull(0)
    }
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
      indexDelete(meetingId, "utterance")
      for (i in 0 until arr.length()) {
        val o = arr.getJSONObject(i)
        val text = o.getString("text").trim()
        if (isNonSpeech(text)) continue
        val uid = UUID.randomUUID().toString()
        val startMs = o.getLong("start_ms")
        db.execSQL(
          "INSERT INTO utterances(id,meeting_id,start_ms,end_ms,speaker_id,text) VALUES(?,?,?,?,NULL,?)",
          arrayOf<Any?>(uid, meetingId, startMs, o.getLong("end_ms"), text),
        )
        // ref_id + start_ms are what let a search hit open the meeting at the moment it was said.
        indexInsert(meetingId, "utterance", uid, startMs, text)
        kept++
      }
      // A re-ASR invalidates every edit pinned to an utterance id: the rows above were just
      // deleted and re-minted with fresh UUIDs, so the old keys point at nothing. Dropping them
      // here is what stops a stale edit reattaching itself to an unrelated turn.
      db.execSQL(
        "DELETE FROM edits WHERE meeting_id=? AND target_kind='utterance'",
        arrayOf<Any?>(meetingId),
      )
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
   * Utterances for a meeting in the shape [com.innocorelabs.verbale.pipeline.Minutes] consumes.
   * Mirrors the `id, startMs, endMs, speakerId, text` projection of db.utterances() in
   * src/db/queries.ts, which has always selected all five.
   *
   * The id and the timings are here rather than in a second query because
   * [com.innocorelabs.verbale.pipeline.Minutes.extractItems] needs to say WHERE each item was
   * said, and a second read of the same rows is a second chance for the two to be a row apart —
   * which produces no error, only items anchored at the wrong moment. `Minutes.extract` ignores
   * them; ORDER BY start_ms already made this the transcript order both extractors assume.
   */
  fun utterances(meetingId: String): List<Utt> {
    val out = ArrayList<Utt>()
    db.rawQuery(
      "SELECT id, start_ms, end_ms, text, speaker_id FROM utterances WHERE meeting_id=? " +
        "ORDER BY start_ms",
      arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) {
        out.add(Utt(c.getString(0), c.getLong(1), c.getLong(2), c.getString(3), c.getString(4)))
      }
    }
    return out
  }

  /**
   * Whether a meeting has any transcript at all.
   *
   * Same shape as the EXISTS in [unindexedMeetings], and for the same reason: the question is
   * "is there anything to work from", and counting rows to answer it reads the whole table for a
   * meeting whose transcript can run to thousands of turns.
   */
  fun hasUtterances(meetingId: String): Boolean {
    db.rawQuery(
      "SELECT EXISTS(SELECT 1 FROM utterances WHERE meeting_id=?)",
      arrayOf(meetingId),
    ).use { c -> return c.moveToFirst() && c.getInt(0) != 0 }
  }

  /**
   * Speakers for a meeting in the shape [com.innocorelabs.verbale.pipeline.Minutes] consumes.
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
    // Outside the transaction on purpose: indexing reads back what was just committed, and the
    // minutes are the half of a meeting people search for most ("what did we decide about X").
    indexMinutes(meetingId)
    if (rows.any { it.kind == "summary" }) indexSummary(meetingId)
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

  // ---------------------------------------------------------------------------------------------
  // The live capture pass's decoded windows. See LiveTranscriber and the live-transcript design
  // doc: this is a CACHE, and the only table that pass is allowed to write.
  // ---------------------------------------------------------------------------------------------

  /** One decoded window. Replaces on conflict: a retried window is not a duplicate. */
  fun putCachedWindow(meetingId: String, startMs: Long, endMs: Long, model: String, segments: String) {
    db.execSQL(
      "INSERT OR REPLACE INTO asr_cache(meeting_id,start_ms,end_ms,model,segments) VALUES(?,?,?,?,?)",
      arrayOf<Any?>(meetingId, startMs, endMs, model, segments),
    )
  }

  /** True when this exact window is already decoded, so the live loop can skip it cheaply. */
  fun hasCachedWindow(meetingId: String, startMs: Long, endMs: Long, model: String): Boolean =
    db.rawQuery(
      "SELECT 1 FROM asr_cache WHERE meeting_id=? AND start_ms=? AND end_ms=? AND model=? LIMIT 1",
      arrayOf(meetingId, startMs.toString(), endMs.toString(), model),
    ).use { it.moveToFirst() }

  /**
   * Every cached window for a meeting, as the parallel arrays nativeTranscribe wants: ranges flat
   * as [start0, end0, ...] and one JSON string per window, in start order and index-aligned.
   */
  fun cachedWindows(meetingId: String, model: String): Pair<LongArray, Array<String>> {
    val ranges = ArrayList<Long>()
    val json = ArrayList<String>()
    db.rawQuery(
      "SELECT start_ms,end_ms,segments FROM asr_cache WHERE meeting_id=? AND model=? ORDER BY start_ms",
      arrayOf(meetingId, model),
    ).use { c ->
      while (c.moveToNext()) {
        ranges.add(c.getLong(0)); ranges.add(c.getLong(1)); json.add(c.getString(2))
      }
    }
    return Pair(ranges.toLongArray(), json.toTypedArray())
  }

  /** Scaffolding, not a record: dropped once the transcript exists. */
  fun clearCachedWindows(meetingId: String) {
    db.execSQL("DELETE FROM asr_cache WHERE meeting_id=?", arrayOf<Any?>(meetingId))
  }

  /** Drops the one-liner, for a meeting whose summary no longer describes it. */
  fun clearSummaryLine(meetingId: String) {
    db.execSQL("UPDATE meetings SET summary_line=NULL WHERE id=?", arrayOf<Any?>(meetingId))
    indexSummary(meetingId)
  }

  fun setSummaryLine(meetingId: String, line: String) {
    db.execSQL("UPDATE meetings SET summary_line=? WHERE id=?", arrayOf<Any?>(line, meetingId))
    indexSummary(meetingId)
  }

  fun summaryLine(meetingId: String): String? {
    db.rawQuery("SELECT summary_line FROM meetings WHERE id=?", arrayOf(meetingId)).use { c ->
      return if (c.moveToFirst()) c.getString(0) else null
    }
  }

  // ---- User edits ------------------------------------------------------------------------

  /** Store (or replace) a user's edit of one piece of pipeline-written text. */
  fun putEdit(meetingId: String, targetKind: String, targetKey: String, content: String) {
    db.execSQL(
      "INSERT OR REPLACE INTO edits(meeting_id,target_kind,target_key,content,edited_at) VALUES(?,?,?,?,?)",
      arrayOf<Any?>(meetingId, targetKind, targetKey, content, System.currentTimeMillis()),
    )
    reindexMeeting(meetingId)
  }

  /** Drop an edit, restoring whatever the pipeline wrote. */
  fun clearEdit(meetingId: String, targetKind: String, targetKey: String) {
    db.execSQL(
      "DELETE FROM edits WHERE meeting_id=? AND target_kind=? AND target_key=?",
      arrayOf<Any?>(meetingId, targetKind, targetKey),
    )
    reindexMeeting(meetingId)
  }

  // ---- Audio retention -------------------------------------------------------------------

  /**
   * Meetings whose audio is older than [days] and can be swept.
   *
   * Only ever returns meetings that HAVE a transcript: the audio is the sole copy of a meeting
   * that failed to transcribe, and a retention window must not be the thing that destroys it.
   * Presence is decided by the caller with File.exists() rather than by `audio_retained`, which is
   * only ever written to 0 and arrives from a restored backup describing another phone's disk.
   */
  fun audioOlderThan(days: Int, excludeId: String?): List<Pair<String, String>> {
    if (days < 0) return emptyList()
    val cutoff = System.currentTimeMillis() - days.toLong() * 24L * 60L * 60L * 1000L
    val out = ArrayList<Pair<String, String>>()
    db.rawQuery(
      "SELECT id, audio_path FROM meetings m WHERE audio_path IS NOT NULL AND created_at < ? " +
        "AND EXISTS(SELECT 1 FROM utterances u WHERE u.meeting_id=m.id)",
      arrayOf(cutoff.toString()),
    ).use { c ->
      while (c.moveToNext()) {
        val id = c.getString(0)
        if (id == excludeId) continue
        out.add(id to c.getString(1))
      }
    }
    return out
  }

  /** Remove a meeting and, by ON DELETE CASCADE, everything derived from it. */
  fun deleteMeeting(id: String) {
    db.beginTransaction()
    try {
      // search_fts is an FTS5 virtual table, so it has no foreign key and never cascades.
      db.execSQL("DELETE FROM search_fts WHERE meeting_id=?", arrayOf<Any?>(id))
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

  /**
   * One stored piece of evidence. Mirrors [com.innocorelabs.verbale.pipeline.Minutes.Source] field
   * for field, except that [utteranceId] is nullable here because the column is: it is a
   * convenience re-resolved on every run, not an identity. The anchor and the character span are
   * what survive a re-ASR.
   */
  data class StoredSource(
    val startMs: Long,
    val endMs: Long,
    val charStart: Int,
    val charEnd: Int,
    val utteranceId: String?,
  )

  /**
   * The `items.review` vocabulary, defined once.
   *
   * Two files decide things with these strings — [items], which decides what counts as a person
   * having engaged with a row, and `Reconciler`, which decides what survives a reprocess — and they
   * compare them as plain text. Two copies would therefore drift in silence: a typo or a fifth
   * state added on one side only fails no build, throws nothing, and shows nobody anything; it
   * just stops protecting an item.
   *
   * It lives here rather than in `Reconciler` because this is the column's own file — the schema
   * below defaults `review` to [SUGGESTED], and [items] is where a state turns into a decision
   * about somebody's work. `Reconciler` already imports [StoredItem] from here, so this adds no
   * dependency that was not already there.
   *
   * [CONFIRMED] has no writer yet: confirming an item is Phase C. It is defined now because
   * [BY_A_PERSON] is meaningless without it, and because the alternative — a bare `'confirmed'`
   * appearing in one query when Phase C lands — is how the second copy gets born.
   */
  object Review {
    /** Extracted by the rules; nobody has said anything about it. The column's default. */
    const val SUGGESTED = "suggested"

    /**
     * The MACHINE is unsure. `Reconciler` writes this itself whenever a match is ambiguous, so it
     * says nothing whatever about a person — see [BY_A_PERSON].
     */
    const val NEEDS_REVIEW = "needs_review"

    /** A person said yes. */
    const val CONFIRMED = "confirmed"

    /** A person said no, and it sticks: see `Reconciler` rule 4. */
    const val REJECTED = "rejected"

    /**
     * The states a PERSON put there. The other two are the machine talking to itself, and counting
     * them as engagement makes the reconciler's own flag enough to keep a row alive forever —
     * measured across five reprocesses, an item nobody ever touched becomes permanent clutter in
     * the one list that has to stay worth reading.
     */
    val BY_A_PERSON = setOf(CONFIRMED, REJECTED)
  }

  /**
   * A row of `items` as it stands on disk, with its evidence and the two facts the reconciler
   * cannot see any other way.
   *
   * [createdAt] and [touched] are carried deliberately, and neither has a default:
   *
   *  - [createdAt] because `Reconciler` has to hand it back for a matched row. Stamping `now` on
   *    every reconciled row would make an item a person confirmed in March show today's date after
   *    any reprocess, and the original is then unrecoverable from anywhere.
   *  - [touched] because whether a person has engaged with an item is recorded in FOUR tables and
   *    not one of them writes back to this row. A review a person set lives in `items.review`; the
   *    tick lives in `item_done`; the tick every shipped build has actually written lives in
   *    `action_done`, keyed on a hash of the item's TEXT; a hand correction lives in `edits`. A
   *    finished item and a rewritten item both still read `review='suggested'`, so "review ==
   *    suggested" does NOT mean "nobody has touched this" — and `Reconciler` rule 4 deletes an
   *    untouched row that stopped being extracted, taking the tick or the person's own words with
   *    it, with no error and nothing on screen to notice.
   *
   * ONE field, and assembled in ONE place — [items], next to the SQL that has to change anyway when
   * a fifth signal appears (a snooze, a reassignment, a comment). Rule 4 asks `!touched` and
   * nothing else. This mistake has been made three times in this sub-project — `review` alone, then
   * `review || done`, then the edit case — and not one of the three failed to compile: two flags a
   * caller has to remember to OR together is the trap, and a caller that forgets one is invisible
   * until somebody's tick is gone. A screen that later needs to tell a tick from an edit adds that
   * field HERE, beside the query; it does not re-derive the predicate at the call site.
   *
   * `edits` carries a foreign key to `meetings` only — none to `items` — and nothing anywhere
   * cleans up orphans, so an edit row outlives an item id that will never be re-minted. The join in
   * [items] is latent for the same reason it is correct: Task 11 is what starts writing
   * `target_kind='item'`, so it returns nothing today, on purpose, and no compile error would say
   * otherwise. Whoever implements that write owns this note.
   */
  data class StoredItem(
    val id: String,
    val kind: String,
    val text: String,
    val review: String,
    val genVersion: String,
    val anchorStartMs: Long,
    val anchorEndMs: Long,
    val sources: List<StoredSource>,
    val createdAt: Long,
    val touched: Boolean,
  )

  /**
   * Every stored item for a meeting, in the order the meeting said them, with its evidence and the
   * one thing no query anywhere else computes: [StoredItem.touched].
   *
   * This is the boundary. Four tables can say a person engaged with an item and three of them are
   * somewhere else entirely, so the predicate is assembled here, once, and every caller — the
   * reconciler above all — is handed the answer rather than the ingredients. See
   * [StoredItem.touched] for what happens when a caller assembles it instead.
   */
  fun items(meetingId: String): List<StoredItem> {
    val sources = HashMap<String, MutableList<StoredSource>>()
    // `ORDER BY item_id, ordinal` is a contract, not a plan detail, and which it is was measured
    // rather than assumed: on a device, DELETING it changes nothing, because the (item_id, ordinal)
    // primary key serves the IN lookup and hands the rows back that way regardless. So no test can
    // fail on its absence — ItemsDbTest pins the order that ARRIVES, which catches a reversal and
    // catches the day a query shape or an index stops agreeing. Keep the clause: evidence read back
    // out of order is the wrong moment shown against a person's item, and rule 4 writes whatever it
    // reads straight back to disk.
    db.rawQuery(
      "SELECT item_id,start_ms,end_ms,char_start,char_end,utterance_id FROM item_sources " +
        "WHERE item_id IN (SELECT id FROM items WHERE meeting_id=?) ORDER BY item_id, ordinal",
      arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) {
        sources.getOrPut(c.getString(0)) { ArrayList() }.add(
          StoredSource(
            c.getLong(1), c.getLong(2), c.getInt(3), c.getInt(4),
            if (c.isNull(5)) null else c.getString(5),
          ),
        )
      }
    }

    // The fourth signal, and the only one that cannot be a join: `action_done`'s key is a hash of
    // the item's TEXT computed in JavaScript, which SQL cannot reproduce — [ItemKey] is the mirror
    // of it, and src/db/queries.ts:413 resolves `done` in its caller for exactly this reason. It
    // has to be consulted because `item_done` has no writer yet: every tick on every phone in the
    // field today is here, and until Task 8's migration has run for a meeting a `touched` that
    // joins `item_done` alone reads a fully worked-through library as untouched.
    //
    // WHEN THIS READ MAY GO, because a shim with no removal condition is a permanent one: delete
    // it — the read, NOT the table, which the schema says to keep for a rolled-back build — once
    // Task 8's migration runs unconditionally at open AND the oldest install still supported has
    // been through it. The table outliving the read is the expected end state, so its existence
    // is not the signal; the migration having run everywhere is.
    //
    // What it does NOT recover, which matters because it is the population this sub-project was
    // started for: it matches only while the item's text still hashes the same. A tick whose text
    // DRIFTED between the shipped minute and the item extracted now is invisible here, because
    // the hash moved with the text. Only Task 8's id-keyed backfill recovers those, and nothing
    // before it does.
    val tickedByText = HashSet<String>()
    db.rawQuery(
      "SELECT item_key FROM action_done WHERE meeting_id=?", arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) tickedByText.add(c.getString(0))
    }

    val out = ArrayList<StoredItem>()
    db.rawQuery(
      "SELECT i.id,i.kind,i.text,i.review,i.gen_version,i.anchor_start_ms,i.anchor_end_ms," +
        // Named, not because SQL needs it but because the two locals below are read positionally
        // and this is where a reader checks the count. APPEND a fifth signal's column; inserting
        // one anywhere above silently re-points both flags one column left, with no compile error.
        "i.created_at,d.item_id IS NOT NULL AS ticked,e.target_key IS NOT NULL AS edited " +
        "FROM items i " +
        // Both joins are on a primary key, so neither can multiply the rows.
        "LEFT JOIN item_done d ON d.meeting_id=i.meeting_id AND d.item_id=i.id " +
        // Latent until Task 11 writes the first target_kind='item' row, and correct as it stands.
        "LEFT JOIN edits e ON e.meeting_id=i.meeting_id AND e.target_kind='item' " +
        "AND e.target_key=i.id " +
        // The order this method's KDoc promises, and the one Reconciler's tie-break is stated in.
        // Same measurement as the evidence query above: idx_items_meeting already returns rows
        // this way, so deleting the clause is invisible to any test — a reversal is not.
        "WHERE i.meeting_id=? ORDER BY i.anchor_start_ms, i.rowid",
      arrayOf(meetingId),
    ).use { c ->
      while (c.moveToNext()) {
        val id = c.getString(0)
        val text = c.getString(2)
        val review = c.getString(3)
        val ticked = c.getInt(8) != 0   // `ticked` in the projection above: a row in item_done
        val edited = c.getInt(9) != 0   // `edited`: a row in edits for this item id
        out.add(
          StoredItem(
            id, c.getString(1), text, review, c.getString(4), c.getLong(5), c.getLong(6),
            sources[id] ?: emptyList(), c.getLong(7),
            // The whole predicate, and the only copy of it. A fifth signal is added HERE.
            touched = review in Review.BY_A_PERSON ||     // a person said yes or no
              ticked ||                                   // ticked, by the item's id
              tickedByText.contains(ItemKey.of(text)) ||  // ticked before Task 8 migrated it
              edited,                                     // rewritten by hand
          ),
        )
      }
    }
    return out
  }

  /**
   * Write a meeting's items, preserving the identity of everything that is still the same item.
   *
   * [Reconciler] decides what "the same item" means and returns the id to reuse; this method only
   * persists the answer. Splitting it that way is what makes the matching testable without a
   * database at all — see ReconcilerTest, which runs the whole matrix on the JVM.
   *
   * Every item row for the meeting is deleted and re-inserted, which is why `item_done`
   * deliberately has no foreign key to `items`: a cascade there would wipe every tick on every
   * reprocess.
   */
  fun replaceItems(meetingId: String, genVersion: String, incoming: List<Minutes.Item>) {
    db.beginTransaction()
    try {
      val plan = Reconciler.reconcile(items(meetingId), incoming)

      // item_sources goes with them, by ON DELETE CASCADE (PRAGMA foreign_keys is ON at open).
      db.execSQL("DELETE FROM items WHERE meeting_id=?", arrayOf<Any?>(meetingId))

      val now = System.currentTimeMillis()
      for (r in plan.rows) {
        // WARNING for whoever writes Phase B. This names 9 of the table's 14 columns, so
        // item_type, status, owner_json, date_said and date_norm are DROPPED on every reprocess.
        // Harmless today only because nothing writes them — they are the Pro classifier's, and it
        // does not exist. The moment it does, this statement has to name them and carry them
        // forward the way created_at and gen_version are carried, and NOTHING WILL FAIL TO
        // COMPILE if it does not: a classified owner simply becomes NULL again after the next
        // reprocess, which is the same silence [StoredItem.touched] exists to end.
        db.execSQL(
          "INSERT INTO items(id,meeting_id,kind,text,review,gen_version," +
            "anchor_start_ms,anchor_end_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          arrayOf<Any?>(
            r.id, meetingId, r.item.kind, r.item.text, r.review,
            // Null means "this content came from this run, stamp it". Non-null means the content
            // was preserved from disk and so is its history: writing the run's version over a
            // person's own item would relabel it `rules@N`, after which rule 1 stops protecting it
            // on the NEXT reprocess. Same for created_at, which is otherwise unrecoverable.
            r.genVersion ?: genVersion,
            r.item.anchorStartMs, r.item.anchorEndMs,
            r.createdAt ?: now,
          ),
        )
        r.item.sources.forEachIndexed { i, s ->
          db.execSQL(
            "INSERT INTO item_sources(item_id,ordinal,start_ms,end_ms,char_start,char_end," +
              "utterance_id) VALUES(?,?,?,?,?,?,?)",
            arrayOf<Any?>(r.id, i, s.startMs, s.endMs, s.charStart, s.charEnd, s.utteranceId),
          )
        }
      }
      // Inside the transaction, where replaceMinutes above deliberately indexes outside it, and
      // the difference is real: that one re-reads rows another statement already committed, this
      // one rebuilds the index FROM the rows this transaction is still writing. Moving it out
      // would let a rollback — or a kill — between the two leave search hits for items that never
      // landed, which is a hit that opens onto nothing. Both land or neither does.
      indexItems(meetingId)

      // Ticks whose item is gone: drop them, or they accumulate forever against nothing. This is
      // also the line that makes a wrongly dropped row destructive rather than merely annoying,
      // which is what rule 4 and [StoredItem.touched] exist to prevent.
      db.execSQL(
        "DELETE FROM item_done WHERE meeting_id=? AND item_id NOT IN " +
          "(SELECT id FROM items WHERE meeting_id=?)",
        arrayOf<Any?>(meetingId, meetingId),
      )
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
  }

  /**
   * Give a meeting recorded before this feature its items, and move its ticks onto them.
   *
   * The rule pass runs over the STORED utterances — pure text, no ASR, no diarization, no audio at
   * all — which is what makes migrating a whole library affordable and what lets a meeting whose
   * recording was deleted still gain its transcript links. It simply cannot play them.
   *
   * Ticks move by computing the SAME hash the old worklist used ([ItemKey]) against the text the
   * rules produce now. That works because `Minutes.extract` and `Minutes.extractItems` are the
   * same rules over the same turns, so the minute a shipped build stored and the item extracted
   * today are the same string — a property of the C++ core rather than a contract anybody wrote
   * down, which is why `BackfillTest` ticks a minute produced by the OLD path rather than a
   * literal. If the two ever diverge, every tick in every existing library is lost, silently.
   *
   * What it CANNOT do, and no later code can either: a tick whose text drifted between the shipped
   * minute and the item extracted now is unreachable, because the key moved with the text. That is
   * the population `item_done` exists to end, and this migration is the last chance to catch a
   * tick rather than a way to recover one already lost.
   *
   * `action_done` is NOT dropped afterwards. A build that has to be rolled back must still find
   * the ticks where it left them, and [items] still reads that table for a meeting this has not
   * run on yet — see the schema comment at `item_done`, which says the same thing. Do not tidy it.
   *
   * @return how many items the rules produced. Zero for a meeting with no transcript, and the
   *   early return that produces it is load-bearing: `replaceItems` handed an empty list deletes
   *   every item the meeting has, and a meeting can legitimately have items and no utterances.
   */
  fun backfillItems(meetingId: String): Int {
    val turns = utterances(meetingId)
    if (turns.isEmpty()) return 0

    val incoming = Minutes.extractItems(turns, speakers(meetingId))

    // The items and the ticks land together or neither does, and that is not tidiness. The guard
    // in [ensureItems] is "does this meeting have items yet", so a process killed between the two
    // writes would leave a meeting that HAS items and therefore never migrates again — with every
    // tick still sitting in `action_done`, unreachable, and nothing anywhere reporting it. The
    // nested transaction inside `replaceItems` joins this one rather than opening a second.
    db.beginTransaction()
    try {
      replaceItems(meetingId, Minutes.RULES_GEN, incoming)

      // done_at comes across with the tick. Stamping `now` instead would tell somebody they
      // finished this morning something they crossed off in March, and the original is then
      // recoverable from nowhere — the same loss `replaceItems` carries `created_at` to avoid.
      val tickedAt = HashMap<String, Long>()
      db.rawQuery(
        "SELECT item_key, done_at FROM action_done WHERE meeting_id=?", arrayOf(meetingId),
      ).use { c -> while (c.moveToNext()) tickedAt[c.getString(0)] = c.getLong(1) }

      if (tickedAt.isNotEmpty()) {
        // Every item, not just the ones this run extracted: `replaceItems` also carries forward
        // rows the reconciler retained, and a tick against one of those is as real as any other.
        for (item in items(meetingId)) {
          val at = tickedAt[ItemKey.of(item.text)] ?: continue
          db.execSQL(
            "INSERT OR REPLACE INTO item_done(meeting_id,item_id,done_at) VALUES(?,?,?)",
            arrayOf<Any?>(meetingId, item.id, at),
          )
        }
      }
      db.setTransactionSuccessful()
    } finally {
      db.endTransaction()
    }
    return incoming.size
  }

  /**
   * Run [backfillItems] for a meeting that has never had it, and for no other.
   *
   * Deliberately not called from [items]: a read is reached from write paths — `replaceItems`
   * calls it to hand the reconciler what is on disk — and a write that can start a migration is a
   * reprocess that silently re-extracts a meeting mid-write.
   *
   * "Has it been migrated" is derived from the DATA rather than from a flag in `settings`, for the
   * reason [unindexedMeetings] spells out: that table travels inside a backup, so a flag would
   * arrive from the donor phone already set and the restored meetings would never migrate. The
   * cost is that a meeting whose transcript genuinely yields no items re-runs the rules on every
   * open — milliseconds of pure text, against a flag that would be wrong on a restore forever.
   *
   * Re-running on a meeting that HAS items would not be free, though, and that is what
   * `items().isEmpty()` is for: `replaceItems` runs the reconciler, which deletes an untouched row
   * the rules no longer produce, so a second pass is a reprocess and not a no-op.
   *
   * [hasUtterances] is a short-circuit and NOT a guard, and the difference was measured rather than
   * assumed: [backfillItems] returns before it writes anything when there is no transcript, so
   * deleting this half changes no outcome and no test can be written that fails on its absence.
   * What it buys is not running [items] — two queries and a hash per row — every time a meeting
   * with no transcript is opened. The protection lives in [backfillItems]' own early return, where
   * it covers every caller rather than this one.
   *
   * NOTHING IN JAVASCRIPT CALLS THIS YET. Task 9 is "the JavaScript side reads items" and the call
   * belongs on the meeting screen's read path, where `StorageModule.ensureItems` is waiting for
   * it. An uncalled migration is the same shape as the trap this plan already hit once —
   * `item_done` had no writer, so Task 6's join saw nothing a real user had done — so it is said
   * here rather than left to be discovered.
   *
   * @return how many items the migration produced; 0 when there was nothing to do.
   */
  fun ensureItems(meetingId: String): Int =
    if (hasUtterances(meetingId) && items(meetingId).isEmpty()) backfillItems(meetingId) else 0

  /**
   * The ids of this meeting's ticked items. Keyed on the item, so a re-worded item stays ticked.
   *
   * No production caller yet: the worklist that reads it is Task 9's. [backfillItems] is what
   * fills the table, and `BackfillTest` is what reads it back.
   */
  fun doneItemIds(meetingId: String): Set<String> {
    val out = HashSet<String>()
    db.rawQuery("SELECT item_id FROM item_done WHERE meeting_id=?", arrayOf(meetingId))
      .use { c -> while (c.moveToNext()) out.add(c.getString(0)) }
    return out
  }

  /**
   * Tick or untick one item, now.
   *
   * `item_done` is keyed on (meeting_id, item_id) and carries no foreign key to `items` on
   * purpose, so this survives every reprocess — see the schema comment there before adding one.
   *
   * Deliberately NOT what [backfillItems] uses: a migrated tick keeps the day it was actually
   * ticked, and this stamps the day it is called. No production caller yet — the tick gesture is
   * Task 9's, and this is the writer waiting for it.
   */
  fun setItemDone(meetingId: String, itemId: String, done: Boolean) {
    if (done) {
      db.execSQL(
        "INSERT OR REPLACE INTO item_done(meeting_id,item_id,done_at) VALUES(?,?,?)",
        arrayOf<Any?>(meetingId, itemId, System.currentTimeMillis()),
      )
    } else {
      db.execSQL(
        "DELETE FROM item_done WHERE meeting_id=? AND item_id=?",
        arrayOf<Any?>(meetingId, itemId),
      )
    }
  }

  companion object {
    @Volatile private var instance: AudioDb? = null

    private val SCHEMA = arrayOf(
      """CREATE TABLE IF NOT EXISTS meetings(
           id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL,
           duration_ms INTEGER NOT NULL DEFAULT 0, language TEXT,
           status TEXT NOT NULL DEFAULT 'recording', tier_used TEXT NOT NULL DEFAULT 'free',
           audio_path TEXT, audio_retained INTEGER NOT NULL DEFAULT 1,
           archived_at INTEGER, summary_line TEXT, title_edited_at INTEGER);""",
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
      // Typed items with their provenance. `minutes` keeps prose only — summary, narrative and
      // headline — and every decision, action and question lives here instead.
      //
      // item_type, status, owner_json, date_said and date_norm are NULL for a free user and stay
      // NULL: they are written by the Pro classifier in Phase B. The column exists now so Phase B
      // is a write, not a migration.
      //
      // id is NOT NULL explicitly: SQLite's TEXT PRIMARY KEY allows NULL unless said so (only
      // INTEGER PRIMARY KEY implies it), and two NULL-id rows would not even collide.
      """CREATE TABLE IF NOT EXISTS items(
           id TEXT PRIMARY KEY NOT NULL,
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           kind TEXT NOT NULL,
           item_type TEXT,
           status TEXT,
           text TEXT NOT NULL,
           owner_json TEXT,
           date_said TEXT,
           date_norm INTEGER,
           review TEXT NOT NULL DEFAULT '${Review.SUGGESTED}',
           gen_version TEXT NOT NULL,
           anchor_start_ms INTEGER NOT NULL,
           anchor_end_ms INTEGER NOT NULL,
           created_at INTEGER NOT NULL);""",
      "CREATE INDEX IF NOT EXISTS idx_items_meeting ON items(meeting_id, anchor_start_ms);",
      // The evidence. start_ms/end_ms/char_start/char_end are the anchor and the identity;
      // utterance_id is a convenience re-resolved on every run, because
      // AudioDb.replaceUtterancesJson mints fresh UUIDs each time and the old ones point at
      // nothing. Do not "normalise" utterance_id into a foreign key: the millisecond/char-offset
      // columns are what survives a re-ASR, a text edit and a speaker merge, and the utterance id
      // does not.
      //
      // char_start/char_end are NOT NULL: both producers (evidence.ts, evidence.h) always emit a
      // span, and a source without one is meaningless. Nullable here would be silently dangerous
      // rather than absent — Kotlin's Cursor.getInt returns 0 for NULL, so a missing span would
      // read back as "starts at the beginning of the turn" and Task 10's provenance UI would
      // highlight the wrong text instead of visibly failing.
      //
      // WARNING for anything that reconstructs item text from these offsets: this is NOT
      // turn.substr(char_start, char_end - char_start) in general, in EITHER language. The item's
      // text can differ from that slice whenever the turn's whitespace needed collapsing to find
      // the sentence (extra spaces, tabs, newlines) — src/pipeline/__tests__/evidence.test.ts:145
      // is the TypeScript counterexample: the slice keeps a double space and a newline the item
      // text does not. The C++ port diverges more often still, because the extractor also folds
      // U+2019 to a plain apostrophe before matching, so the slice differs on every turn with a
      // curly apostrophe too — most meetings. Read the item's own text field; do not reconstruct
      // it by slicing the transcript, in either language.
      """CREATE TABLE IF NOT EXISTS item_sources(
           item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
           ordinal INTEGER NOT NULL,
           start_ms INTEGER NOT NULL,
           end_ms INTEGER NOT NULL,
           char_start INTEGER NOT NULL,
           char_end INTEGER NOT NULL,
           utterance_id TEXT,
           PRIMARY KEY (item_id, ordinal));""",
      // Replaces action_done. Keyed on the item's stable id rather than a hash of its text, so a
      // tick survives a re-recognition that changes one word. Task 8 migrates the old rows;
      // action_done itself stays (do not delete it) so a rolled-back build still finds its ticks.
      //
      // Deliberately NO REFERENCES items(id): Task 6's replaceItems deletes and re-inserts every
      // item row on every reprocess, so an ON DELETE CASCADE here would wipe every tick on every
      // reprocess — the exact failure this table exists to end. Do not "fix" this later.
      """CREATE TABLE IF NOT EXISTS item_done(
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           item_id TEXT NOT NULL,
           done_at INTEGER NOT NULL,
           PRIMARY KEY (meeting_id, item_id));""",
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
      // Windows the live capture pass decoded while the meeting was still being recorded, so the
      // post-hoc ASR stage does not decode them again. Keyed on the EXACT window, because a
      // window whose boundaries differ is a different window and serving it would put one
      // stretch of audio's words on another's timestamps.
      //
      // `segments` is JSON — [{"t0":ms,"t1":ms,"text":"..."}] with CHUNK-RELATIVE timestamps —
      // because whisper returns several timestamped segments per window, not one string.
      //
      // `model` is in the key so changing the weights invalidates every row rather than mixing
      // two models' output into one transcript. Dropped when ASR completes: it is scaffolding,
      // not a record, and a second copy of transcript text is a second thing to honour in
      // retention, in exports and in the privacy summary.
      """CREATE TABLE IF NOT EXISTS asr_cache(
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
           model TEXT NOT NULL, segments TEXT NOT NULL,
           PRIMARY KEY (meeting_id, start_ms, end_ms, model));""",
      // Ticked-off actions, keyed by a hash of the item text rather than the minutes row id.
      // Minutes rows are deleted and re-inserted whenever a meeting is reprocessed, so a row-id
      // key would silently uncheck everything the user had worked through.
      """CREATE TABLE IF NOT EXISTS action_done(
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           item_key TEXT NOT NULL, done_at INTEGER NOT NULL,
           PRIMARY KEY (meeting_id, item_key));""",
      "CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);",
      // Every byte this app sends, and where it went. The privacy screen reads nothing else.
      //
      // Not pruned. A model download writes about nine rows once and everything after it is
      // roughly one row a month, so the whole table stays smaller than a single transcript — and
      // a ledger that forgets is not evidence of anything.
      """CREATE TABLE IF NOT EXISTS network_events(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           at INTEGER NOT NULL,
           kind TEXT NOT NULL,
           host TEXT NOT NULL,
           sent INTEGER NOT NULL DEFAULT 0,
           received INTEGER NOT NULL DEFAULT 0,
           detail TEXT);""",
      // Labels a person puts on a meeting: "client", "1:1", "standup".
      //
      // Tags rather than folders, and many-to-many rather than one parent. A meeting is routinely
      // both a client call and a Tuesday standup, and a hierarchy forces a choice between them —
      // then forces every later meeting into a filing decision made once, badly. Nothing here has
      // to be created before it is used: writing a tag IS creating it, and the last meeting to
      // drop a name is what removes it.
      """CREATE TABLE IF NOT EXISTS tags(
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           name TEXT NOT NULL,
           PRIMARY KEY (meeting_id, name));""",
      // User-authored replacements for pipeline-written text.
      //
      // Deliberately a SIDE table rather than an UPDATE of the row being edited. Ticked actions
      // are keyed on a hash of the stored minute text (see action_done), and rewriting that text
      // in place would silently untick every item the user had worked through — the one guarantee
      // the actions worklist makes. Keeping the original row untouched means the tick key never
      // moves, reprocessing still overwrites what it owns, and an edit can be reverted by
      // deleting one row.
      //
      // target_key is the ORIGINAL content's identity: an utterance id for kind='utterance',
      // otherwise the same normalised-text hash the worklist uses.
      """CREATE TABLE IF NOT EXISTS edits(
           meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
           target_kind TEXT NOT NULL,
           target_key TEXT NOT NULL,
           content TEXT NOT NULL,
           edited_at INTEGER NOT NULL,
           PRIMARY KEY (meeting_id, target_kind, target_key));""",
      // Full-text index over everything a person might search for, not just the transcript.
      //
      // Replaces `meetings_fts`, which indexed utterance text alone — so the decision the user is
      // actually hunting for, which lives in the minutes, and the meeting's own title were both
      // unfindable. `kind`/`ref_id`/`start_ms` ride along UNINDEXED so a hit can say what it is
      // and deep-link to the moment it was said. `text` is column index 4 — snippet()/highlight()
      // take that index, and passing the wrong one returns an UNINDEXED column's contents.
      "CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(" +
        "meeting_id UNINDEXED, kind UNINDEXED, ref_id UNINDEXED, start_ms UNINDEXED, text, " +
        "tokenize='unicode61 remove_diacritics 2');",
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
      // Set the moment a person renames a meeting by hand. The pipeline's auto-retitle is guarded
      // by a string sniff ("Meeting", or a " meeting · " placeholder), which quietly overwrote any
      // real title that happened to match — and that retitle runs on every pass where the meeting
      // is not yet 'done', not only on an explicit reprocess. A stamped column is the only thing
      // that distinguishes "we named this" from "the user named this".
      Triple("meetings", "title_edited_at", "INTEGER"),
      // "Transcribe it anyway": a person overruled the language refusal on this meeting. The
      // timestamp is both the REQUEST (ProcessingEngine reads it to bypass the check) and the
      // RECORD (the banner and every export read it forever). One column, because a transient
      // flag plus a separate marker can disagree — a forced run that crashes would leave a marker
      // with no transcript, or invented text with no marker.
      Triple("meetings", "transcribe_forced_at", "INTEGER"),
      // What was HEARD before the override, captured because the forced run destroys it: the
      // refusal path writes the heard code into `language`, the success path overwrites it with
      // the requested one. Without this the banner cannot say "heard as Turkish" an hour later.
      Triple("meetings", "forced_from_language", "TEXT"),
      // The moment the spoken disclosure finished playing while the microphone was live. Set only
      // on confirmed completion — a meeting where playback was silenced or failed carries no
      // stamp, because the room did not hear it and the recording is not evidence of anything.
      Triple("meetings", "announced_at", "INTEGER"),
      // Why this meeting has no speaker labels, when the reason was the phone rather than the
      // recording. Stored rather than re-derived: the decision was made against the memory free
      // at the time, and asking again a day later would answer a different question. Null is the
      // normal case and covers both "diarization ran" and "there was nothing to separate".
      Triple("meetings", "diar_skipped_reason", "TEXT"),
    )

    /** The schema, for a unit test that must not open an encrypted database. */
    @JvmStatic
    fun schemaForTest(): List<String> = SCHEMA.toList()

    /** The migration list, for a unit test that must not open an encrypted database. */
    @JvmStatic
    fun addedColumnsForTest(): List<Triple<String, String, String>> = ADDED_COLUMNS.toList()

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
