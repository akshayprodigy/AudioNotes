// Remembered voices (Phase 4): does the diarizer's per-speaker embedding recognise the same
// person in a different meeting, and not a different person? Against the real CAM++ model on the
// Mac and the AMI fixtures, where ES2002a and ES2002b are the same four people (A–D are seats,
// consistent across the ES2002 series) and ES2003a / IS1000a are other groups. Ground-truth turns
// from truth.json stand in for diarization so this measures the EMBEDDING, not the clustering.
// Skips itself, exit 0, without the model or the fixtures. Prints every cosine so a change is seen.
//
// Measured 17 Sep 2026 (the full table is in the Phase 4 brief §4): the same person across the
// two meetings 0.785–0.884 (four pairs, one of them from 26 s of speech); different people at
// most 0.498 over 76 pairs, most below 0.35. The bars below sit inside that gap, and the
// product's match rule (0.65 with a 0.10 margin, PeopleMatch.kt) sits inside the bars.
#include "diar/diarizer.h"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <map>
#include <sstream>
#include <string>
#include <vector>

using namespace audionotes;

static int failures = 0;
#define CHECK(cond)                                                        \
  do {                                                                     \
    if (!(cond)) {                                                         \
      std::fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
      ++failures;                                                          \
    }                                                                      \
  } while (0)

// The four fixtures' truth.json is small and regular: {"start_ms":..,"end_ms":..,"speaker":"B",..}.
// A grep-shaped parse, so this test needs no JSON library.
static std::vector<DiarSegment> truthSegments(const std::string& path, std::vector<std::string>& labels) {
  std::vector<DiarSegment> out;
  std::ifstream in(path);
  if (!in) return out;
  std::stringstream ss;
  ss << in.rdbuf();
  const std::string s = ss.str();
  std::map<std::string, int> index;
  for (std::size_t pos = s.find("\"start_ms\""); pos != std::string::npos; pos = s.find("\"start_ms\"", pos + 1)) {
    const std::size_t e = s.find("\"end_ms\"", pos);
    const std::size_t sp = s.find("\"speaker\"", pos);
    if (e == std::string::npos || sp == std::string::npos) break;
    const int64_t start = std::atoll(s.c_str() + s.find(':', pos) + 1);
    const int64_t end = std::atoll(s.c_str() + s.find(':', e) + 1);
    const std::size_t q1 = s.find('"', s.find(':', sp) + 1);
    const std::size_t q2 = s.find('"', q1 + 1);
    const std::string who = s.substr(q1 + 1, q2 - q1 - 1);
    if (!index.count(who)) { index[who] = static_cast<int>(labels.size()); labels.push_back(who); }
    out.push_back(DiarSegment{start, end, index[who]});
  }
  return out;
}

static float dot(const std::vector<float>& a, const std::vector<float>& b) {
  float s = 0.f;
  for (std::size_t i = 0; i < a.size() && i < b.size(); ++i) s += a[i] * b[i];
  return s;
}

int main() {
#ifdef AUDIONOTES_ORT_LIB_DEFAULT
  // The CLI does the same in its main: the fetched onnxruntime dylib, unless the caller chose one.
  setenv("AUDIONOTES_ORT_LIB", AUDIONOTES_ORT_LIB_DEFAULT, /*overwrite=*/0);
#endif
  const char* seg = std::getenv("VERBALE_DIAR_SEG");
  const char* emb = std::getenv("VERBALE_DIAR_EMB");
  const char* fixtures = std::getenv("VERBALE_FIXTURES");
  if (!seg || !emb || !fixtures || !*seg || !*emb || !*fixtures) {
    std::puts("test_voices_live: skipped (VERBALE_DIAR_SEG / VERBALE_DIAR_EMB / VERBALE_FIXTURES unset)");
    return 0;
  }
  Diarizer d(seg, emb, 16000, /*num_speakers=*/0);
  if (!d.ok()) { std::puts("test_voices_live: skipped (diarizer not available)"); return 0; }

  struct Meeting { std::string name; std::vector<std::string> labels; std::vector<std::vector<float>> voices; };
  std::vector<Meeting> ms;
  for (const char* name : {"ES2002a", "ES2002b", "ES2003a", "IS1000a"}) {
    const std::string dir = std::string(fixtures) + "/" + name;
    Meeting m; m.name = name;
    const auto segs = truthSegments(dir + "/truth.json", m.labels);
    if (segs.empty()) { std::printf("test_voices_live: skipped (%s/truth.json missing)\n", dir.c_str()); return 0; }
    m.voices = d.speakerVoices(dir + "/audio.wav.pcm", segs);
    CHECK(m.voices.size() == m.labels.size());
    for (std::size_t i = 0; i < m.voices.size(); ++i) CHECK(!m.voices[i].empty());
    ms.push_back(std::move(m));
  }

  float same_min = 1.f, diff_max = -1.f;
  auto at = [&](const Meeting& m, const std::string& label) -> const std::vector<float>* {
    for (std::size_t i = 0; i < m.labels.size(); ++i) if (m.labels[i] == label) return &m.voices[i];
    return nullptr;
  };
  // ES2002a vs ES2002b: the same letter is the same person, a different letter is not.
  for (const std::string& a : ms[0].labels) {
    for (const std::string& b : ms[1].labels) {
      const auto* va = at(ms[0], a); const auto* vb = at(ms[1], b);
      if (!va || !vb || va->empty() || vb->empty()) continue;
      const float c = dot(*va, *vb);
      std::printf("cos %.3f  ES2002a.%s vs ES2002b.%s  %s\n", c, a.c_str(), b.c_str(), a == b ? "SAME" : "different");
      if (a == b) same_min = std::min(same_min, c); else diff_max = std::max(diff_max, c);
    }
  }
  // Everyone in ES2002a/b against everyone in the other two groups: all different people.
  for (std::size_t i = 0; i < 2; ++i) {
    for (std::size_t j = 2; j < ms.size(); ++j) {
      for (std::size_t x = 0; x < ms[i].voices.size(); ++x) {
        for (std::size_t y = 0; y < ms[j].voices.size(); ++y) {
          if (ms[i].voices[x].empty() || ms[j].voices[y].empty()) continue;
          const float c = dot(ms[i].voices[x], ms[j].voices[y]);
          std::printf("cos %.3f  %s.%s vs %s.%s  different\n", c, ms[i].name.c_str(), ms[i].labels[x].c_str(),
                      ms[j].name.c_str(), ms[j].labels[y].c_str());
          diff_max = std::max(diff_max, c);
        }
      }
    }
  }
  std::printf("same-person minimum %.3f, different-person maximum %.3f\n", same_min, diff_max);
  // The bars: a person is recognised at 0.70 and above; nobody else reaches 0.65.
  CHECK(same_min >= 0.70f);
  CHECK(diff_max < 0.65f);
  if (failures) { std::fprintf(stderr, "test_voices_live: %d failure(s)\n", failures); return 1; }
  std::puts("test_voices_live: ok");
  return 0;
}
