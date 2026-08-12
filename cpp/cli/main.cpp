// AudioNotes desktop CLI — Phase 1a bring-up.
//
// Current milestone: ASR + VAD. Transcribe a 16 kHz mono PCM16 WAV using the shared core's
// WhisperAsr and (with --vad) segment it first with the core's SileroVad — the same code the
// Android app runs via JNI. Diarization, the LLM MOM, and the full orchestrator land in later
// milestones. Without --vad we fall back to fixed 30 s windows over the whole file.
#include "asr/whisper_asr.h"
#include "vad/silero_vad.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <exception>
#include <fstream>
#include <string>
#include <vector>

namespace {

uint32_t rd32(const unsigned char* p) {
  return p[0] | (p[1] << 8) | (p[2] << 16) | (static_cast<uint32_t>(p[3]) << 24);
}
uint16_t rd16(const unsigned char* p) { return static_cast<uint16_t>(p[0] | (p[1] << 8)); }

// Extract the `data` chunk of a PCM16 mono 16 kHz WAV into a headerless .pcm file — exactly the
// format the core readers (whisper_asr/silero_vad/diarizer) expect. Returns duration in ms, or -1.
// Resampling / channel-downmix is intentionally out of scope for this milestone.
int64_t wavToPcm(const std::string& wav, const std::string& pcm_out, std::string& err) {
  std::ifstream in(wav, std::ios::binary);
  if (!in) { err = "cannot open " + wav; return -1; }
  std::vector<unsigned char> buf((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
  if (buf.size() < 44 || std::memcmp(buf.data(), "RIFF", 4) != 0 ||
      std::memcmp(buf.data() + 8, "WAVE", 4) != 0) {
    err = "not a RIFF/WAVE file";
    return -1;
  }

  // Walk the chunks after the 12-byte RIFF/WAVE header (chunks are word-aligned).
  size_t pos = 12;
  uint16_t channels = 0, bits = 0, fmt = 0;
  uint32_t rate = 0;
  const unsigned char* data = nullptr;
  uint32_t data_len = 0;
  while (pos + 8 <= buf.size()) {
    const unsigned char* id = buf.data() + pos;
    uint32_t sz = rd32(buf.data() + pos + 4);
    const unsigned char* body = buf.data() + pos + 8;
    if (std::memcmp(id, "fmt ", 4) == 0 && sz >= 16 && pos + 8 + 16 <= buf.size()) {
      fmt = rd16(body);
      channels = rd16(body + 2);
      rate = rd32(body + 4);
      bits = rd16(body + 14);
    } else if (std::memcmp(id, "data", 4) == 0) {
      data = body;
      data_len = static_cast<uint32_t>(std::min<size_t>(sz, buf.size() - (pos + 8)));
    }
    pos += 8 + sz + (sz & 1);
  }

  if (!data) { err = "no data chunk"; return -1; }
  if (fmt != 1 || channels != 1 || rate != 16000 || bits != 16) {
    char m[192];
    std::snprintf(m, sizeof m, "need PCM16 mono 16kHz; got fmt=%u ch=%u rate=%u bits=%u", fmt,
                  channels, rate, bits);
    err = m;
    return -1;
  }

  std::ofstream out(pcm_out, std::ios::binary);
  if (!out) { err = "cannot write " + pcm_out; return -1; }
  out.write(reinterpret_cast<const char*>(data), data_len);
  return static_cast<int64_t>(data_len) / 2 * 1000 / 16000;  // samples * 1000 / sample_rate
}

}  // namespace

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr,
                 "usage: %s <whisper-model.bin> <input-16k-mono.wav> [--vad silero_vad.onnx]\n",
                 argv[0]);
    return 2;
  }
  const std::string model = argv[1];
  const std::string wav = argv[2];
  const std::string pcm = wav + ".pcm";
  std::string vad_model;
  for (int i = 3; i < argc; ++i) {
    if (std::strcmp(argv[i], "--vad") == 0 && i + 1 < argc) vad_model = argv[++i];
  }

#ifdef AUDIONOTES_ORT_LIB_DEFAULT
  // The build fetched a host onnxruntime; make it the default unless the user already chose one.
  setenv("AUDIONOTES_ORT_LIB", AUDIONOTES_ORT_LIB_DEFAULT, /*overwrite=*/0);
#endif

  std::string err;
  int64_t dur_ms = wavToPcm(wav, pcm, err);
  if (dur_ms < 0) {
    std::fprintf(stderr, "wav error: %s\n", err.c_str());
    return 1;
  }
  std::fprintf(stderr, "audio: %.1fs\n", dur_ms / 1000.0);

  audionotes::WhisperAsr asr(model);
  if (!asr.ok()) {
    std::fprintf(stderr, "failed to load whisper model: %s\n", model.c_str());
    return 1;
  }

  std::vector<audionotes::Segment> segs;
  if (!vad_model.empty()) {
    try {
      audionotes::SileroVad vad(vad_model, 16000);
      segs = vad.process(pcm);
    } catch (const std::exception& e) {
      std::fprintf(stderr, "vad error: %s\n", e.what());
      return 1;
    }
    std::fprintf(stderr, "vad: %zu speech segment(s)\n", segs.size());
    for (const auto& s : segs) {
      std::fprintf(stderr, "  speech %6lld-%6lld ms\n", static_cast<long long>(s.start_ms),
                   static_cast<long long>(s.end_ms));
    }
  } else {
    // No VAD model given: fixed 30 s windows over the whole file.
    for (int64_t s = 0; s < dur_ms; s += 30000) {
      segs.push_back({s, std::min<int64_t>(s + 30000, dur_ms)});
    }
  }

  auto utts = asr.transcribe(pcm, segs, 16000);
  std::fprintf(stderr, "utterances: %zu\n", utts.size());
  for (const auto& u : utts) {
    std::printf("[%6lld-%6lld ms] %s\n", static_cast<long long>(u.start_ms),
                static_cast<long long>(u.end_ms), u.text.c_str());
  }
  return 0;
}
