// JNI bridge: com.innocorelabs.verbale.pipeline.NativeBridge -> libaudionotes.
#include <jni.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include <memory>

#ifdef __ANDROID__
#include <android/log.h>
// Which engine actually ran, and how much of it failed. Without this the only evidence of a
// fallback — Hindi silently transcribed by whisper because Qwen was not installed — is a
// disappointing transcript.
#define ASRLOG(...) __android_log_print(ANDROID_LOG_INFO, "AudioNotesJNI", __VA_ARGS__)
#else
#define ASRLOG(...) ((void)0)
#endif

#include "asr/asr_engine.h"
#include "asr/asr_chunker.h"
#include "asr/asr_languages.h"
#include "asr/live_chunker.h"
#include "asr/whisper_asr.h"
#include "util/utf8.h"

#ifdef HAVE_WHISPER
#include "whisper.h"
#endif
#include "diar/diarizer.h"
#include "diar/span_map.h"
#include "llm/embed_engine.h"
#include "llm/llama_engine.h"
#include "minutes/ask.h"
#include "minutes/evidence.h"
#include "minutes/evidence_record.h"
#include "minutes/llm_minutes.h"
#include "minutes/minutes_extractor.h"
#include "vad/silero_vad.h"

namespace {

std::string jstr(JNIEnv* env, jstring s) {
  if (!s) return "";
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string out(c ? c : "");
  if (c) env->ReleaseStringUTFChars(s, c);
  return out;
}

// A Kotlin NativeBridge.StageProgress, callable from the thread that entered JNI. `env` is that
// thread's and stays valid for the whole synchronous call the callback rides inside.
struct JProgress {
  JNIEnv* env = nullptr;
  jobject obj = nullptr;
  jmethodID mid = nullptr;
  bool aborted = false;

  JProgress(JNIEnv* e, jobject o) : env(e), obj(o) {
    if (!obj) return;
    jclass cls = env->GetObjectClass(obj);
    mid = cls ? env->GetMethodID(cls, "onProgress", "(II)Z") : nullptr;
    if (cls) env->DeleteLocalRef(cls);
    if (!mid) { env->ExceptionClear(); obj = nullptr; }
  }
  // Reports, and remembers a request to stop. An exception thrown by the callback counts as one.
  void call(int done, int total) {
    if (!obj) return;
    const jboolean go = env->CallBooleanMethod(obj, mid, static_cast<jint>(done), static_cast<jint>(total));
    if (env->ExceptionCheck()) { env->ExceptionClear(); aborted = true; return; }
    if (!go) aborted = true;
  }
};

void throwRuntime(JNIEnv* env, const char* msg) {
  jclass ex = env->FindClass("java/lang/RuntimeException");
  if (ex) env->ThrowNew(ex, msg);
}

void jsonEscape(const std::string& in, std::string& out) {
  for (char ch : in) {
    switch (ch) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (static_cast<unsigned char>(ch) < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", ch);
          out += buf;
        } else {
          out += ch;
        }
    }
  }
}

// The flat [start0, end0, start1, end1, ...] shape nativeVad and nativeDiarize already use, so
// every span crossing this boundary looks the same on the Kotlin side.
jlongArray segmentsToJava(JNIEnv* env, const std::vector<audionotes::Segment>& segs) {
  const jsize n = static_cast<jsize>(segs.size() * 2);
  jlongArray arr = env->NewLongArray(n);
  if (!arr || n == 0) return arr ? arr : env->NewLongArray(0);
  std::vector<jlong> flat;
  flat.reserve(static_cast<size_t>(n));
  for (const audionotes::Segment& s : segs) {
    flat.push_back(static_cast<jlong>(s.start_ms));
    flat.push_back(static_cast<jlong>(s.end_ms));
  }
  env->SetLongArrayRegion(arr, 0, n, flat.data());
  return arr;
}

std::vector<audionotes::Segment> spansFromJava(JNIEnv* env, jlongArray jSpans) {
  std::vector<audionotes::Segment> spans;
  if (!jSpans) return spans;
  const jsize n = env->GetArrayLength(jSpans);
  if (n < 2) return spans;
  std::vector<jlong> flat(static_cast<size_t>(n));
  env->GetLongArrayRegion(jSpans, 0, n, flat.data());
  for (jsize i = 0; i + 1 < n; i += 2) spans.push_back(audionotes::Segment{flat[i], flat[i + 1]});
  return spans;
}

