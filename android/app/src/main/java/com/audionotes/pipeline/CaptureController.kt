package com.audionotes.pipeline

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.audionotes.data.AudioDb
import java.io.File
import java.util.UUID

/**
 * Shared capture state + control, used by BOTH the RN module (AudioPipelineModule) and the floating
 * overlay (OverlayService) so recording behaves identically no matter how it was started. Keeps a
 * single source of truth for "are we recording, which meeting, since when".
 */
object CaptureController {
  @Volatile var currentMeetingId: String? = null
    private set
  @Volatile var startedAtMs: Long = 0L
    private set

  /** Live input level 0..1, updated by RecordingService each buffer; read by the UI meter. */
  @Volatile var level: Float = 0f

  val isRecording: Boolean get() = currentMeetingId != null
  fun elapsedMs(): Long = if (isRecording) System.currentTimeMillis() - startedAtMs else 0L

  fun hasMicPermission(context: Context): Boolean =
    ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
      PackageManager.PERMISSION_GRANTED

  /** Create the meeting row, start the foreground capture service. Returns the meetingId, or null. */
  fun start(context: Context, tier: String = "free"): String? {
    if (isRecording) return currentMeetingId
    if (!hasMicPermission(context)) return null

    val meetingId = UUID.randomUUID().toString()
    val createdAt = System.currentTimeMillis()
    val dir = File(context.filesDir, "meetings/$meetingId").apply { mkdirs() }
    val audioPath = File(dir, "audio.pcm").absolutePath

    AudioDb.get(context).insertMeeting(meetingId, "Meeting", createdAt, tier)

    val intent = Intent(context, RecordingService::class.java).apply {
      putExtra(RecordingService.EXTRA_MEETING_ID, meetingId)
      putExtra(RecordingService.EXTRA_AUDIO_PATH, audioPath)
    }
    ContextCompat.startForegroundService(context, intent)

    currentMeetingId = meetingId
    startedAtMs = createdAt
    return meetingId
  }

  /** Stop capture. RecordingService.onDestroy marks the meeting 'captured'. Returns its id. */
  fun stop(context: Context): String? {
    val id = currentMeetingId
    context.stopService(Intent(context, RecordingService::class.java))
    currentMeetingId = null
    startedAtMs = 0L
    return id
  }
}
