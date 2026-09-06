#include "diar/span_map.h"

#include <algorithm>

namespace audionotes {

std::vector<int64_t> concatOffsets(const std::vector<Span>& spans) {
  std::vector<int64_t> offsets;
  offsets.reserve(spans.size());
  int64_t running = 0;
  for (const auto& s : spans) {
    offsets.push_back(running);
    running += std::max<int64_t>(0, s.end_ms - s.start_ms);
  }
  return offsets;
}

int64_t totalSpeechMs(const std::vector<Span>& spans) {
  int64_t total = 0;
  for (const auto& s : spans) total += std::max<int64_t>(0, s.end_ms - s.start_ms);
  return total;
}

std::vector<DiarSegment> toOriginalTimeline(const std::vector<DiarSegment>& concat,
                                            const std::vector<Span>& spans) {
  std::vector<DiarSegment> out;
  if (spans.empty()) return out;
  const std::vector<int64_t> offsets = concatOffsets(spans);

  for (const auto& seg : concat) {
    if (seg.end_ms <= seg.start_ms) continue;  // nothing to place
    for (size_t i = 0; i < spans.size(); ++i) {
      const int64_t dur = std::max<int64_t>(0, spans[i].end_ms - spans[i].start_ms);
      if (dur == 0) continue;
      const int64_t lo = offsets[i];
      const int64_t hi = lo + dur;
      // The part of this segment that falls inside span i, in concatenated time.
      const int64_t from = std::max(seg.start_ms, lo);
      const int64_t to = std::min(seg.end_ms, hi);
      if (to <= from) continue;
      // Same offset within the span, on the real timeline.
      out.push_back(DiarSegment{spans[i].start_ms + (from - lo),
                                spans[i].start_ms + (to - lo),
                                seg.speaker});
    }
  }

  std::sort(out.begin(), out.end(), [](const DiarSegment& a, const DiarSegment& b) {
    if (a.start_ms != b.start_ms) return a.start_ms < b.start_ms;
    return a.end_ms < b.end_ms;
  });
  return out;
}

}  // namespace audionotes
