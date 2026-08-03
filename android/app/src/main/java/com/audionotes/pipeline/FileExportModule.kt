package com.audionotes.pipeline

import android.content.Intent
import androidx.core.content.FileProvider
import com.audionotes.data.AudioDb
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONArray
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * FileExport — render a meeting to Markdown / plain text / SRT and hand it to the Android share
 * sheet via a FileProvider content URI. See src/native/NativeFileExport.ts.
 */
class FileExportModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "FileExport"

  @ReactMethod
  fun share(meetingId: String, format: String, promise: Promise) {
    Thread {
      try {
        val db = AudioDb.get(ctx)
        val meeting = JSONArray(
          db.rawQueryJson(
            "SELECT title,created_at,duration_ms FROM meetings WHERE id=?", arrayOf(meetingId),
          ),
        ).optJSONObject(0)
        val minutes = JSONArray(
          db.rawQueryJson(
            "SELECT kind,content_json AS content FROM minutes WHERE meeting_id=? ORDER BY rowid",
            arrayOf(meetingId),
          ),
        )
        val utterances = JSONArray(
          db.rawQueryJson(
            "SELECT start_ms,end_ms,speaker_id,text FROM utterances WHERE meeting_id=? ORDER BY start_ms",
            arrayOf(meetingId),
          ),
        )
        val speakerRows = JSONArray(
          db.rawQueryJson(
            "SELECT id,display_name AS name FROM speakers WHERE meeting_id=?", arrayOf(meetingId),
          ),
        )
        val nameById = HashMap<String, String>()
        for (i in 0 until speakerRows.length()) {
          val o = speakerRows.getJSONObject(i)
          nameById[o.getString("id")] = o.getString("name")
        }

        val title = meeting?.optString("title", "Meeting") ?: "Meeting"
        val createdAt = meeting?.optLong("created_at", 0L) ?: 0L

        val ext = when (format) { "srt" -> "srt"; "txt" -> "txt"; else -> "md" }
        val body = when (format) {
          "srt" -> renderSrt(utterances, nameById)
          "txt" -> renderText(title, createdAt, minutes, utterances, nameById)
          else -> renderMarkdown(title, createdAt, minutes, utterances, nameById)
        }

        val dir = File(ctx.cacheDir, "exports").apply { mkdirs() }
        val safe = title.replace(Regex("[^A-Za-z0-9-_ ]"), "").trim().ifEmpty { "meeting" }
        val out = File(dir, "$safe.$ext")
        out.writeText(body)

        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", out)
        val send = Intent(Intent.ACTION_SEND).apply {
          type = if (ext == "srt") "application/x-subrip" else "text/plain"
          putExtra(Intent.EXTRA_STREAM, uri)
          putExtra(Intent.EXTRA_SUBJECT, title)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, "Share minutes")
        val activity = ctx.currentActivity
        if (activity != null) {
          activity.startActivity(chooser)
        } else {
          chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
          ctx.startActivity(chooser)
        }
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("export_failed", e)
      }
    }.start()
  }

  private fun dateStr(ms: Long): String =
    SimpleDateFormat("EEE d MMM yyyy, HH:mm", Locale.getDefault()).format(Date(ms))

  private fun byKind(minutes: JSONArray, kind: String): List<String> {
    val out = ArrayList<String>()
    for (i in 0 until minutes.length()) {
      val o = minutes.getJSONObject(i)
      if (o.getString("kind") == kind) out.add(o.getString("content"))
    }
    return out
  }

  private fun renderMarkdown(
    title: String, createdAt: Long, minutes: JSONArray, utterances: JSONArray,
    nameById: Map<String, String>,
  ): String {
    val sb = StringBuilder()
    sb.append("# ").append(title).append("\n\n")
    sb.append("_").append(dateStr(createdAt)).append("_\n\n")
    byKind(minutes, "summary").firstOrNull()?.let { sb.append(it).append("\n\n") }
    val sections = listOf("decision" to "Decisions", "action" to "Action items", "question" to "Open questions")
    for ((kind, heading) in sections) {
      val items = byKind(minutes, kind)
      if (items.isNotEmpty()) {
        sb.append("## ").append(heading).append("\n\n")
        for (it in items) sb.append("- ").append(it).append("\n")
        sb.append("\n")
      }
    }
    sb.append("## Transcript\n\n")
    for (i in 0 until utterances.length()) {
      val u = utterances.getJSONObject(i)
      val who = nameById[u.optString("speaker_id")] ?: "Speaker"
      sb.append("**").append(who).append(":** ").append(u.getString("text")).append("\n\n")
    }
    return sb.toString()
  }

  private fun renderText(
    title: String, createdAt: Long, minutes: JSONArray, utterances: JSONArray,
    nameById: Map<String, String>,
  ): String {
    val sb = StringBuilder()
    sb.append(title).append("\n").append(dateStr(createdAt)).append("\n\n")
    byKind(minutes, "summary").firstOrNull()?.let { sb.append(it).append("\n\n") }
    val sections = listOf("decision" to "DECISIONS", "action" to "ACTION ITEMS", "question" to "OPEN QUESTIONS")
    for ((kind, heading) in sections) {
      val items = byKind(minutes, kind)
      if (items.isNotEmpty()) {
        sb.append(heading).append("\n")
        for (it in items) sb.append("  - ").append(it).append("\n")
        sb.append("\n")
      }
    }
    sb.append("TRANSCRIPT\n")
    for (i in 0 until utterances.length()) {
      val u = utterances.getJSONObject(i)
      val who = nameById[u.optString("speaker_id")] ?: "Speaker"
      sb.append(who).append(": ").append(u.getString("text")).append("\n")
    }
    return sb.toString()
  }

  private fun renderSrt(utterances: JSONArray, nameById: Map<String, String>): String {
    val sb = StringBuilder()
    for (i in 0 until utterances.length()) {
      val u = utterances.getJSONObject(i)
      val who = nameById[u.optString("speaker_id")] ?: "Speaker"
      sb.append(i + 1).append("\n")
      sb.append(srtTime(u.getLong("start_ms"))).append(" --> ").append(srtTime(u.getLong("end_ms"))).append("\n")
      sb.append(who).append(": ").append(u.getString("text")).append("\n\n")
    }
    return sb.toString()
  }

  private fun srtTime(ms: Long): String {
    val h = ms / 3600000
    val m = (ms % 3600000) / 60000
    val s = (ms % 60000) / 1000
    val milli = ms % 1000
    return String.format(Locale.US, "%02d:%02d:%02d,%03d", h, m, s, milli)
  }
}
