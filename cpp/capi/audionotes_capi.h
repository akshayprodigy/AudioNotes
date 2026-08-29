/* C ABI over the Verbale pipeline (pipeline/pipeline.h). This header must stay C-compilable:
 * no C++ types, no exceptions across the boundary. Strings are UTF-8; the result is a JSON
 * document (see an_result_json) so bindings never chase struct layouts across versions.
 */
#ifndef AUDIONOTES_CAPI_H
#define AUDIONOTES_CAPI_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct an_result an_result; /* opaque */

typedef struct an_options {
  const char* pcm_path;       /* headerless PCM16 mono, required */
  const char* asr_model;      /* required */
  const char* vad_model;      /* NULL = fixed 30 s windows */
  const char* diar_seg_model; /* NULL (either) = skip diarization */
  const char* diar_emb_model;
  const char* llm_model;      /* NULL = rule-based minutes only */
  int num_speakers;           /* 0 = auto */
  int sample_rate;            /* 0 = 16000 */
  int asr_threads;            /* 0 = engine default */
  int llm_threads;            /* 0 = 4 */
} an_options;

/* stage: "vad"|"asr"|"diarize"|"minutes". Called from the processing thread. */
typedef void (*an_progress_fn)(const char* stage, int done, int total, void* user);

/* Polled between stages and between ASR chunks; return non-zero to stop the run. Called from the
 * processing thread, so a flag it reads must be safe to write from another one. */
typedef int (*an_cancel_fn)(void* user);

/* Run the full pipeline. progress and cancel may both be NULL. Returns NULL only on allocation
 * failure; check an_result_error for run failures and an_result_cancelled for early stops.
 * Free with an_result_free. */
an_result* an_process(const an_options* opts, an_progress_fn progress, an_cancel_fn cancel,
                      void* user);

/* NULL when the run succeeded, else a message owned by the result. */
const char* an_result_error(const an_result* r);

/* 1 when the run stopped early because the cancel callback asked it to. A cancelled result is
 * neither a success nor an error: it holds only the stages that finished first, and callers
 * must not treat it as a completed meeting. */
int an_result_cancelled(const an_result* r);

/* The full result as JSON, owned by the result (valid until an_result_free):
 * {"audio_ms":N,"timings":{"vad_ms":N,"asr_ms":N,"diar_ms":N,"minutes_ms":N},
 *  "segments":[{"start_ms":N,"end_ms":N}],
 *  "transcript":[{"start_ms":N,"end_ms":N,"speaker":N,"text":"..."}],
 *  "minutes_source":"llm"|"rule"|"","cancelled":true|false,
 *  "minutes":[{"kind":"...","content":"...","source":"..."}]} */
const char* an_result_json(const an_result* r);

void an_result_free(an_result* r);

#ifdef __cplusplus
}
#endif
#endif /* AUDIONOTES_CAPI_H */
