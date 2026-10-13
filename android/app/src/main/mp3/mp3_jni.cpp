// JNI shim: com.innocorelabs.verbale.pipeline.LameEncoder -> libmp3lame.so (LGPL, separate library).
//
// One encoder per export. The handle is the lame_t pointer as a jlong; Kotlin owns its lifetime and
// calls close() in a finally. Mono, 16 kHz, constant bitrate: a recording is speech, and CBR keeps
// the size predictable (64 kbps is ~28 MB an hour).
#include <jni.h>

#include <cstdint>
#include <string>

#include "lame.h"

namespace {
std::string str(JNIEnv* env, jstring s) {
  if (!s) return {};
  const char* c = env->GetStringUTFChars(s, nullptr);
  std::string out(c ? c : "");
  if (c) env->ReleaseStringUTFChars(s, c);
  return out;
}
}  // namespace

extern "C" {

// Returns 0 on failure.
JNIEXPORT jlong JNICALL Java_com_innocorelabs_verbale_pipeline_LameEncoder_nativeOpen(
    JNIEnv* env, jobject, jint sampleRate, jint kbps, jstring title, jstring year, jstring comment) {
  lame_t g = lame_init();
  if (!g) return 0;
  lame_set_in_samplerate(g, sampleRate);
  lame_set_num_channels(g, 1);
  lame_set_mode(g, MONO);
  lame_set_brate(g, kbps);
  lame_set_VBR(g, vbr_off);
  lame_set_quality(g, 5);
  id3tag_init(g);
  id3tag_add_v2(g);
  const std::string t = str(env, title), y = str(env, year), c = str(env, comment);
  if (!t.empty()) id3tag_set_title(g, t.c_str());
  if (!y.empty()) id3tag_set_year(g, y.c_str());
  if (!c.empty()) id3tag_set_comment(g, c.c_str());
  if (lame_init_params(g) < 0) {
    lame_close(g);
    return 0;
  }
  return reinterpret_cast<jlong>(g);
}

// Returns bytes written, or a negative LAME error.
JNIEXPORT jint JNICALL Java_com_innocorelabs_verbale_pipeline_LameEncoder_nativeEncode(
    JNIEnv* env, jobject, jlong h, jshortArray pcm, jint n, jbyteArray out) {
  auto g = reinterpret_cast<lame_t>(h);
  if (!g) return -1;
  jshort* in = env->GetShortArrayElements(pcm, nullptr);
  jbyte* o = env->GetByteArrayElements(out, nullptr);
  const int cap = env->GetArrayLength(out);
  const int w = lame_encode_buffer(g, in, nullptr, n, reinterpret_cast<unsigned char*>(o), cap);
  env->ReleaseByteArrayElements(out, o, 0);
  env->ReleaseShortArrayElements(pcm, in, JNI_ABORT);
  return w;
}

JNIEXPORT jint JNICALL Java_com_innocorelabs_verbale_pipeline_LameEncoder_nativeFlush(
    JNIEnv* env, jobject, jlong h, jbyteArray out) {
  auto g = reinterpret_cast<lame_t>(h);
  if (!g) return -1;
  jbyte* o = env->GetByteArrayElements(out, nullptr);
  const int cap = env->GetArrayLength(out);
  const int w = lame_encode_flush(g, reinterpret_cast<unsigned char*>(o), cap);
  env->ReleaseByteArrayElements(out, o, 0);
  return w;
}

JNIEXPORT void JNICALL Java_com_innocorelabs_verbale_pipeline_LameEncoder_nativeClose(
    JNIEnv*, jobject, jlong h) {
  if (h) lame_close(reinterpret_cast<lame_t>(h));
}

}  // extern "C"
