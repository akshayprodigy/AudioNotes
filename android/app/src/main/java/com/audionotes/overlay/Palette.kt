package com.audionotes.overlay

import android.graphics.Color

/**
 * The app's design tokens, transcribed from `src/theme/palette.ts`.
 *
 * The overlay is drawn on a Canvas by native code, so it cannot import the TypeScript palette the
 * rest of the app renders from. Duplication is the price of drawing outside React; keeping the
 * values in one Kotlin object at least means there is a single place to re-sync, and a single
 * place to look when the bubble stops matching the app.
 *
 * The bubble used to be `#171B22` with a `#4F8CFF` ring — leftovers from the dark theme the app
 * had before the redesign, which made the one surface the user sees most look like a different
 * product.
 */
object Palette {
  val card = Color.parseColor("#FFFFFF")
  val cardAlt = Color.parseColor("#F1F3FA")
  val line = Color.parseColor("#E4E7F1")
  val lineStrong = Color.parseColor("#E2E6F0")

  val ink = Color.parseColor("#16192C")
  val inkSoft = Color.parseColor("#6B7185")
  val inkFaint = Color.parseColor("#A2A8BC")

  val primary = Color.parseColor("#4A56D2")
  val primaryEdge = Color.parseColor("#3A45B4")
  val primarySoft = Color.parseColor("#EEF0FF")
  val primarySoftEdge = Color.parseColor("#CDD3F6")
  val onPrimary = Color.parseColor("#FFFFFF")

  val warning = Color.parseColor("#C77700")
  val warningDeep = Color.parseColor("#8A5A00")
  val warningSoft = Color.parseColor("#FFF3DF")
  val warningSoft2 = Color.parseColor("#FFE7C2")
  val warningEdge = Color.parseColor("#F0DDBE")

  val danger = Color.parseColor("#E9575A")
  val dangerEdge = Color.parseColor("#C6474A")
  val dangerSoft = Color.parseColor("#FFEBEC")

  /** The three coral shades the in-app meter cycles through. */
  val wave1 = Color.parseColor("#F0A5A7")
  val wave2 = Color.parseColor("#EC7A7C")
  val wave3 = Color.parseColor("#E9575A")

  val blush = Color.parseColor("#FFC9CE")

  val successDeep = Color.parseColor("#0E8F5F")
  val successSoft = Color.parseColor("#E9FBF1")
}
