#include "diar/span_map.h"

#include <algorithm>

namespace audionotes {

std::vector<Span> padAndMerge(const std::vector<Span>& spans, int64_t pad_ms, int64_t total_ms) {
  std::vector<Span> grown;
  grown.reserve(spans.size());
  for (const auto& s : spans) {
    if (s.end_ms <= s.start_ms) continue;
    int64_t from = s.start_ms - pad_ms;
    int64_t to = s.end_ms + pad_ms;
    if (from < 0) from = 0;
    if (total_ms > 0 && to > total_ms) to = total_ms;
    if (to > from) grown.push_back(Span{from, to});
  }
  std::sort(grown.begin(), grown.end(),
            [](const Span& a, const Span& b) { return a.start_ms < b.start_ms; });

  std::vector<Span> merged;
  for (const auto& s : grown) {
    // Touching counts as overlapping: two spans meeting exactly would otherwise emit a boundary
    // the audio does not have, which is the very thing the padding exists to avoid.
    if (!merged.empty() && s.start_ms <= merged.back().end_ms) {
      merged.back().end_ms = std::max(merged.back().end_ms, s.end_ms);
    } else {
      merged.push_back(s);
    }
  }
  return merged;
}

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

std::vector<std::vector<Span>> windowSpans(const std::vector<Span>& spans, int64_t window_ms) {
  std::vector<std::vector<Span>> windows;
  if (spans.empty()) return windows;
  if (window_ms <= 0) {
    windows.push_back(spans);
    return windows;
  }

  std::vector<Span> current;
  int64_t filled = 0;
  for (const auto& s : spans) {
    int64_t from = s.start_ms;
    const int64_t to = s.end_ms;
    if (to <= from) continue;
    while (from < to) {
      const int64_t room = window_ms - filled;
      // The window is full. Close it and carry on with a fresh one rather than emitting a
      // zero-room window below.
      if (room <= 0) {
        windows.push_back(current);
        current.clear();
        filled = 0;
        continue;
      }
      const int64_t remaining = to - from;
      // Fits whole: never cut a span that a window can hold. If it does not fit here but would
      // fit in an empty window, close this one — the boundary the cut would create costs more
      // than the unused room does.
      if (remaining <= room) {
        current.push_back(Span{from, to});
        filled += remaining;
        from = to;
      } else if (remaining <= window_ms && !current.empty()) {
        windows.push_back(current);
        current.clear();
        filled = 0;
      } else {
        // Longer than any window can hold, so it has to be cut. See the header: the boundary is
        // real and is repaired later by matching voices across it.
        current.push_back(Span{from, from + room});
        filled += room;
        from += room;
      }
    }
  }
  if (!current.empty()) windows.push_back(current);
  return windows;
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