// Reads exactly what nativeAsrDecodeWindow writes: [{"t0":N,"t1":N,"text":"..."}]. Deliberately
// not a general JSON parser and must not become one — anything it does not recognise yields no
// utterances, which costs a cache miss and never a wrong transcript.
std::vector<audionotes::Utterance> parseWindowJson(const std::string& s) {
  std::vector<audionotes::Utterance> out;
  size_t i = 0;
  while ((i = s.find("{\"t0\":", i)) != std::string::npos) {
    i += 6;
    const int64_t t0 = std::strtoll(s.c_str() + i, nullptr, 10);
    size_t j = s.find("\"t1\":", i);
    if (j == std::string::npos) break;
    j += 5;
    const int64_t t1 = std::strtoll(s.c_str() + j, nullptr, 10);
    size_t k = s.find("\"text\":\"", j);
    if (k == std::string::npos) break;
    k += 8;
    std::string text;
    for (; k < s.size(); ++k) {
      if (s[k] == '\\' && k + 1 < s.size()) {
        const char c = s[++k];
        text += (c == 'n') ? '\n' : (c == 't') ? '\t' : c;
      } else if (s[k] == '"') {
        break;
      } else {
        text += s[k];
      }
    }
    if (!text.empty()) out.push_back(audionotes::Utterance{t0, t1, text});
    i = k;
  }
  return out;
}

}  // namespace

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeVad(
    JNIEnv* env, jobject /*thiz*/, jstring jPcmPath, jstring jModelPath, jint sampleRate) {
  const std::string pcm = jstr(env, jPcmPath);
  const std::string model = jstr(env, jModelPath);

  std::vector<jlong> flat;
  try {
    audionotes::SileroVad vad(model, static_cast<int>(sampleRate));
    auto segments = vad.process(pcm);
    flat.reserve(segments.size() * 2);
    for (const auto& s : segments) {
      flat.push_back(static_cast<jlong>(s.start_ms));
      flat.push_back(static_cast<jlong>(s.end_ms));
    }
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewLongArray(0);
  }

  jlongArray result = env->NewLongArray(static_cast<jsize>(flat.size()));
  if (result && !flat.empty()) {
    env->SetLongArrayRegion(result, 0, static_cast<jsize>(flat.size()), flat.data());
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// Streaming VAD and ASR handles, for transcribing while the recording is still being written.
//
// Handle-based for one reason: nativeTranscribe builds a fresh engine per call, so whisper
// re-reads its weights from disk every time. That is fine once per meeting and impossible once
// per 30-second window. Same shape as nativeLlmLoad/Generate/Free below.
// ---------------------------------------------------------------------------------------------

extern "C" JNIEXPORT jlong JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeVadOpen(
    JNIEnv* env, jobject /*thiz*/, jstring jModelPath, jint sampleRate) {
  try {
    auto* vad = new audionotes::SileroVad(jstr(env, jModelPath), static_cast<int>(sampleRate));
    vad->reset();
    return reinterpret_cast<jlong>(vad);
  } catch (const std::exception& e) {
    // 0, not an exception: the live pass is an optimisation and a phone that cannot open the
    // model must still record and still transcribe afterwards.
    ASRLOG("nativeVadOpen failed: %s", e.what());
    return 0;
  }
}

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeVadFeed(
    JNIEnv* env, jobject /*thiz*/, jlong handle, jstring jPcmPath, jlong fromByte,
    jlong byteCount) {
  auto* vad = reinterpret_cast<audionotes::SileroVad*>(handle);
  if (!vad) return env->NewLongArray(0);
  try {
    return segmentsToJava(env, vad->feed(jstr(env, jPcmPath), fromByte, byteCount));
  } catch (const std::exception& e) {
    ASRLOG("nativeVadFeed failed: %s", e.what());
    return env->NewLongArray(0);
  }
}

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeVadFinish(
    JNIEnv* env, jobject /*thiz*/, jlong handle) {
  auto* vad = reinterpret_cast<audionotes::SileroVad*>(handle);
  if (!vad) return env->NewLongArray(0);
  try {
    return segmentsToJava(env, vad->finish());
  } catch (const std::exception& e) {
    ASRLOG("nativeVadFinish failed: %s", e.what());
    return env->NewLongArray(0);
  }
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeVadPendingSpanStartMs(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  auto* vad = reinterpret_cast<audionotes::SileroVad*>(handle);
  return vad ? static_cast<jlong>(vad->pendingSpanStartMs()) : -1;
}

extern "C" JNIEXPORT void JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeVadClose(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  delete reinterpret_cast<audionotes::SileroVad*>(handle);
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeAsrOpen(
    JNIEnv* env, jobject /*thiz*/, jstring jModelPath, jstring jLanguage, jstring jQwen3Dir) {
  // Through the factory, never by class name: the language picks the engine, and a live pass
  // hard-wired to whisper would be unreachable for every language whisper does not serve — the
  // exact shape of the bug scripts/check-engine-encapsulation.py exists to prevent.
  audionotes::AsrConfig cfg;
  cfg.language = jstr(env, jLanguage);
  cfg.whisper_model = jstr(env, jModelPath);
  cfg.qwen3_model_dir = jstr(env, jQwen3Dir);
  std::unique_ptr<audionotes::AsrEngine> asr = audionotes::makeAsrEngine(cfg);
  if (!asr->ok()) return 0;
  return reinterpret_cast<jlong>(asr.release());
}

// Decode ONE window. Same JSON shape nativeTranscribe returns, but with CHUNK-RELATIVE
// timestamps, because that is what makes the value cacheable: it depends on the window's audio
// and nothing about where the window sits in the meeting.
extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeAsrDecodeWindow(
    JNIEnv* env, jobject /*thiz*/, jlong handle, jstring jPcmPath, jint sampleRate,
    jlong startMs, jlong endMs, jint threads) {
  auto* asr = reinterpret_cast<audionotes::AsrEngine*>(handle);
  if (!asr) return env->NewStringUTF("[]");
  std::vector<audionotes::Utterance> utts;
  try {
    // The failure flag is the pipeline's business, not the live pass's: a window this pass
    // cannot decode is simply one it does not cache, and the post-hoc run decodes it and counts
    // it exactly as it does today.
    utts = asr->decodeWindow(jstr(env, jPcmPath), static_cast<int>(sampleRate), startMs, endMs,
                             static_cast<int>(threads), nullptr);
  } catch (const std::exception& e) {
    ASRLOG("nativeAsrDecodeWindow failed: %s", e.what());
    return env->NewStringUTF("[]");
  }
  std::string json = "[";
  for (size_t i = 0; i < utts.size(); ++i) {
    if (i) json += ",";
    std::string esc;
    jsonEscape(utts[i].text, esc);
    json += "{\"t0\":" + std::to_string(utts[i].start_ms) +
            ",\"t1\":" + std::to_string(utts[i].end_ms) + ",\"text\":\"" + esc + "\"}";
  }
  json += "]";
  return env->NewStringUTF(json.c_str());
}

extern "C" JNIEXPORT void JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeAsrClose(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  delete reinterpret_cast<audionotes::AsrEngine*>(handle);
}

// Which windows can no longer change. Kotlin drives the live loop but must not own the chunking
// rule — it exists once, in asr_chunker.cpp, and the post-hoc pass uses the same one.
extern "C" JNIEXPORT jlongArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLiveChunks(
    JNIEnv* env, jobject /*thiz*/, jlong handle, jlongArray jSpans, jlong pendingSpanStartMs,
    jlong capturedMs) {
  auto* asr = reinterpret_cast<audionotes::AsrEngine*>(handle);
  if (!asr) return env->NewLongArray(0);
  // The engine's OWN budget and packing mode, not whisper's constants: an engine that wants one
  // span per window would otherwise be handed 30-second packed windows it never asks for, and
  // every cached window would miss.
  const std::vector<audionotes::Chunk> chunks =
      audionotes::finalChunks(spansFromJava(env, jSpans), pendingSpanStartMs, capturedMs,
                              asr->maxChunkMs(), asr->chunkMode());
  std::vector<jlong> out;
  out.reserve(chunks.size() * 2);
  for (const audionotes::Chunk& c : chunks) {
    out.push_back(static_cast<jlong>(c.start_ms));
    out.push_back(static_cast<jlong>(c.end_ms));
  }
  jlongArray arr = env->NewLongArray(static_cast<jsize>(out.size()));
  if (arr && !out.empty()) {
    env->SetLongArrayRegion(arr, 0, static_cast<jsize>(out.size()), out.data());
  }
  return arr ? arr : env->NewLongArray(0);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeTranscribe(
    JNIEnv* env, jobject /*thiz*/, jstring jPcmPath, jstring jModelPath, jint sampleRate,
    jlongArray jStarts, jlongArray jEnds, jint threads, jstring jLanguage,
    jstring jQwen3Dir, jboolean jForceLanguage, jlongArray jCachedRanges,
    jobjectArray jCachedJson, jobject jProgress) {
  const std::string pcm = jstr(env, jPcmPath);
  const std::string model = jstr(env, jModelPath);
  // Empty when Qwen3-ASR is not installed, which is the normal case today. The factory then falls
  // back to whisper and records that it did.
  const std::string qwen3_dir = jstr(env, jQwen3Dir);
  // Empty means the caller has no opinion, which resolves to the shipped default, "en".
  std::string language = jstr(env, jLanguage);
  if (language.empty()) language = "en";

  std::vector<audionotes::Segment> segs;
  const jsize n = env->GetArrayLength(jStarts);
  if (n > 0) {
    std::vector<jlong> starts(n), ends(n);
    env->GetLongArrayRegion(jStarts, 0, n, starts.data());
    env->GetLongArrayRegion(jEnds, 0, n, ends.data());
    segs.reserve(n);
    for (jsize i = 0; i < n; ++i) {
      segs.push_back(audionotes::Segment{static_cast<int64_t>(starts[i]),
                                         static_cast<int64_t>(ends[i])});
    }
  }

  std::string json = "[";
  try {
    // Through the factory, not a named class. This is what makes a second engine reachable from
    // the phone at all: the language decides which engine runs, and Hindi selects Qwen3-ASR when
    // its weights are present. Without this line the engine is compiled in and never called.
    audionotes::AsrConfig acfg;
    acfg.language = language;
    acfg.whisper_model = model;
    acfg.qwen3_model_dir = qwen3_dir;
    // Set only by "Transcribe it anyway" on a meeting this build already refused once.
    acfg.skip_language_refusal = (jForceLanguage == JNI_TRUE);
    // Windows the live capture pass already decoded, as parallel arrays: ranges flat as
    // [start0,end0,...] and one JSON string per window. Passed in rather than read here because
    // the cache lives in the app's encrypted database, which native code has no key for — and
    // should not.
    if (jCachedRanges != nullptr && jCachedJson != nullptr) {
      const jsize rn = env->GetArrayLength(jCachedRanges);
      const jsize cn = env->GetArrayLength(jCachedJson);
      if (rn / 2 == cn) {
        std::vector<jlong> ranges(static_cast<size_t>(rn));
        if (rn > 0) env->GetLongArrayRegion(jCachedRanges, 0, rn, ranges.data());
        for (jsize i = 0; i < cn; ++i) {
          auto* js = static_cast<jstring>(env->GetObjectArrayElement(jCachedJson, i));
          audionotes::AsrCachedWindow w;
          w.start_ms = ranges[i * 2];
          w.end_ms = ranges[i * 2 + 1];
          w.utterances = parseWindowJson(jstr(env, js));
          env->DeleteLocalRef(js);
          acfg.chunk_cache.push_back(std::move(w));
        }
      } else {
        ASRLOG("ignoring chunk cache: %d range(s) for %d window(s)", (int)(rn / 2), (int)cn);
      }
    }
    std::unique_ptr<audionotes::AsrEngine> asr = audionotes::makeAsrEngine(acfg);
    if (!asr->ok()) {
      const std::string why = asr->unavailableReason();
      throwRuntime(env, why.empty() ? "ASR model failed to load" : why.c_str());
      return env->NewStringUTF("[]");
    }
    // All six arguments spelled out: defaults on a virtual are resolved by static type, so the
    // interface deliberately declares none.
    // Progress and cancellation are the same Kotlin object: it reports each window and may say
    // stop, which the core honours before the next one. Without it, both are null as before.
    JProgress jp(env, jProgress);
    const audionotes::AsrProgressFn progress = [&jp](int done, int total) { jp.call(done, total); };
    const audionotes::AsrCancelFn cancel = [&jp]() { return jp.aborted; };
    audionotes::AsrRun run = asr->transcribe(pcm, segs, static_cast<int>(sampleRate),
                                             static_cast<int>(threads), progress, cancel);
    if (run.allChunksFailed()) {
      throwRuntime(env, "every ASR chunk failed to decode");
      return env->NewStringUTF("[]");
    }
    ASRLOG("transcribed with %s (%d chunk(s), %d failed, %d from the live pass)",
           run.engine.c_str(), run.chunks_total, run.chunks_failed, run.chunks_cached);
    const auto& utts = run.utterances;
    for (size_t i = 0; i < utts.size(); ++i) {
      if (i) json += ",";
      std::string esc;
      jsonEscape(utts[i].text, esc);
      json += "{\"start_ms\":" + std::to_string(utts[i].start_ms) +
              ",\"end_ms\":" + std::to_string(utts[i].end_ms) +
              ",\"text\":\"" + esc + "\"}";
    }
    json += "]";

    // Wrapped in an object rather than returned as a bare array, because a refused recording has
    // to be TELLABLE from a silent one. Returning [] for "this was Bengali and we will not guess
    // at it" is the same lie as returning [] for "nobody spoke" — and the caller would go on to
    // write minutes over an empty transcript.
    std::string detected;
    jsonEscape(audionotes::sanitizeUtf8(run.detected_language), detected);
    return env->NewStringUTF(
        ("{\"utterances\":" + json +
         ",\"detected_language\":\"" + detected + "\"" +
         ",\"detected_confidence\":" + std::to_string(run.detected_confidence) +
         ",\"unsupported_language\":" + (run.unsupported_language ? "true" : "false") +
         "}").c_str());
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewStringUTF("{\"utterances\":[],\"unsupported_language\":false}");
  }
}

// ---- LLM (llama.cpp) — handle-based so the model loads once and is reused across generate() ----

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeSupportedLanguages(
    JNIEnv* env, jobject /*thiz*/) {
  // Read from the product's OWN table, not from whisper's.
  //
  // This used to enumerate whisper_lang_max_id() — every language the tokenizer knows, ~99 of them
  // — on the reasoning that a hand-maintained shortlist drifts from what the model can do. The
  // reasoning was sound and the conclusion was wrong: the engine's table is what whisper can
  // TOKENIZE, not what this product can deliver. It offered Bengali, somebody recorded an hour of
  // Bengali, and the app returned fluent invented English with a summary that read as correct.
  //
  // A shortlist that drifts means somebody cannot pick their language and knows it. A list that
  // over-promises means somebody picks their language and is handed nonsense they cannot tell
  // from the truth. See asr_languages.cpp for the table and the evidence behind every row.
  std::string json = "[";
  for (const audionotes::Language& lang : audionotes::supportedLanguages()) {
    std::string esc_code, esc_label;
    jsonEscape(audionotes::sanitizeUtf8(lang.code), esc_code);
    jsonEscape(audionotes::sanitizeUtf8(lang.label), esc_label);
    if (json.size() > 1) json += ",";
    json += "{\"code\":\"" + esc_code + "\",\"label\":\"" + esc_label + "\"}";
  }
  json += "]";
  return env->NewStringUTF(json.c_str());
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmLoad(
    JNIEnv* env, jobject /*thiz*/, jstring jModelPath, jint nCtx, jint nThreads, jboolean jGreedy,
    jfloat jRepeatPenalty) {
  const std::string path = jstr(env, jModelPath);
  auto* engine = new audionotes::LlamaEngine();
  if (!engine->load(path, static_cast<int>(nCtx), static_cast<int>(nThreads),
                    jGreedy == JNI_TRUE, static_cast<float>(jRepeatPenalty))) {
    delete engine;
    return 0;
  }
  return reinterpret_cast<jlong>(engine);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmGenerate(
    JNIEnv* env, jobject /*thiz*/, jlong handle, jstring jPrompt, jint maxTokens) {
  auto* engine = reinterpret_cast<audionotes::LlamaEngine*>(handle);
  if (!engine) return env->NewStringUTF("");
  const std::string prompt = jstr(env, jPrompt);
  std::string out;
  try {
    out = engine->generate(prompt, static_cast<int>(maxTokens));
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewStringUTF("");
  }
  return env->NewStringUTF(out.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmGenerateConstrained(
    JNIEnv* env, jobject /*thiz*/, jlong handle, jstring jPrompt, jint maxTokens,
    jstring jGrammar) {
  auto* engine = reinterpret_cast<audionotes::LlamaEngine*>(handle);
  if (!engine) return env->NewStringUTF("");
  const std::string prompt = jstr(env, jPrompt);
  const std::string grammar = jstr(env, jGrammar);
  std::string out;
  try {
    out = engine->generateConstrained(prompt, static_cast<int>(maxTokens), grammar);
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewStringUTF("");
  }
  return env->NewStringUTF(out.c_str());
}


extern "C" JNIEXPORT void JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmFree(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  auto* engine = reinterpret_cast<audionotes::LlamaEngine*>(handle);
  delete engine;
}


extern "C" JNIEXPORT jlongArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeDiarize(
    JNIEnv* env, jobject /*thiz*/, jstring jPcmPath, jstring jSegModel, jstring jEmbModel,
    jint sampleRate, jint numSpeakers, jlongArray jSpans, jlong windowMs, jobject jProgress) {
  const std::string pcm = jstr(env, jPcmPath);
  const std::string seg = jstr(env, jSegModel);
  const std::string emb = jstr(env, jEmbModel);

  // Flat [start_ms, end_ms, ...], the same shape nativeVad returns, so the caller can hand the
  // VAD result straight back without reshaping it. Empty means "diarize the whole recording",
  // which is the old behaviour and is what a caller with no VAD result still gets.
  std::vector<audionotes::Span> spans;
  if (jSpans != nullptr) {
    const jsize n = env->GetArrayLength(jSpans);
    std::vector<jlong> raw(static_cast<size_t>(n));
    if (n > 0) env->GetLongArrayRegion(jSpans, 0, n, raw.data());
    spans.reserve(static_cast<size_t>(n) / 2);
    for (jsize i = 0; i + 1 < n; i += 2) {
      spans.push_back(audionotes::Span{static_cast<int64_t>(raw[i]),
                                       static_cast<int64_t>(raw[i + 1])});
    }
  }

  std::vector<jlong> flat;  // [start_ms, end_ms, speaker, ...]
  try {
    audionotes::Diarizer diar(seg, emb, static_cast<int>(sampleRate), static_cast<int>(numSpeakers));
    JProgress jp(env, jProgress);
    diar.setProgress([&jp](int done, int total) { jp.call(done, total); });
    // The window is the caller's, not ours: only Kotlin can see how much memory this phone has
    // free right now, and that is what decides whether a long meeting is diarized in pieces,
    // diarized in one go, or skipped entirely. See DiarBudget.
    auto segments = diar.process(pcm, spans, static_cast<int64_t>(windowMs));
    flat.reserve(segments.size() * 3);
    for (const auto& s : segments) {
      flat.push_back(static_cast<jlong>(s.start_ms));
      flat.push_back(static_cast<jlong>(s.end_ms));
      flat.push_back(static_cast<jlong>(s.speaker));
    }
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewLongArray(0);
  }

  jlongArray result = env->NewLongArray(static_cast<jsize>(flat.size()));
  if (result && !flat.empty()) {
    env->SetLongArrayRegion(result, 0, static_cast<jsize>(flat.size()), flat.data());
  }
  return result;
}



// ---------------------------------------------------------------------------
// Rule-based minutes, from the shared core.
//
// This replaces MinutesExtractor.kt, which was a hand-maintained third copy of the same rules
// (alongside src/pipeline/minutes.ts and cpp/minutes/minutes_extractor.cpp) with nothing keeping
// it in sync. The C++ side is golden-tested against the real TS, so routing Kotlin here means one
// brain instead of three.
//
// Parallel string arrays rather than JSON, matching how nativeVad/nativeDiarize already exchange
// flat arrays with Kotlin. The first cut marshalled JSON with nlohmann, which cost ~200 KB of
// shipped code to parse two small arrays — the whole of nlohmann's template machinery pulled in
// for a job this does in a loop.
//
// Rule-only by design, and that is now a division of labour rather than a limitation: the rules
// own the list items (extractive, every one quoting the meeting) and Narrator owns the prose. The
// JS enhancement this comment used to point at is gone — narration runs inside ProcessingService,
// which is what makes a meeting stopped from the notification come out readable.
// ---------------------------------------------------------------------------
namespace {

std::vector<std::string> jstrArray(JNIEnv* env, jobjectArray arr) {
  std::vector<std::string> out;
  if (!arr) return out;
  const jsize n = env->GetArrayLength(arr);
  out.reserve(static_cast<size_t>(n));
  for (jsize i = 0; i < n; ++i) {
    auto s = static_cast<jstring>(env->GetObjectArrayElement(arr, i));
    out.push_back(jstr(env, s));
    if (s) env->DeleteLocalRef(s);
  }
  return out;
}

// A jlongArray copied out, so callers never have to remember the Release. JNI_ABORT because
// nothing here writes back.
std::vector<int64_t> jlongVec(JNIEnv* env, jlongArray arr) {
  std::vector<int64_t> out;
  if (!arr) return out;
  const jsize n = env->GetArrayLength(arr);
  jlong* p = env->GetLongArrayElements(arr, nullptr);
  if (!p) return out;
  out.assign(p, p + n);
  env->ReleaseLongArrayElements(arr, p, JNI_ABORT);
  return out;
}

// ---- The typed record (evidence Phase B) ---------------------------------------------------
// The window arrives as three parallel arrays — ordinals, speaker names, texts — the same shape
// the other JNI seams use, because nlohmann is kept off Android and Kotlin has org.json.

namespace {
std::vector<audionotes::ClassifyTurn> windowFrom(JNIEnv* env, jintArray jOrdinals,
                                                 jobjectArray jSpeakers, jobjectArray jTexts) {
  std::vector<audionotes::ClassifyTurn> window;
  const std::vector<std::string> speakers = jstrArray(env, jSpeakers);
  const std::vector<std::string> texts = jstrArray(env, jTexts);
  const jsize n = jOrdinals ? env->GetArrayLength(jOrdinals) : 0;
  std::vector<jint> ordinals(static_cast<size_t>(n));
  if (n > 0) env->GetIntArrayRegion(jOrdinals, 0, n, ordinals.data());
  for (jsize i = 0; i < n && i < static_cast<jsize>(texts.size()); ++i) {
    window.push_back(audionotes::ClassifyTurn{
        static_cast<int>(ordinals[i]),
        i < static_cast<jsize>(speakers.size()) ? speakers[i] : std::string("Speaker"),
        texts[i]});
  }
  return window;
}
}  // namespace

// ---- Embeddings (bge-small over llama.cpp): meaning search and Ask's retrieval -------------
// Same load/use/free shape as the LLM above; one handle, held by EmbedRuntime.kt.

extern "C" JNIEXPORT jlong JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeEmbedLoad(
    JNIEnv* env, jobject /*thiz*/, jstring jModelPath, jint nThreads) {
  const std::string path = jstr(env, jModelPath);
  auto* engine = new audionotes::EmbedEngine();
  if (!engine->load(path, static_cast<int>(nThreads))) {
    delete engine;
    return 0;
  }
  return reinterpret_cast<jlong>(engine);
}

extern "C" JNIEXPORT jint JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeEmbedDim(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  auto* engine = reinterpret_cast<audionotes::EmbedEngine*>(handle);
  return engine ? engine->dim() : 0;
}

// Flat: dim * n floats, text i at [i*dim, (i+1)*dim). A text that failed to embed is all zeros,
// which a caller can tell apart (a unit vector is never zero) without a second array of flags.
extern "C" JNIEXPORT jfloatArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeEmbedTexts(
    JNIEnv* env, jobject /*thiz*/, jlong handle, jobjectArray jTexts) {
  auto* engine = reinterpret_cast<audionotes::EmbedEngine*>(handle);
  const std::vector<std::string> texts = jstrArray(env, jTexts);
  const int dim = engine ? engine->dim() : 0;
  std::vector<float> flat(static_cast<size_t>(dim) * texts.size(), 0.0f);
  if (engine && dim > 0) {
    const auto vecs = engine->embed(texts);
    for (size_t i = 0; i < vecs.size() && i < texts.size(); ++i) {
      if (vecs[i].size() == static_cast<size_t>(dim)) {
        std::copy(vecs[i].begin(), vecs[i].end(),
                  flat.begin() + static_cast<std::ptrdiff_t>(i * static_cast<size_t>(dim)));
      }
    }
  }
  jfloatArray out = env->NewFloatArray(static_cast<jsize>(flat.size()));
  if (out && !flat.empty()) {
    env->SetFloatArrayRegion(out, 0, static_cast<jsize>(flat.size()), flat.data());
  }
  return out;
}

extern "C" JNIEXPORT void JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeEmbedFree(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  delete reinterpret_cast<audionotes::EmbedEngine*>(handle);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeClassifyGrammar(JNIEnv* env, jobject) {
  return env->NewStringUTF(audionotes::kClassifyGrammar);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeClassifyPrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jItemText, jintArray jOrdinals, jobjectArray jSpeakers,
    jobjectArray jTexts) {
  const std::string prompt =
      audionotes::classifyPrompt(jstr(env, jItemText), windowFrom(env, jOrdinals, jSpeakers, jTexts));
  return env->NewStringUTF(prompt.c_str());
}

// Empty when the answer did not parse — the caller logs and moves on; the item keeps no record.
extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeValidateRecord(
    JNIEnv* env, jobject /*thiz*/, jstring jJson, jintArray jOrdinals, jobjectArray jSpeakers,
    jobjectArray jTexts) {
  audionotes::ItemRecord r;
  if (!audionotes::parseRecord(jstr(env, jJson), &r)) return env->NewStringUTF("");
  const audionotes::ItemRecord v =
      audionotes::validateRecord(r, windowFrom(env, jOrdinals, jSpeakers, jTexts));
  return env->NewStringUTF(audionotes::toJson(v).c_str());
}

// ---- Ask this meeting (sub-project 5) ------------------------------------------------------

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeAskNothing(JNIEnv* env, jobject) {
  return env->NewStringUTF(audionotes::kAskNothing);
}

// Parallel arrays: speakers[i], startMs[i], texts[i] are passage i+1.
extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeAskPrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jQuestion, jobjectArray jSpeakers, jlongArray jStartMs,
    jobjectArray jTexts) {
  const auto speakers = jstrArray(env, jSpeakers);
  const auto starts = jlongVec(env, jStartMs);
  const auto texts = jstrArray(env, jTexts);
  std::vector<audionotes::AskPassage> passages;
  for (size_t i = 0; i < texts.size() && i < speakers.size() && i < starts.size(); ++i) {
    passages.push_back({speakers[i], static_cast<long>(starts[i]), texts[i]});
  }
  return env->NewStringUTF(audionotes::askPrompt(jstr(env, jQuestion), passages).c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeAskGrammar(
    JNIEnv* env, jobject /*thiz*/, jint nPassages) {
  return env->NewStringUTF(audionotes::askGrammar(static_cast<int>(nPassages)).c_str());
}

// {"text":…,"cites":[…],"nothing":bool}
extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeValidateAnswer(
    JNIEnv* env, jobject /*thiz*/, jstring jText, jint nPassages) {
  const audionotes::AskAnswer a = audionotes::validateAnswer(jstr(env, jText), static_cast<int>(nPassages));
  std::string esc;
  jsonEscape(a.text, esc);
  std::string out = "{\"text\":\"" + esc + "\",\"cites\":[";
  for (size_t i = 0; i < a.cites.size(); ++i) {
    if (i) out += ",";
    out += std::to_string(a.cites[i]);
  }
  out += "],\"nothing\":";
  out += a.nothing ? "true" : "false";
  out += "}";
  return env->NewStringUTF(out.c_str());
}

}  // namespace

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeMinutes(
    JNIEnv* env, jobject /*thiz*/, jobjectArray jTexts, jobjectArray jSpeakerIds,
    jobjectArray jSpkIds, jobjectArray jSpkNames) {
  jclass string_cls = env->FindClass("java/lang/String");
  if (!string_cls) return nullptr;

  std::vector<audionotes::MinuteUtt> utts;
  std::vector<audionotes::MinuteSpk> spks;
  try {
    const auto texts = jstrArray(env, jTexts);
    const auto speaker_ids = jstrArray(env, jSpeakerIds);
    const auto spk_ids = jstrArray(env, jSpkIds);
    const auto spk_names = jstrArray(env, jSpkNames);
    utts.reserve(texts.size());
    for (size_t i = 0; i < texts.size(); ++i) {
      utts.push_back({texts[i], i < speaker_ids.size() ? speaker_ids[i] : std::string()});
    }
    spks.reserve(spk_ids.size());
    for (size_t i = 0; i < spk_ids.size(); ++i) {
      spks.push_back({spk_ids[i], i < spk_names.size() ? spk_names[i] : std::string()});
    }
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewObjectArray(0, string_cls, nullptr);
  }

  // Flat [kind, content, source, ...] triples — same shape convention as nativeDiarize.
  std::vector<audionotes::DraftMinute> minutes;
  try {
    minutes = audionotes::extractMinutes(utts, spks);
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewObjectArray(0, string_cls, nullptr);
  }

  jobjectArray out =
      env->NewObjectArray(static_cast<jsize>(minutes.size() * 3), string_cls, nullptr);
  if (!out) return nullptr;
  for (size_t i = 0; i < minutes.size(); ++i) {
    const char* fields[3] = {minutes[i].kind.c_str(), minutes[i].content.c_str(),
                             minutes[i].source.c_str()};
    for (int f = 0; f < 3; ++f) {
      jstring s = env->NewStringUTF(fields[f]);
      env->SetObjectArrayElement(out, static_cast<jsize>(i * 3 + f), s);
      if (s) env->DeleteLocalRef(s);
    }
  }
  return out;
}

// The same rules again, with the provenance nativeMinutes discards: the turn each item came from,
// its start and end in the meeting timeline, and the character span of the sentence inside that
// turn. nativeMinutes takes texts and speaker ids and NO timestamps, so it cannot produce an
// anchor; that is the whole reason this exists rather than a widened nativeMinutes.
//
// Returns JSON rather than the parallel string arrays nativeMinutes and nativeDiarize use, because
// an item has a VARIABLE number of sources — the same sentence said twice is one item with two
// pieces of evidence. Parallel arrays cannot carry that without a second array of per-item source
// counts and matching index arithmetic on both sides of the boundary. One string is cheaper to get
// right, and the payload is a few kilobytes for a long meeting.
//
// The serialization itself is audionotes::itemsToJson, in minutes/evidence.cpp, so the goldens can
// pin the bytes on the host; this function is marshalling and nothing else. It is also why nothing
// here composes JSON with the local jsonEscape helper.
//
// Nothing on the far side may rebuild an item's text by slicing the transcript with charStart and
// charEnd. The offsets index the turn as recorded and the text comes from an apostrophe-normalized
// copy, so the two differ on any turn containing a curly apostrophe — which is most of what
// whisper emits. See the note on ItemSource in minutes/evidence.h.
extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeItems(
    JNIEnv* env, jobject /*thiz*/, jobjectArray jIds, jlongArray jStartsMs, jlongArray jEndsMs,
    jobjectArray jTexts, jobjectArray jSpeakerIds, jobjectArray jSpkIds, jobjectArray jSpkNames) {
  std::string json;
  try {
    const auto ids = jstrArray(env, jIds);
    const auto texts = jstrArray(env, jTexts);
    const auto speaker_ids = jstrArray(env, jSpeakerIds);
    const auto spk_ids = jstrArray(env, jSpkIds);
    const auto spk_names = jstrArray(env, jSpkNames);

    // jstrArray deletes each local ref as it goes; reading the arrays inline here instead would
    // leave one local reference per turn alive for the whole call, and the local reference table
    // is 512 entries. A meeting long enough to matter would abort the process, on a device, with
    // nothing on the host able to see it.
    const std::vector<int64_t> starts = jlongVec(env, jStartsMs);
    const std::vector<int64_t> ends = jlongVec(env, jEndsMs);

    // The field mapping and the length policy live in evidence.cpp, where a host test can reach
    // them: a transposition here — ends into starts, texts into speaker_id — compiles and returns
    // plausible nonsense, and nothing on this side of the boundary could catch it. zipTurns throws
    // if the five arrays disagree rather than anchoring the surplus turns at 0.
    const auto utts = audionotes::zipTurns(ids, starts, ends, speaker_ids, texts);

    std::vector<audionotes::MinuteSpk> spks;
    spks.reserve(spk_ids.size());
    for (size_t i = 0; i < spk_ids.size(); ++i) {
      spks.push_back({spk_ids[i], i < spk_names.size() ? spk_names[i] : std::string()});
    }

    json = audionotes::itemsToJson(audionotes::extractItems(utts, spks));
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    // nullptr, NOT NewStringUTF("[]"). Only a short list of JNI calls is legal with an exception
    // pending and NewStringUTF is not one of them; under CheckJNI — on by default on the emulators
    // where connectedDebugAndroidTest usually runs — ART aborts the process with "JNI
    // NewStringUTF called with pending exception". Kotlin never sees the return value anyway: the
    // pending exception is thrown at the call site the moment this returns.
    return nullptr;
  }
  return env->NewStringUTF(json.c_str());
}

// ---------------------------------------------------------------------------
// LLM minutes plumbing.
//
// C++ owns every prompt, the chunking rule and the fold plan; Kotlin owns only the loop that runs
// them, so it can report progress, honour cancellation and checkpoint each chunk to the DB without
// becoming a fourth copy of this logic. summarize.ts and llm_minutes.cpp are already two; a Kotlin
// port would be the third to keep in sync, which is exactly the drift nativeMinutes was written to
// end when it replaced MinutesExtractor.kt.
// ---------------------------------------------------------------------------

extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmChunks(
    JNIEnv* env, jobject /*thiz*/, jobjectArray jTexts, jobjectArray jSpeakerIds,
    jobjectArray jSpkIds, jobjectArray jSpkNames) {
  jclass string_cls = env->FindClass("java/lang/String");
  if (!string_cls) return nullptr;

  std::vector<std::string> chunks;
  try {
    const auto texts = jstrArray(env, jTexts);
    const auto speaker_ids = jstrArray(env, jSpeakerIds);
    const auto spk_ids = jstrArray(env, jSpkIds);
    const auto spk_names = jstrArray(env, jSpkNames);

    std::vector<audionotes::MinuteUtt> utts;
    utts.reserve(texts.size());
    for (size_t i = 0; i < texts.size(); ++i) {
      utts.push_back({texts[i], i < speaker_ids.size() ? speaker_ids[i] : std::string()});
    }
    std::vector<audionotes::MinuteSpk> spks;
    spks.reserve(spk_ids.size());
    for (size_t i = 0; i < spk_ids.size(); ++i) {
      spks.push_back({spk_ids[i], i < spk_names.size() ? spk_names[i] : std::string()});
    }
    chunks = audionotes::chunkTranscript(audionotes::transcriptLines(utts, spks));
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewObjectArray(0, string_cls, nullptr);
  }

  jobjectArray out = env->NewObjectArray(static_cast<jsize>(chunks.size()), string_cls, nullptr);
  if (!out) return nullptr;
  for (size_t i = 0; i < chunks.size(); ++i) {
    jstring s = env->NewStringUTF(chunks[i].c_str());
    env->SetObjectArrayElement(out, static_cast<jsize>(i), s);
    if (s) env->DeleteLocalRef(s);
  }
  return out;
}

namespace {

// Every prompt builder has the same shape: one jstring in, one jstring out.
// The prose builders take a language with a default, but a DEFAULT ARGUMENT DOES NOT CHANGE A
// FUNCTION'S TYPE — &narrativePrompt is a two-argument pointer and will not bind here. Each call
// site below therefore wraps it in a captureless lambda, which does convert. Do not "simplify"
// them back to &fn; it will not compile, and only the Android build compiles this file, so the
// desktop test suite will not tell you.
//
// The "en" they pin is today's behaviour made explicit. When ProcessingEngine passes the
// meeting's language down, it replaces that literal and these become one-line pass-throughs.
jstring promptCall(JNIEnv* env, jstring jIn, std::string (*fn)(const std::string&)) {
  try {
    return env->NewStringUTF(fn(jstr(env, jIn)).c_str());
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewStringUTF("");
  }
}

}  // namespace

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmMapPrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jChunk) {
  return promptCall(env, jChunk, &audionotes::mapPrompt);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmFoldPrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jNotes) {
  return promptCall(env, jNotes, &audionotes::foldPrompt);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmDigestPrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jChunk) {
  return promptCall(env, jChunk,
                    [](const std::string& s) { return audionotes::digestPrompt(s, "en"); });
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmCondensePrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jProse) {
  return promptCall(env, jProse,
                    [](const std::string& s) { return audionotes::condensePrompt(s, "en"); });
}

// Not a prompt: post-processing. Exposed rather than reimplemented in Kotlin so there is one
// definition of what counts as markdown, tested once, in the language the CLI also runs.
extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeStripMarkdown(
    JNIEnv* env, jobject /*thiz*/, jstring jText) {
  return promptCall(env, jText, &audionotes::stripMarkdown);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeTrimToSentence(
    JNIEnv* env, jobject /*thiz*/, jstring jText) {
  return promptCall(env, jText, &audionotes::trimToSentence);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeStripLabels(
    JNIEnv* env, jobject /*thiz*/, jstring jText) {
  return promptCall(env, jText, &audionotes::stripLabels);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeDropAbsenceTail(
    JNIEnv* env, jobject /*thiz*/, jstring jText) {
  return promptCall(env, jText, &audionotes::dropAbsenceTail);
}

// Not promptCall: every other prompt builder here takes one jstring in, but a meeting type is a
// second argument narrativePrompt needs (see templates.h) — the same try/catch/NewStringUTF shape
// promptCall gives the others, inlined for the one builder that takes two.
extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmNarrativePrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jRecord, jstring jTemplate) {
  try {
    return env->NewStringUTF(
        audionotes::narrativePrompt(jstr(env, jRecord), "en", jstr(env, jTemplate)).c_str());
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewStringUTF("");
  }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmSummaryPrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jNarrative) {
  return promptCall(env, jNarrative,
                    [](const std::string& s) { return audionotes::summaryPrompt(s, "en"); });
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmHeadlinePrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jSummary) {
  return promptCall(env, jSummary,
                    [](const std::string& s) { return audionotes::headlinePrompt(s, "en"); });
}

// Flat [groupIndex, noteIndex, ...] pairs — the same flat-array convention as nativeDiarize, so no
// nested array marshalling is needed.
extern "C" JNIEXPORT jintArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmFoldPlan(
    JNIEnv* env, jobject /*thiz*/, jobjectArray jNotes, jint jMaxChars) {
  std::vector<jint> flat;
  try {
    const auto notes = jstrArray(env, jNotes);
    const auto plan = audionotes::foldPlan(notes, static_cast<std::size_t>(jMaxChars));
    for (size_t g = 0; g < plan.size(); ++g) {
      for (int idx : plan[g]) {
        flat.push_back(static_cast<jint>(g));
        flat.push_back(static_cast<jint>(idx));
      }
    }
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewIntArray(0);
  }
  jintArray out = env->NewIntArray(static_cast<jsize>(flat.size()));
  if (!out) return nullptr;
  if (!flat.empty()) {
    env->SetIntArrayRegion(out, 0, static_cast<jsize>(flat.size()), flat.data());
  }
  return out;
}
