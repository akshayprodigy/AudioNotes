// JNI bridge: com.audionotes.pipeline.NativeBridge -> libaudionotes.
#include <jni.h>

#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

#include "asr/whisper_asr.h"
#include "diar/diarizer.h"
#include "llm/llama_engine.h"
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
Java_com_audionotes_pipeline_NativeBridge_nativeVad(
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
Java_com_audionotes_pipeline_NativeBridge_nativeTranscribe(
    JNIEnv* env, jobject /*thiz*/, jstring jPcmPath, jstring jModelPath, jint sampleRate,
    jlongArray jStarts, jlongArray jEnds) {
  const std::string pcm = jstr(env, jPcmPath);
  const std::string model = jstr(env, jModelPath);

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
    audionotes::WhisperAsr asr(model);
    auto utts = asr.transcribe(pcm, segs, static_cast<int>(sampleRate));
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
Java_com_audionotes_pipeline_NativeBridge_nativeLlmLoad(
    JNIEnv* env, jobject /*thiz*/, jstring jModelPath, jint nCtx, jint nThreads) {
  const std::string path = jstr(env, jModelPath);
  auto* engine = new audionotes::LlamaEngine();
  if (!engine->load(path, static_cast<int>(nCtx), static_cast<int>(nThreads))) {
    delete engine;
    return 0;
  }
  return reinterpret_cast<jlong>(engine);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_audionotes_pipeline_NativeBridge_nativeLlmGenerate(
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
Java_com_audionotes_pipeline_NativeBridge_nativeLlmFree(
    JNIEnv* /*env*/, jobject /*thiz*/, jlong handle) {
  auto* engine = reinterpret_cast<audionotes::LlamaEngine*>(handle);
  delete engine;
}

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_audionotes_pipeline_NativeBridge_nativeDiarize(
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
