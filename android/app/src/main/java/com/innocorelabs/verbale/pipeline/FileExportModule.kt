package com.innocorelabs.verbale.pipeline

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import com.facebook.react.bridge.UiThreadUtil
import com.innocorelabs.verbale.data.AudioDb
import com.innocorelabs.verbale.data.ItemKey
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONArray
import org.json.JSONObject
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

  /** One meeting, rendered. `ext` drives both the filename and the share intent's MIME type. */
  private class Document(
    val title: String,
    val ext: String,
    val body: String,
    /** Set only for "pdf", where the document is drawn rather than written as text. */
    val blocks: List<PdfExport.Block>? = null,
  )

  /**
   * Render a meeting to a document, with the user's own corrections in it.
   *
   * The single renderer for every way a meeting leaves the app — the share sheet, the clipboard,
   * and anything added later. Splitting it would mean two descriptions of the export format, and
   * the one people notice drifting is the one they send to a client.
   *
   * Edits are overlaid HERE rather than being written back over the pipeline's text, because
   * action ticks are hashed on that text (see ItemKey) and rewriting it would untick every item
   * the user had worked through. The consequence is that every reader has to ask for the edit
   * first, and this is the export's asking.
   */
  private fun document(meetingId: String, format: String): Document {
    val db = AudioDb.get(ctx)
    val meeting = JSONArray(
      db.rawQueryJson(
        "SELECT title,created_at,duration_ms FROM meetings WHERE id=?", arrayOf(meetingId),
      ),
    ).optJSONObject(0)
    val minutes = JSONArray(
      db.rawQueryJson(
        "SELECT kind,content_json AS content,source FROM minutes WHERE meeting_id=? ORDER BY rowid",
        arrayOf(meetingId),
      ),
    )
    val utterances = JSONArray(
      db.rawQueryJson(
        "SELECT id,start_ms,end_ms,speaker_id,text FROM utterances WHERE meeting_id=? ORDER BY start_ms",
        arrayOf(meetingId),
      ),
    )
    val speakerRows = JSONArray(
      db.rawQueryJson(
        "SELECT id,display_name AS name FROM speakers WHERE meeting_id=?", arrayOf(meetingId),
      ),
    )
    val editRows = JSONArray(
      db.rawQueryJson(
        "SELECT target_kind AS kind,target_key AS key,content FROM edits WHERE meeting_id=?",
        arrayOf(meetingId),
      ),
    )
    val nameById = HashMap<String, String>()
    for (i in 0 until speakerRows.length()) {
      val o = speakerRows.getJSONObject(i)
      nameById[o.getString("id")] = o.getString("name")
    }
    val edits = HashMap<String, String>()
    for (i in 0 until editRows.length()) {
      val o = editRows.getJSONObject(i)
      edits[o.getString("kind") + "/" + o.getString("key")] = o.getString("content")
    }

    val title = meeting?.optString("title", "Meeting") ?: "Meeting"
    val createdAt = meeting?.optLong("created_at", 0L) ?: 0L

    if (format == "pdf") {
      // Blocks, not a string: a PDF is laid out rather than concatenated. The content still comes
      // from the same accessors as every other format, so a correction reaches it for free.
      return Document(title, "pdf", "", pdfBlocks(title, createdAt, minutes, utterances, nameById, edits))
    }

    val ext = when (format) { "srt" -> "srt"; "txt", "transcript" -> "txt"; else -> "md" }
    val body = when (format) {
      "srt" -> renderSrt(utterances, nameById, edits)
      "txt" -> renderText(title, createdAt, minutes, utterances, nameById, edits)
      "transcript" -> renderTranscript(utterances, nameById, edits)
      else -> renderMarkdown(title, createdAt, minutes, utterances, nameById, edits)
    }
    return Document(title, ext, body)
  }

  @ReactMethod
  fun share(meetingId: String, format: String, promise: Promise) {
    Thread {
      try {
        val doc = document(meetingId, format)

        val dir = File(ctx.cacheDir, "exports").apply { mkdirs() }
        val safe = doc.title.replace(Regex("[^A-Za-z0-9-_ ]"), "").trim().ifEmpty { "meeting" }
        val out = File(dir, "$safe.${doc.ext}")
        if (doc.blocks != null) PdfExport.write(doc.blocks, out) else out.writeText(doc.body)

        val uri = FileProvider.getUriForFile(ctx, ctx.packageName + ".fileprovider", out)
        val send = Intent(Intent.ACTION_SEND).apply {
          type = when (doc.ext) {
            "srt" -> "application/x-subrip"
            "pdf" -> "application/pdf"
            else -> "text/plain"
          }
          putExtra(Intent.EXTRA_STREAM, uri)
          putExtra(Intent.EXTRA_SUBJECT, doc.title)
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

  /** The same document, returned rather than shared — see NativeFileExport.ts. */
  @ReactMethod
  fun render(meetingId: String, format: String, promise: Promise) {
    Thread {
      try {
        if (format == "pdf") {
          // A PDF is bytes, not text. Nothing can paste one, so the clipboard has no use for it.
          promise.reject("not_text", "A PDF can be shared but not copied")
          return@Thread
        }
        promise.resolve(document(meetingId, format).body)
      } catch (e: Exception) {
        promise.reject("export_failed", e)
      }
    }.start()
  }

  /**
   * Put text on the clipboard.
   *
   * On the UI thread because ClipboardManager posts to the main looper to show the Android 13+
   * "copied" toast, and because a paste from a background thread is not guaranteed to be visible
   * to the next reader.
   *
   * The label is what Android 13+ shows in its own confirmation chip, so it is the product's name
   * rather than a description of the payload.
   */
  @ReactMethod
  fun copy(text: String, promise: Promise) {
    UiThreadUtil.runOnUiThread {
      try {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        cm.setPrimaryClip(ClipData.newPlainText("Verbale", text))
        promise.resolve(null)
      } catch (e: Exception) {
        promise.reject("copy_failed", e)
      }
    }
  }

  /**
   * The same document as the Markdown, described as blocks for the page.
   *
   * Deliberately the same order and the same sections: somebody who has been mailing the Markdown
   * and switches to PDF should get the document they already know, not a redesign of it.
   */
  private fun pdfBlocks(
    title: String, createdAt: Long, minutes: JSONArray, utterances: JSONArray,
    nameById: Map<String, String>, edits: Map<String, String>,
  ): List<PdfExport.Block> {
    val grey = android.graphics.Color.rgb(0x6B, 0x70, 0x80)
    val blocks = ArrayList<PdfExport.Block>()
    blocks.add(PdfExport.Block(title, 22f, bold = true))
    blocks.add(PdfExport.Block(dateStr(createdAt), 10f, color = grey, spaceBefore = 2f))

    summaryOf(minutes, edits)?.let {
      blocks.add(PdfExport.Block(it, 11f, spaceBefore = 18f))
    }
    narrativeOf(minutes, edits)?.let {
      blocks.add(PdfExport.Block("Minutes", 14f, bold = true, spaceBefore = 22f))
      blocks.add(PdfExport.Block(it, 11f, spaceBefore = 8f))
    }

    for ((kind, heading) in listOf(
      "decision" to "Decisions", "action" to "Action items", "question" to "Open questions",
    )) {
      val items = byKind(minutes, kind, edits)
      if (items.isEmpty()) continue
      blocks.add(PdfExport.Block(heading, 14f, bold = true, spaceBefore = 22f))
      for (item in items) {
        // The bullet is part of the string rather than drawn separately, so a wrapped item
        // indents under its own text instead of under the bullet.
        blocks.add(PdfExport.Block("•  $item", 11f, spaceBefore = 6f, indent = 8f))
      }
    }

    if (utterances.length() > 0) {
      blocks.add(PdfExport.Block("Transcript", 14f, bold = true, spaceBefore = 24f))
      for (i in 0 until utterances.length()) {
        val u = utterances.getJSONObject(i)
        val who = nameById[u.optString("speaker_id")] ?: "Speaker"
        blocks.add(PdfExport.Block(who, 9f, bold = true, color = grey, spaceBefore = 10f))
        blocks.add(PdfExport.Block(said(u, edits), 11f, spaceBefore = 2f))
      }
    }
    return blocks
  }

  private fun dateStr(ms: Long): String =
    SimpleDateFormat("EEE d MMM yyyy, HH:mm", Locale.getDefault()).format(Date(ms))

  /** Minute contents of one kind, each with the user's correction in place of the pipeline's text. */
  private fun byKind(minutes: JSONArray, kind: String, edits: Map<String, String>): List<String> {
    val out = ArrayList<String>()
    for (i in 0 until minutes.length()) {
      val o = minutes.getJSONObject(i)
      if (o.getString("kind") != kind) continue
      val content = o.getString("content")
      out.add(edits["minute/" + ItemKey.of(content)] ?: content)
    }
    return out
  }

  /**
   * The overview at the top of the document, best version first.
   *
   * A hand-written one wins outright — a summary somebody typed is the summary of that meeting,
   * whatever a model did or did not manage. Then the model's prose, then the rule-composed
   * overview, which is the free tier's floor and a whole paragraph in its own right (see
   * composeSummary in cpp/minutes/minutes_extractor.cpp).
   *
   * Order matters because both rows can exist at once: `replaceMinutes` is scoped by source, so a
   * narrated meeting keeps its rule summary alongside the model's. Reading them in rowid order —
   * which is what this used to do — handed a paying subscriber the rule row, because that one was
   * written first.
   */
  private fun summaryOf(minutes: JSONArray, edits: Map<String, String>): String? {
    edits["summary/doc"]?.let { return it }
    var fallback: String? = null
    for (i in 0 until minutes.length()) {
      val o = minutes.getJSONObject(i)
      if (o.getString("kind") != "summary") continue
      val content = o.getString("content")
      if (o.optString("source") == "llm") return content
      if (fallback == null) fallback = content
    }
    return fallback
  }

  /**
   * The written-up minutes — the model's prose, or the user's correction of it.
   *
   * This was missing from the export entirely, which meant the MOM tab's main content — the thing
   * the tab describes as "the document you would send someone" — was the one part of the meeting
   * that could not be sent. The overview above it is two or three sentences; this is the write-up.
   */
  private fun narrativeOf(minutes: JSONArray, edits: Map<String, String>): String? {
    edits["narrative/doc"]?.let { return it }
    for (i in 0 until minutes.length()) {
      val o = minutes.getJSONObject(i)
      if (o.getString("kind") == "narrative" && o.optString("source") == "llm") {
        return o.getString("content")
      }
    }
    return null
  }

  private fun said(u: JSONObject, edits: Map<String, String>): String =
    edits["utterance/" + u.optString("id")] ?: u.getString("text")

  private fun renderMarkdown(
    title: String, createdAt: Long, minutes: JSONArray, utterances: JSONArray,
    nameById: Map<String, String>, edits: Map<String, String>,
  ): String {
    val sb = StringBuilder()
    sb.append("# ").append(title).append("\n\n")
    sb.append("_").append(dateStr(createdAt)).append("_\n\n")
    summaryOf(minutes, edits)?.let { sb.append(it).append("\n\n") }
    narrativeOf(minutes, edits)?.let { sb.append("## Minutes\n\n").append(it).append("\n\n") }
    val sections = listOf("decision" to "Decisions", "action" to "Action items", "question" to "Open questions")
    for ((kind, heading) in sections) {
      val items = byKind(minutes, kind, edits)
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
      sb.append("**").append(who).append(":** ").append(said(u, edits)).append("\n\n")
    }
    return sb.toString()
  }

  private fun renderText(
    title: String, createdAt: Long, minutes: JSONArray, utterances: JSONArray,
    nameById: Map<String, String>, edits: Map<String, String>,
  ): String {
    val sb = StringBuilder()
    sb.append(title).append("\n").append(dateStr(createdAt)).append("\n\n")
    summaryOf(minutes, edits)?.let { sb.append(it).append("\n\n") }
    narrativeOf(minutes, edits)?.let { sb.append("MINUTES\n").append(it).append("\n\n") }
    val sections = listOf("decision" to "DECISIONS", "action" to "ACTION ITEMS", "question" to "OPEN QUESTIONS")
    for ((kind, heading) in sections) {
      val items = byKind(minutes, kind, edits)
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
      sb.append(who).append(": ").append(said(u, edits)).append("\n")
    }
    return sb.toString()
  }

  /**
   * Just what was said, attributed.
   *
   * No heading and no minutes: this is what someone copying from the Script tab is asking for —
   * the record itself, to paste into a mail or a document that already has its own context. Blank
   * lines between turns rather than one line each, because a wall of "Name: sentence" is unusable
   * at meeting length.
   */
  private fun renderTranscript(
    utterances: JSONArray, nameById: Map<String, String>, edits: Map<String, String>,
  ): String {
    val sb = StringBuilder()
    for (i in 0 until utterances.length()) {
      val u = utterances.getJSONObject(i)
      val who = nameById[u.optString("speaker_id")] ?: "Speaker"
      sb.append(who).append(": ").append(said(u, edits)).append("\n\n")
    }
    return sb.toString().trimEnd()
  }

  private fun renderSrt(
    utterances: JSONArray, nameById: Map<String, String>, edits: Map<String, String>,
  ): String {
    val sb = StringBuilder()
    for (i in 0 until utterances.length()) {
      val u = utterances.getJSONObject(i)
      val who = nameById[u.optString("speaker_id")] ?: "Speaker"
      sb.append(i + 1).append("\n")
      sb.append(srtTime(u.getLong("start_ms"))).append(" --> ").append(srtTime(u.getLong("end_ms"))).append("\n")
      sb.append(who).append(": ").append(said(u, edits)).append("\n\n")
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
