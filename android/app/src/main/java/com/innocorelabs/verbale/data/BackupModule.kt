package com.innocorelabs.verbale.data

import android.app.Activity
import android.content.Intent
import androidx.core.content.FileProvider
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.BaseActivityEventListener
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

/**
 * Back up and restore, over the Android share sheet and file picker.
 *
 * There is no cloud sync and there is not going to be one: a product whose claim is that nothing
 * leaves the phone cannot quietly keep a copy of every meeting on a server. So moving to a new
 * phone is a file the user carries, and this is the pair of buttons that produces and consumes it.
 *
 * The work is in BackupManager; this is the Android plumbing around it.
 */
class BackupModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName() = "Backup"

  private var pending: Promise? = null
  private var pendingPassphrase: String? = null

  private val onActivityResult: ActivityEventListener = object : BaseActivityEventListener() {
    override fun onActivityResult(a: Activity, req: Int, res: Int, data: Intent?) {
      if (req != PICK_BACKUP) return
      val promise = pending ?: return
      val passphrase = pendingPassphrase
      pending = null
      pendingPassphrase = null

      if (res != Activity.RESULT_OK || data?.data == null || passphrase == null) {
        // A cancelled picker is not a failure. Resolving null lets the UI go quiet rather than
        // showing an error for something the user chose to do.
        promise.resolve(null)
        return
      }

      Thread {
        try {
          // Copied to private storage first: SQLCipher opens a path, and a SAF content:// URI is
          // not one. The copy is deleted as soon as the restore finishes, whichever way it goes.
          val tmp = File(ctx.cacheDir, "restore-${System.currentTimeMillis()}.anbak")
          ctx.contentResolver.openInputStream(data.data!!).use { input ->
            if (input == null) throw BackupManager.BackupError("Could not open that file")
            tmp.outputStream().use { input.copyTo(it) }
          }
          try {
            promise.resolve(BackupManager.import(ctx, tmp, passphrase))
          } finally {
            tmp.delete()
          }
        } catch (e: Exception) {
          promise.reject("restore_failed", e.message ?: "Restore failed", e)
        }
      }.start()
    }
  }

  init {
    ctx.addActivityEventListener(onActivityResult)
  }

  /**
   * Write an encrypted backup and hand it to the share sheet.
   *
   * Shared rather than saved to a path we choose, so the file lands wherever the user actually
   * keeps things — Drive, Files, a messaging app to themselves — instead of somewhere they have
   * to be told how to find.
   */
  @ReactMethod
  fun exportAndShare(passphrase: String, promise: Promise) {
    Thread {
      try {
        val file = BackupManager.export(ctx, passphrase)
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
        val send = Intent(Intent.ACTION_SEND).apply {
          type = "application/octet-stream"
          putExtra(Intent.EXTRA_STREAM, uri)
          putExtra(Intent.EXTRA_SUBJECT, file.name)
          addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        val chooser = Intent.createChooser(send, "Save your backup").apply {
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        ctx.startActivity(chooser)
        promise.resolve(file.name)
      } catch (e: Exception) {
        promise.reject("backup_failed", e.message ?: "Backup failed", e)
      }
    }.start()
  }

  /** Open the system file picker, then restore whatever comes back. Resolves null if cancelled. */
  @ReactMethod
  fun pickAndRestore(passphrase: String, promise: Promise) {
    val activity = ctx.currentActivity
    if (activity == null) {
      promise.reject("no_activity", "The app is not in the foreground")
      return
    }
    if (pending != null) {
      promise.reject("busy", "A restore is already in progress")
      return
    }
    pending = promise
    pendingPassphrase = passphrase
    val pick = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      // Not a registered MIME type, and pickers hide what they do not recognise — so ask for
      // everything and let the restore reject a file that is not a backup.
      type = "*/*"
    }
    try {
      activity.startActivityForResult(pick, PICK_BACKUP)
    } catch (e: Exception) {
      pending = null
      pendingPassphrase = null
      promise.reject("no_picker", "No file picker is available on this device", e)
    }
  }

  companion object {
    private const val PICK_BACKUP = 0x8A17
  }
}
