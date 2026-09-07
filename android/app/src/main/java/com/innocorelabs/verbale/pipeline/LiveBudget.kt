package com.innocorelabs.verbale.pipeline

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager

/**
 * Whether transcribing during a capture is a good idea right now.
 *
 * The live pass is a cache and nothing else, so every decision here is free to be cautious: a
 * refusal costs speed, and the post-hoc pass produces the same transcript either way. What it
 * must never do is compete with the recording. See [DiarBudget], which asks the same kind of
 * question about diarization and answers it the same way — whole, or not at all.
 */
object LiveBudget {
  /**
   * whisper-base resident during a capture, measured generously.
   *
   * ESTIMATED, not measured. This is the figure to correct once a device run reports what the
   * process actually grows by, and the memory gate is only as good as it is.
   */
  const val WHISPER_RESIDENT_BYTES = 200L * 1024 * 1024

  /** Claim at most half of what is free, so the recorder and the rest of the phone keep theirs. */
  private const val CLAIM_DENOMINATOR = 2L

  /** Below this, stop until the phone is charging or recovers. */
  const val LOW_BATTERY_PERCENT = 20

  fun mayStart(availableBytes: Long): Boolean =
    availableBytes > 0 && WHISPER_RESIDENT_BYTES <= availableBytes / CLAIM_DENOMINATOR

  /**
   * SEVERE, not MODERATE, and the difference was measured rather than reasoned.
   *
   * The first version backed off at MODERATE, which Android defines as "moderate throttling, UX
   * not largely impacted". On a Pixel 7 Pro sitting on a desk at 39.9 C, plugged in and at 100%
   * after half an hour of transcribing, the status reads MODERATE — an entirely ordinary state.
   * The live pass backed off for a whole five-minute recording and cached nothing. People plug in
   * for long meetings, which is exactly when this feature is worth having, so a threshold that
   * trips there is a threshold that switches the feature off for the case it was built for.
   *
   * SEVERE is where Android says the user experience is "largely impacted", and that is the right
   * place for a background optimisation to yield. This work already runs at MIN_PRIORITY on one
   * fewer thread than the pipeline uses.
   *
   * ONE phone, ONE condition. The backoff is logged every run so the next phone can contradict
   * this the way this one contradicted MODERATE.
   *
   * A low battery stops the pass unless the phone is charging, because on a charger the number is
   * going up. Heat stops it either way — charging is part of why it is hot.
   */
  fun shouldBackOff(thermalStatus: Int, batteryPercent: Int, charging: Boolean): Boolean {
    if (thermalStatus >= PowerManager.THERMAL_STATUS_SEVERE) return true
    if (!charging && batteryPercent in 0 until LOW_BATTERY_PERCENT) return true
    return false
  }

  /**
   * One fewer thread than the pipeline would use, so the capture thread always has somewhere to
   * run.
   *
   * A PRECAUTION, not a measurement. If the device run shows capture is untroubled this can go
   * back to the full count — but the failure it guards against is dropped audio, which cannot be
   * recovered from, so it stays until there is evidence.
   */
  fun threadsFor(inferenceThreads: Int): Int = maxOf(1, inferenceThreads - 1)

  fun availableBytes(ctx: Context): Long {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val mi = ActivityManager.MemoryInfo()
    am.getMemoryInfo(mi)
    return mi.availMem - mi.threshold
  }

  fun thermalStatus(ctx: Context): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return PowerManager.THERMAL_STATUS_NONE
    val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    return pm.currentThermalStatus
  }

  fun batteryPercent(ctx: Context): Int {
    val bm = ctx.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    // An unreadable level must not read as flat and stop the pass forever.
    return if (pct in 0..100) pct else 100
  }

  fun isCharging(ctx: Context): Boolean {
    val status = ctx.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
      ?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    return status == BatteryManager.BATTERY_STATUS_CHARGING ||
      status == BatteryManager.BATTERY_STATUS_FULL
  }

  /** Logged every run: these thresholds come from one phone, and this line is how the next one argues. */
  fun describe(availableBytes: Long, thermal: Int, battery: Int, charging: Boolean): String =
    "free=${availableBytes / 1024 / 1024}MB thermal=$thermal battery=$battery% charging=$charging"
}
