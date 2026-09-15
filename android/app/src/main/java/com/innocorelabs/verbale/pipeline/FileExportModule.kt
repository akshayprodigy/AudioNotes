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
 *
 * THE SPLIT IN THIS FILE, and why it is where it is. Everything that READS lives on the instance,
 * because a read needs the React context to reach the database; everything that RENDERS lives in
 * the companion, because rendering a document from data needs no Android at all. That is not a
 * tidying preference: the export renderer is the thing a person forwards to a client, and until
 * this split it was the largest untested surface in the app — it could only be exercised by
 * constructing a React module, which a JVM test cannot do. `forcedMarker` was already down there
 * for exactly this reason and is the only part of this file that ever had a unit test.
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
   * One decision, action or open question as the export renders it, with its correction already
   * applied.
   *
   * [anchorStartMs] is NULLABLE and that is the whole of the type's interest. A row a person
   * typed themselves was never said by anybody, and a meeting whose item migration has not run
   * has only `minutes` rows, which carry no timings at all. Both must render WITHOUT a stamp
   * rather than with `[0:00]`, which is a fabricated claim about a moment: it would send a reader
   * to the top of the meeting to look for something nobody said there. It is the same rule Task
   * 10 applies on screen — an item with no evidence is not a failure to find any; it is an item
   * that never claimed any.
   */
  data class ExportItem(val kind: String, val text: String, val anchorStartMs: Long?)

  /** One turn of the transcript, attributed and with its correction already applied. */
  data class ExportTurn(
    val speaker: String,
    val text: String,
    val startMs: Long,
    val endMs: Long,
  )

  /**
   * Everything the renderers need, read once and rendered four ways.
   *
   * Assembled by `document` from the database and by nothing else. Every correction, every
   * merge and every ordering decision is made on the way IN, so the four renderers below differ
   * only in how they lay the same document out — which is the property that makes "the Markdown
   * and the PDF are the same document" checkable rather than merely intended.
   */
  /** A moment somebody marked while recording, resolved to what was said there (null: nothing). */
  data class ExportHighlight(val atMs: Long, val text: String?)

  data class Content(
    val title: String,
    val createdAt: Long,
    val summary: String?,
    val narrative: String?,
    val items: List<ExportItem>,
    val turns: List<ExportTurn>,
    val highlights: List<ExportHighlight> = emptyList(),
  )

  /**
   * Read a meeting, with the user's own corrections in it, and render it.
   *
   * The single reader for every way a meeting leaves the app — the share sheet, the clipboard,
   * and anything added later. Splitting it would mean two descriptions of the export format, and
   * the one people notice drifting is the one they send to a client.
   *
   * Edits are overlaid HERE rather than being written back over the pipeline's text, because a
   * reprocess owns and rewrites that text and an edit written into it would be lost the next time
   * the rules ran. The consequence is that every reader has to ask for the edit first, and this is
   * the export's asking — [exportItems] and [said] are where it happens.
   *
   * ITEMS COME FROM `items` AND PROSE FROM `minutes`. The two tables split at Task 5: every
   * decision, action and open question is an `items` row carrying the moment it was said, and
   * `minutes` keeps the summary, the narrative and the headline. A row a person TYPED was the one
   * exception until Task 12 and is not one any more: `db.addUserItem` writes it to `items`, and
   * `AudioDb.carryUserMinutesOntoItems` has moved the ones already on disk. What [exportItems]
   * still merges back is a meeting whose migration has not run — see the note there.
   */
  private fun document(meetingId: String, format: String): Document {
    val db = AudioDb.get(ctx)
    val meeting = JSONArray(
      db.rawQueryJson(
        "SELECT title,created_at,duration_ms,transcribe_forced_at,forced_from_language " +
          "FROM meetings WHERE id=?",
        arrayOf(meetingId),
      ),
    ).optJSONObject(0)
    val minutes = JSONArray(
      db.rawQueryJson(
        "SELECT kind,content_json AS content,source FROM minutes WHERE meeting_id=? ORDER BY rowid",
        arrayOf(meetingId),
      ),
    )
    // The same order `AudioDb.items` promises and `indexItems` writes: the meeting's own order, so
    // a reader scanning the exported document meets the decisions in the order they were taken.
    val items = JSONArray(
      db.rawQueryJson(
        // gen_version comes back because it is what decides whether a row HAS a moment: the
        // column is NOT NULL, a hand-typed row stores AudioDb.Gen.NO_ANCHOR, and exportItems
        // derives "no anchor" from the gen and never from the number.
        "SELECT id,kind,text,anchor_start_ms,gen_version FROM items WHERE meeting_id=? " +
          "ORDER BY anchor_start_ms, rowid",
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
    // Both key shapes at once, deliberately: `item/<items.id>` for a row that has an id, and
    // `minute/<ItemKey.of(content)>` for one that does not — see [exportItems].
    val edits = HashMap<String, String>()
    for (i in 0 until editRows.length()) {
      val o = editRows.getJSONObject(i)
      edits[o.getString("kind") + "/" + o.getString("key")] = o.getString("content")
    }

    val title = meeting?.optString("title", "Meeting") ?: "Meeting"
    val createdAt = meeting?.optLong("created_at", 0L) ?: 0L
    // Null unless somebody overruled the language refusal on this meeting. Read here, with the
    // rest of the row, so every format below gets it for free rather than each remembering to ask.
    val forcedAt =
      meeting?.let { if (it.isNull("transcribe_forced_at")) null else it.optLong("transcribe_forced_at") }
    val marker = forcedMarkerOrNull(forcedAt, meeting?.optString("forced_from_language", "") ?: "")

    // Read once, rendered four ways. Every format below gets the same corrections, the same merge
    // and the same order, because there is only one place any of that is decided.
    val turns = turnsOf(utterances, nameById, edits)
    val content = Content(
      title = title,
      createdAt = createdAt,
      summary = summaryOf(minutes, edits),
      narrative = narrativeOf(minutes, edits),
      items = exportItems(items, minutes, edits),
      turns = turns,
      highlights = highlightsFor(db.marks(meetingId).map { it.atMs }, turns),
    )

    if (format == "pdf") {
      // Blocks, not a string: a PDF is laid out rather than concatenated. The content still comes
      // from the same accessors as every other format, so a correction reaches it for free.
      val blocks = pdfBlocks(content)
      // After the title and date, before any content: a reader who stops at the first paragraph
      // must still have seen it. [PDF_HEADER_BLOCKS] is what "after the title and date" means to
      // an index, and the count is a fact about pdfBlocks rather than about this statement.
      val withMarker = if (marker == null) blocks else buildList {
        addAll(blocks.take(PDF_HEADER_BLOCKS))
        add(PdfExport.Block(marker, 10f, bold = true,
                            color = rgb(0x8A, 0x5A, 0x00), spaceBefore = 14f))
        addAll(blocks.drop(PDF_HEADER_BLOCKS))
      }
      // Last block on the last page, small and grey: a footer, not a stamp.
      val withCredit = withMarker + PdfExport.Block(
        EXPORT_CREDIT, 8f,
        color = rgb(0x8A, 0x8F, 0xA2), spaceBefore = 20f,
      )
      return Document(title, "pdf", "", withCredit)
    }

    val ext = when (format) { "srt" -> "srt"; "txt", "transcript" -> "txt"; else -> "md" }
    val body = when (format) {
      "srt" -> renderSrt(content)
      "txt" -> renderText(content)
      "transcript" -> renderTranscript(content)
      else -> renderMarkdown(content)
    }
    // SRT gets a real cue rather than a comment, because subtitle players drop comments — a
    // warning nobody can see is not a warning.
    val marked = when {
      marker == null -> body
      ext == "srt" -> "0\n00:00:00,000 --> 00:00:04,000\n" + marker + "\n\n" + body
      ext == "md" -> "> " + marker + "\n\n" + body
      else -> marker + "\n\n" + body
    }
    // The credit goes at the end, in the shape each format reads as a footer. SRT is deliberately
    // left alone: a subtitle track is played over video, and a cue that appears at the end of
    // somebody's meeting saying where the file came from is an advert in the middle of their work.
    val credited = when (ext) {
      "srt" -> marked
      "md" -> marked.trimEnd() + "\n\n---\n\n*" + EXPORT_CREDIT + "*\n"
      else -> marked.trimEnd() + "\n\n" + EXPORT_CREDIT + "\n"
    }
    return Document(title, ext, credited)
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

  companion object {
    /**
     * The line at the foot of every exported document.
     *
     * An exported set of minutes is forwarded to people who were in the meeting and people who were
     * not, which makes it the only part of this product that travels on its own. A quiet credit at
     * the bottom is what turns a document somebody wrote into a document that says where it came
     * from — so it stays at the FOOT, after the content, never over it. Nobody forwards a page with
     * a logo stamped across their minutes.
     *
     * It is not a paywall. Free exports carry it and so do paid ones: the point is reach, and the
     * free tier is the half that gets forwarded most.
     */
    const val EXPORT_CREDIT = "Created with Verbale — verbale.innocorelabs.com"

    /**
     * How many blocks [pdfBlocks] emits before any content: the title and the date.
     *
     * Read as an INDEX by `document`, which splices the forced-transcript warning in after them —
     * "heard as Turkish, transcribed as English; if it was not English, the words below are
     * invented". That placement is the whole of the warning's job: a reader who stops at the first
     * paragraph must still have seen it. Get the count wrong and the warning slides below the
     * summary, which is the one placement its own comment forbids, and nothing throws.
     *
     * A named constant rather than a literal `2` in two places, and ExportItemsTest asserts what
     * those first two blocks actually are — because this number is a claim about a function in
     * another file, and deleting the date line there is a change here.
     */
    private const val PDF_HEADER_BLOCKS = 2

    /** The three sections of an exported document that are lists rather than prose, in order. */
    private val SECTIONS =
      listOf("decision" to "Decisions", "action" to "Action items", "question" to "Open questions")

    /** The kinds that live in `items`. `summary`, `narrative` and `headline` are documents. */
    private val ITEM_KINDS = setOf("decision", "action", "question")

    /**
     * mm:ss, or h:mm:ss past the hour.
     *
     * A deliberate mirror of `provenanceLabel` in src/screens/meeting/ItemProvenance.tsx, and
     * mirrors are two chances to drift — so ExportItemsTest pins the same vectors as
     * ItemProvenance.test.tsx, exactly as ItemKeyTest pins `__tests__` vectors for [ItemKey].
     * The one that matters is the hour boundary: 59:59 and 1:00:00 are one millisecond apart and a
     * `%02d` on the leading field is invisible until a meeting runs long.
     *
     * `Locale.US` is not decoration. `String.format` with no locale uses the DEVICE's, and in
     * locales with their own digits (`ar`, `fa`, `ne`) `%d` writes Arabic-Indic numerals — so an
     * exported document's timestamps would render in a script the reader it was forwarded to
     * cannot match against a player's clock. The JavaScript side has no such hazard, which is why
     * this is the half of the mirror that carries the comment.
     */
    fun stamp(ms: Long): String {
      val total = (ms / 1000).coerceAtLeast(0)
      val s = total % 60
      val m = (total / 60) % 60
      val h = total / 3600
      return if (h > 0) String.format(Locale.US, "%d:%02d:%02d", h, m, s)
      else String.format(Locale.US, "%d:%02d", m, s)
    }

    /**
     * The decisions, actions and questions of a meeting, merged from the two tables that hold
     * them, each with the user's correction in place of the pipeline's text.
     *
     * A DELIBERATE MIRROR of `toItemRows` in src/screens/meeting/shared.tsx, down to the guard,
     * because the document a person exports and the screen they exported it from must not disagree
     * about which rows a meeting has. ONE half of that mirror is left, and Task 12 removed the
     * other:
     *
     *  - **A hand-typed row is an `items` row.** `db.addUserItem` writes it there and
     *    `AudioDb.carryUserMinutesOntoItems` has moved the ones already on disk, deleting the
     *    `minutes` row behind each. So a source='user' minute is no longer merged back in: merging
     *    one would print the same sentence twice on a document somebody forwards.
     *  - **A meeting with no RULE items falls back to its `minutes` entirely.** `ensureItems` needs
     *    the native core and MeetingScreen swallows its failure on purpose, so a pre-items meeting
     *    can be on screen — and exported — unmigrated. Items-only would hand somebody an empty
     *    document with a summary at the top still counting seven actions. It heals on the next open.
     *
     * THE EDIT KEY, which is the part that would fail in silence. A row that has an item id is
     * corrected under `item/<id>`, so a correction now survives the item being re-worded by a
     * reprocess — the same property `item_done` gives a tick. A row that has no id keeps the
     * `minute/<hash-of-its-text>` key it has always had, because there is nothing else to key it
     * on. `AudioDb.carryEditsOntoItems` is what moves an existing correction from the second shape
     * to the first, and it runs before anything reads a meeting; the two shapes are read together
     * here because a meeting whose migration has not run still holds the second.
     */
    fun exportItems(
      items: JSONArray,
      minutes: JSONArray,
      edits: Map<String, String>,
    ): List<ExportItem> {
      val out = ArrayList<ExportItem>()
      // Whether the RULES have produced items for this meeting — not whether it has any. See the
      // note above the loop below, which is the half of this function most easily got wrong.
      var hasRuleItems = false
      for (i in 0 until items.length()) {
        val o = items.getJSONObject(i)
        val text = o.getString("text")
        val typed = o.optString("gen_version") == AudioDb.Gen.USER
        if (!typed) hasRuleItems = true
        out.add(
          ExportItem(
            o.getString("kind"),
            edits["item/" + o.getString("id")] ?: text,
            // THE DERIVATION, and it asks the gen rather than the number. A hand-typed row stores
            // AudioDb.Gen.NO_ANCHOR because the column is NOT NULL; printing it would give
            // `[2562047788:00:54]`, and printing a 0 stored there instead would give `[0:00]` —
            // a fabricated claim that sends a reader of a forwarded document to the top of the
            // recording for a sentence nobody spoke. `bullet` omits the stamp for a null.
            if (typed) null else o.getLong("anchor_start_ms"),
          ),
        )
      }

      // A meeting whose migration has not run falls back to its `minutes` entirely, and the
      // question is "have the RULES produced items", not "are there items".
      //
      // `AudioDb.carryUserMinutesOntoItems` runs before the native load, on purpose, so a phone
      // still downloading libonnxruntime.so does not open a meeting with the person's own notes
      // missing. An unmigrated meeting somebody typed a decision into therefore arrives here with
      // EXACTLY ONE item — the typed one — and every rule-extracted row still in `minutes`. Asked
      // as `items.length() == 0`, the fallback switches off at that moment and the exported
      // document loses its whole minutes, under a summary still counting seven actions. Nothing
      // throws. `AudioDb.ensureItems` and `AudioDb.UNMIGRATED` narrow the same question the same
      // way, for the same reason: a row a person typed is not evidence that the rules have run.
      val unmigrated = !hasRuleItems
      if (!unmigrated) return out
      for (i in 0 until minutes.length()) {
        val o = minutes.getJSONObject(i)
        val kind = o.getString("kind")
        if (kind !in ITEM_KINDS) continue
        val content = o.getString("content")
        // A row with no item keeps the `minute/<hash-of-its-text>` key it has always had, which is
        // the only key it can have. A hand-typed row left this population in Task 12 — it is an
        // `items` row now, corrected under `item/<id>` — and an unmigrated meeting's rows have not.
        out.add(ExportItem(kind, edits["minute/" + ItemKey.of(content)] ?: content, null))
      }
      return out
    }

    /** The transcript, attributed and corrected, in the shape the renderers read. */
    fun turnsOf(
      utterances: JSONArray,
      nameById: Map<String, String>,
      edits: Map<String, String>,
    ): List<ExportTurn> {
      val out = ArrayList<ExportTurn>()
      for (i in 0 until utterances.length()) {
        val u = utterances.getJSONObject(i)
        out.add(
          ExportTurn(
            nameById[u.optString("speaker_id")] ?: "Speaker",
            said(u, edits),
            u.getLong("start_ms"),
            u.getLong("end_ms"),
          ),
        )
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
    fun summaryOf(minutes: JSONArray, edits: Map<String, String>): String? {
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
    fun narrativeOf(minutes: JSONArray, edits: Map<String, String>): String? {
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

    /**
     * Opaque ARGB from three channels — the arithmetic `Color.rgb` performs, spelled out.
     *
     * Not a style preference and not an optimisation. `Color.rgb` is a framework METHOD, and the
     * android.jar a JVM unit test compiles against is the "mockable" one, where every framework
     * method throws "not mocked" rather than running. One call to it made the ENTIRE block list
     * untestable off a device — which is how [pdfBlocks] came to be public and in this companion
     * so a JVM test could reach it, with no test reaching it. The PDF is the format people
     * actually forward, so that was the wrong thing to leave unpinned.
     *
     * Value-identical by inspection and by the framework's own source, which is
     * `0xFF000000 | (r << 16) | (g << 8) | b`. `Block.color` defaults to `Color.BLACK`, a
     * compile-time constant FIELD, so it is inlined rather than called — that one is fine, and
     * ExportItemsTest rendering a block list off a device is what proves it.
     */
    private fun rgb(r: Int, g: Int, b: Int): Int =
      (0xFF shl 24) or (r shl 16) or (g shl 8) or b

    private fun dateStr(ms: Long): String =
      SimpleDateFormat("EEE d MMM yyyy, HH:mm", Locale.getDefault()).format(Date(ms))

    /**
     * One item, as a line of a forwarded document.
     *
     * THE STAMP LEADS THE LINE, and both halves of that are deliberate. A reader scanning a
     * document somebody sent them finds the moment without reading the sentence — the column of
     * timestamps down the left is the index. And a correction replaces [ExportItem.text] alone, so
     * however far somebody rewrites the wording, the moment it was said stays exactly where it was:
     * the one part of the line the user does not own is the one part that makes it checkable.
     */
    /** How far ahead a mark may reach for the next words. Mirrors GAP_MS in highlights.ts. */
    const val HIGHLIGHT_GAP_MS = 15_000L

    /**
     * Resolve marks to what was said — the Kotlin twin of `highlightsFor` in
     * src/screens/meeting/highlights.ts, kept identical by ExportItemsTest replaying that file's
     * fixture. Inside a turn takes the turn; a gap takes the next turn if it starts within
     * HIGHLIGHT_GAP_MS; otherwise the time alone.
     */
    fun highlightsFor(marksMs: List<Long>, turns: List<ExportTurn>): List<ExportHighlight> {
      val sorted = turns.sortedBy { it.startMs }
      return marksMs.sorted().map { at ->
        val inside = sorted.firstOrNull { it.startMs <= at && at <= it.endMs }
        val hit = inside ?: sorted.firstOrNull { it.startMs > at && it.startMs - at <= HIGHLIGHT_GAP_MS }
        ExportHighlight(at, hit?.text?.trim())
      }
    }

    private fun highlightLine(h: ExportHighlight): String =
      "[" + stamp(h.atMs) + "] " + (h.text ?: "(nothing said here yet)")

    private fun bullet(item: ExportItem): String =
      if (item.anchorStartMs == null) item.text else "[" + stamp(item.anchorStartMs) + "] " + item.text

    fun renderMarkdown(c: Content): String {
      val sb = StringBuilder()
      sb.append("# ").append(c.title).append("\n\n")
      sb.append("_").append(dateStr(c.createdAt)).append("_\n\n")
      c.summary?.let { sb.append(it).append("\n\n") }
      c.narrative?.let { sb.append("## Minutes\n\n").append(it).append("\n\n") }
      if (c.highlights.isNotEmpty()) {
        sb.append("## Highlights\n\n")
        for (h in c.highlights) sb.append("- ").append(highlightLine(h)).append("\n")
        sb.append("\n")
      }
      for ((kind, heading) in SECTIONS) {
        val items = c.items.filter { it.kind == kind }
        if (items.isNotEmpty()) {
          sb.append("## ").append(heading).append("\n\n")
          for (item in items) sb.append("- ").append(bullet(item)).append("\n")
          sb.append("\n")
        }
      }
      sb.append("## Transcript\n\n")
      for (t in c.turns) {
        sb.append("**").append(t.speaker).append(":** ").append(t.text).append("\n\n")
      }
      return sb.toString()
    }

    fun renderText(c: Content): String {
      val sb = StringBuilder()
      sb.append(c.title).append("\n").append(dateStr(c.createdAt)).append("\n\n")
      c.summary?.let { sb.append(it).append("\n\n") }
      c.narrative?.let { sb.append("MINUTES\n").append(it).append("\n\n") }
      if (c.highlights.isNotEmpty()) {
        sb.append("HIGHLIGHTS\n")
        for (h in c.highlights) sb.append("  - ").append(highlightLine(h)).append("\n")
        sb.append("\n")
      }
      for ((kind, heading) in SECTIONS) {
        val items = c.items.filter { it.kind == kind }
        if (items.isNotEmpty()) {
          sb.append(heading.uppercase(Locale.US)).append("\n")
          for (item in items) sb.append("  - ").append(bullet(item)).append("\n")
          sb.append("\n")
        }
      }
      sb.append("TRANSCRIPT\n")
      for (t in c.turns) sb.append(t.speaker).append(": ").append(t.text).append("\n")
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
    fun renderTranscript(c: Content): String {
      val sb = StringBuilder()
      for (t in c.turns) sb.append(t.speaker).append(": ").append(t.text).append("\n\n")
      return sb.toString().trimEnd()
    }

    fun renderSrt(c: Content): String {
      val sb = StringBuilder()
      c.turns.forEachIndexed { i, t ->
        sb.append(i + 1).append("\n")
        sb.append(srtTime(t.startMs)).append(" --> ").append(srtTime(t.endMs)).append("\n")
        sb.append(t.speaker).append(": ").append(t.text).append("\n\n")
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

    /**
     * The same document as the Markdown, described as blocks for the page.
     *
     * Deliberately the same order and the same sections: somebody who has been mailing the Markdown
     * and switches to PDF should get the document they already know, not a redesign of it.
     */
    fun pdfBlocks(c: Content): List<PdfExport.Block> {
      val grey = rgb(0x6B, 0x70, 0x80)
      val blocks = ArrayList<PdfExport.Block>()
      blocks.add(PdfExport.Block(c.title, 22f, bold = true))
      blocks.add(PdfExport.Block(dateStr(c.createdAt), 10f, color = grey, spaceBefore = 2f))

      c.summary?.let { blocks.add(PdfExport.Block(it, 11f, spaceBefore = 18f)) }
      c.narrative?.let {
        blocks.add(PdfExport.Block("Minutes", 14f, bold = true, spaceBefore = 22f))
        blocks.add(PdfExport.Block(it, 11f, spaceBefore = 8f))
      }

      if (c.highlights.isNotEmpty()) {
        blocks.add(PdfExport.Block("Highlights", 14f, bold = true, spaceBefore = 22f))
        for (h in c.highlights) {
          blocks.add(PdfExport.Block("•  " + highlightLine(h), 11f, spaceBefore = 6f, indent = 8f))
        }
      }
      for ((kind, heading) in SECTIONS) {
        val items = c.items.filter { it.kind == kind }
        if (items.isEmpty()) continue
        blocks.add(PdfExport.Block(heading, 14f, bold = true, spaceBefore = 22f))
        for (item in items) {
          // The bullet is part of the string rather than drawn separately, so a wrapped item
          // indents under its own text instead of under the bullet.
          blocks.add(PdfExport.Block("•  " + bullet(item), 11f, spaceBefore = 6f, indent = 8f))
        }
      }

      if (c.turns.isNotEmpty()) {
        blocks.add(PdfExport.Block("Transcript", 14f, bold = true, spaceBefore = 24f))
        for (t in c.turns) {
          blocks.add(PdfExport.Block(t.speaker, 9f, bold = true, color = grey, spaceBefore = 10f))
          blocks.add(PdfExport.Block(t.text, 11f, spaceBefore = 2f))
        }
      }
      return blocks
    }

    /**
     * The line that travels with a forced transcript wherever it goes.
     *
     * The in-app banner protects the person who forced it; this protects everybody they send it
     * to. A PDF of invented minutes with no warning on it is the failure the refusal was built to
     * prevent, merely relocated to somebody else's inbox.
     */
    @JvmStatic
    fun forcedMarker(heardLanguage: String): String {
      val name = languageDisplayName(heardLanguage)
      return if (name != null) {
        "Forced transcript — heard as $name, transcribed as English. " +
          "If it was not English, the words below are invented."
      } else {
        "Forced transcript — this did not sound like English, and was transcribed as English " +
          "anyway. If it was not English, the words below are invented."
      }
    }

    /** Null when the meeting was never forced. */
    @JvmStatic
    fun forcedMarkerOrNull(transcribeForcedAt: Long?, heardLanguage: String?): String? =
      if (transcribeForcedAt == null) null else forcedMarker(heardLanguage ?: "")

    /** English name of a language code, or null when we cannot name it. */
    private fun languageDisplayName(code: String): String? {
      if (code.isBlank()) return null
      val name = java.util.Locale.forLanguageTag(code).getDisplayLanguage(java.util.Locale.ENGLISH)
      return if (name.isBlank() || name.equals(code, ignoreCase = true)) null else name
    }
  }
}
