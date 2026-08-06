package com.audionotes.overlay

import android.content.Context

/**
 * Design units to pixels, matching `s()` in `src/theme/palette.ts` so the bubble is the same size
 * relative to the screen as everything the app draws in React.
 *
 * The ratio comes from `smallestScreenWidthDp` — the PORTRAIT width — and is computed once.
 * Deriving it from the current width instead would jump to the 1.22 clamp the moment a host app
 * goes landscape, and the puck would visibly resize itself in the middle of a meeting.
 */
class Scale(context: Context) {
  private val density = context.resources.displayMetrics.density
  private val ratio: Float =
    (context.resources.configuration.smallestScreenWidthDp / 374f).coerceIn(0.85f, 1.22f)

  /** Design units -> pixels, snapped to the physical pixel grid so strokes stay crisp. */
  operator fun invoke(v: Float): Float = Math.round(v * ratio * density).toFloat()

  /** Plain dp -> pixels, for platform quantities (touch slop, inset padding) that must not scale. */
  fun dp(v: Float): Float = v * density
}
