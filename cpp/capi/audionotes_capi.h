/* C ABI over the AudioNotes pipeline (pipeline/pipeline.h). This header must stay C-compilable:
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

/* Run the full pipeline. Returns NULL only on allocation failure; check an_result_error for
 * run failures. Free with an_result_free. */
an_result* an_process(const an_options* opts, an_progress_fn progress, void* user);

/* NULL when the run succeeded, else a message owned by the result. */
const char* an_result_error(const an_result* r);

/* The full result as JSON, owned by the result (valid until an_result_free):
 * {"audio_ms":N,"timings":{"vad_ms":N,"asr_ms":N,"diar_ms":N,"minutes_ms":N},
 *  "segments":[{"start_ms":N,"end_ms":N}],
 *  "transcript":[{"start_ms":N,"end_ms":N,"speaker":N,"text":"..."}],
 *  "minutes_source":"llm"|"rule"|"",
 *  "minutes":[{"kind":"...","content":"...","source":"..."}]} */
const char* an_result_json(const an_result* r);

void an_result_free(an_result* r);

#ifdef __cplusplus
}
#endif
#endif /* AUDIONOTES_CAPI_H */
