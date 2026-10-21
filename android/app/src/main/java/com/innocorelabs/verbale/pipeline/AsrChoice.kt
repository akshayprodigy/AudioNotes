package com.innocorelabs.verbale.pipeline

import android.content.Context
import com.innocorelabs.verbale.billing.LicenceStore
import com.innocorelabs.verbale.data.ModelCatalog

/**
 * Which whisper a meeting is written down with: "small" for a subscriber who has it on the phone,
 * "base" for everyone else.
 *
 * Decided here, natively, and nowhere else. The JS `process(…, { model })` option was always
 * ignored — ProcessingService passed the literal "base" — so Pro was sold the larger transcriber
 * and never given it. Both callers ask this one function: ProcessingService for the engine, and
 * LiveTranscriber for the windows it transcribes while recording. Those windows are cached under
 * the model's file name, so the two must agree or every window misses and nothing says so.
 *
 * Base is the floor and is never refused: a subscriber whose download has not finished, and a
 * lapsed one with the file still on disk, both still get a transcript.
 */
object AsrChoice {
  fun model(entitled: Boolean, smallInstalled: Boolean): String =
    if (entitled && smallInstalled) "small" else "base"

  fun forDevice(ctx: Context): String {
    val small = ModelCatalog.fileFor(ctx, ModelCatalog.asrIdForModel("small"))
    return model(LicenceStore.entitled(ctx), small != null && small.exists())
  }
}
