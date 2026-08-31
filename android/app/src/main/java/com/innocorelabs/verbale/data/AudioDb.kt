package com.innocorelabs.verbale.data

import android.content.Context
import com.innocorelabs.verbale.pipeline.DraftMinute
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
