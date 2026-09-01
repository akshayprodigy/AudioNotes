// JNI bridge: com.innocorelabs.verbale.pipeline.NativeBridge -> libaudionotes.
#include <jni.h>

#include <cstdio>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

#include "asr/whisper_asr.h"
#include "diar/diarizer.h"
#include "llm/llama_engine.h"
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

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeTranscribe(
    JNIEnv* env, jobject /*thiz*/, jstring jPcmPath, jstring jModelPath, jint sampleRate,
    jlongArray jStarts, jlongArray jEnds, jint threads, jstring jLanguage) {
  const std::string pcm = jstr(env, jPcmPath);
  const std::string model = jstr(env, jModelPath);
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
    audionotes::WhisperAsr asr(model, language);
    auto utts = asr.transcribe(pcm, segs, static_cast<int>(sampleRate), static_cast<int>(threads));
    for (size_t i = 0; i < utts.size(); ++i) {
      if (i) json += ",";
      std::string esc;
      jsonEscape(utts[i].text, esc);
      json += "{\"start_ms\":" + std::to_string(utts[i].start_ms) +
              ",\"end_ms\":" + std::to_string(utts[i].end_ms) +
              ",\"text\":\"" + esc + "\"}";
    }
  } catch (const std::exception& e) {
    throwRuntime(env, e.what());
    return env->NewStringUTF("[]");
  }
  json += "]";
  return env->NewStringUTF(json.c_str());
}

// ---- LLM (llama.cpp) — handle-based so the model loads once and is reused across generate() ----

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

extern "C" JNIEXPORT void JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmFree(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  auto* engine = reinterpret_cast<audionotes::LlamaEngine*>(handle);
  delete engine;
}

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeDiarize(
    JNIEnv* env, jobject /*thiz*/, jstring jPcmPath, jstring jSegModel, jstring jEmbModel,
    jint sampleRate, jint numSpeakers) {
  const std::string pcm = jstr(env, jPcmPath);
  const std::string seg = jstr(env, jSegModel);
  const std::string emb = jstr(env, jEmbModel);

  std::vector<jlong> flat;  // [start_ms, end_ms, speaker, ...]
  try {
    audionotes::Diarizer diar(seg, emb, static_cast<int>(sampleRate), static_cast<int>(numSpeakers));
    auto segments = diar.process(pcm);
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
  return promptCall(env, jChunk, &audionotes::digestPrompt);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmCondensePrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jProse) {
  return promptCall(env, jProse, &audionotes::condensePrompt);
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

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmNarrativePrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jNotes) {
  return promptCall(env, jNotes, &audionotes::narrativePrompt);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmSummaryPrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jNarrative) {
  return promptCall(env, jNarrative, &audionotes::summaryPrompt);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_innocorelabs_verbale_pipeline_NativeBridge_nativeLlmHeadlinePrompt(
    JNIEnv* env, jobject /*thiz*/, jstring jSummary) {
  return promptCall(env, jSummary, &audionotes::headlinePrompt);
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
