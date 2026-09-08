// Deciding whether window 4's speaker 0 is window 1's speaker 0.
//
// This is the piece that makes windowed diarization survivable. Without it a 90-minute meeting
// between four people comes back with one set of speaker numbers per window and thirty-odd
// speakers overall — which is not a degraded result, it is a wrong one, and wrong attribution is
// the top diarization complaint in every review in this category.
//
// The two failures are not symmetric and the tests below are written around that. Over-splitting
// shows an extra speaker that the user can merge by hand on the Speakers screen. Over-merging puts
// one person's words in another person's mouth, silently, in an exported document.
#include "diar/speaker_match.h"

#include <cmath>
#include <cstdio>
#include <vector>

static int failures = 0;
#define CHECK(cond, ...)                                        \
  do {                                                          \
    if (!(cond)) {                                              \
      std::fprintf(stderr, "FAIL %s:%d: ", __FILE__, __LINE__); \
      std::fprintf(stderr, __VA_ARGS__);                        \
      std::fprintf(stderr, "\n");                               \
      ++failures;                                               \
    }                                                           \
  } while (0)

using audionotes::clusterEmbeddings;

// A 2-D "voice" at a given angle, scaled — the scale must not matter, since the rows are
// normalised before anything is compared.
static void push(std::vector<float>& v, double radians, float scale = 1.0f) {
  v.push_back(static_cast<float>(std::cos(radians)) * scale);
  v.push_back(static_cast<float>(std::sin(radians)) * scale);
}

int main() {
  {
    // Two windows, one voice each, nearly identical: the same person, and the whole point.
    std::vector<float> e;
    push(e, 0.0);
    push(e, 0.05);
    const auto labels = clusterEmbeddings(e, 2, 2, 1.0f);
    CHECK(labels.size() == 2, "expected 2 labels, got %zu", labels.size());
    if (labels.size() == 2) CHECK(labels[0] == labels[1], "same voice must be one speaker");
  }
  {
    // Opposed voices: cosine dissimilarity 2, well past any threshold. Two people.
    std::vector<float> e;
    push(e, 0.0);
    push(e, 3.14159265);
    const auto labels = clusterEmbeddings(e, 2, 2, 1.0f);
    CHECK(labels.size() == 2 && labels[0] != labels[1], "opposed voices must not merge");
  }
  {
    // Length must not decide anything. One speaker embedded over 30 seconds and the same speaker
    // over 3 produce vectors of different magnitude, and if that changed the answer the result
    // would depend on how much somebody happened to talk in a window.
    std::vector<float> e;
    push(e, 0.0, 0.01f);
    push(e, 0.02, 90.0f);
    const auto labels = clusterEmbeddings(e, 2, 2, 1.0f);
    CHECK(labels.size() == 2 && labels[0] == labels[1], "magnitude must not split a speaker");
  }
  {
    // Four windows, two speakers, interleaved the way a real conversation is. The labels must
    // pair up across windows and not simply follow the order they arrived in.
    //
    // Note how far apart A and B have to be put. At a threshold of 1.0 anything with a POSITIVE
    // cosine similarity merges, so two speakers only separate if their embeddings point away from
    // each other — which is a real property of CAM++ on this threshold, and the reason the
    // cross-window constant may not be able to stay at 1.0 once the vectors are averages.
    std::vector<float> e;
    push(e, 0.0);        // window 1, speaker A
    push(e, 2.2);        // window 1, speaker B
    push(e, 2.22);       // window 2, speaker B
    push(e, 0.03);       // window 2, speaker A
    const auto labels = clusterEmbeddings(e, 4, 2, 1.0f);
    CHECK(labels.size() == 4, "expected 4 labels, got %zu", labels.size());
    if (labels.size() == 4) {
      CHECK(labels[0] == labels[3], "A in window 2 is A in window 1");
      CHECK(labels[1] == labels[2], "B in window 2 is B in window 1");
      CHECK(labels[0] != labels[1], "A and B are different people");
      // Numbered by first appearance, so the transcript reads Speaker 1 then Speaker 2 rather
      // than whatever order the clustering happened to close in.
      CHECK(labels[0] == 0 && labels[1] == 1, "labels numbered by first appearance, got %d %d",
            labels[0], labels[1]);
    }
  }
  {
    // Complete linkage, and why it is not a detail. Three voices spread evenly: A-B and B-C are
    // each close enough to merge, A-C is not. Single linkage would chain all three into one
    // speaker through B. Complete linkage refuses, because it measures the furthest pair.
    std::vector<float> e;
    push(e, 0.0);
    push(e, 0.9);
    push(e, 1.8);
    const auto labels = clusterEmbeddings(e, 3, 2, 0.45f, audionotes::Linkage::COMPLETE);
    CHECK(labels.size() == 3, "expected 3 labels, got %zu", labels.size());
    if (labels.size() == 3) {
      CHECK(labels[0] != labels[2], "complete linkage must not chain A to C through B");
    }
  }
  {
    // Why the shipped linkage is AVERAGE, in the shape that made it necessary. Three rows of one
    // speaker spread across three windows: neighbours are close (0.12) but the two ends are not
    // (0.46). Complete linkage asks about the furthest pair and splits the person in two; average
    // asks about the group's centre (0.29) and keeps them whole. Measured on AMI ES2002b, complete
    // linkage turned one speaker's 199 utterances into 138 and 118.
    std::vector<float> e;
    push(e, 0.0);
    push(e, 0.5);
    push(e, 1.0);
    const auto avg = clusterEmbeddings(e, 3, 2, 0.30f, audionotes::Linkage::AVERAGE);
    const auto cmp = clusterEmbeddings(e, 3, 2, 0.30f, audionotes::Linkage::COMPLETE);
    CHECK(avg.size() == 3 && cmp.size() == 3, "expected 3 labels from each");
    if (avg.size() == 3 && cmp.size() == 3) {
      CHECK(avg[0] == avg[1] && avg[1] == avg[2],
            "average linkage must keep one spread-out speaker whole (got %d %d %d)",
            avg[0], avg[1], avg[2]);
      CHECK(cmp[0] != cmp[2], "complete linkage is expected to split it — that is the defect");
    }
  }

  {
    // Average linkage must not become single linkage: two genuinely different speakers stay apart
    // even when one row of each happens to sit close to the other group.
    std::vector<float> e;
    push(e, 0.0);
    push(e, 0.1);
    push(e, 2.6);
    push(e, 2.7);
    const auto labels = clusterEmbeddings(e, 4, 2, 0.30f, audionotes::Linkage::AVERAGE);
    CHECK(labels.size() == 4, "expected 4 labels, got %zu", labels.size());
    if (labels.size() == 4) {
      CHECK(labels[0] == labels[1] && labels[2] == labels[3], "each pair is one speaker");
      CHECK(labels[0] != labels[2], "average linkage must still separate two real speakers");
    }
  }
  {
    // A speaker with too little audio to embed comes back as a zero vector. It must get its own
    // label: a zero vector sits at cosine dissimilarity 1 from every other voice, which under a
    // 1.0 threshold is close enough to be swallowed by whoever came first.
    std::vector<float> e;
    push(e, 0.0);
    e.push_back(0.0f);
    e.push_back(0.0f);
    push(e, 0.02);
    const auto labels = clusterEmbeddings(e, 3, 2, 1.0f);
    CHECK(labels.size() == 3, "expected 3 labels, got %zu", labels.size());
    if (labels.size() == 3) {
      CHECK(labels[0] == labels[2], "the two real voices still merge");
      CHECK(labels[1] != labels[0], "an un-embeddable speaker keeps its own label");
    }
  }
  {
    // Degenerate shapes return nothing rather than reading past the buffer. These are reachable:
    // a window can produce no speakers at all.
    CHECK(clusterEmbeddings({}, 0, 2, 1.0f).empty(), "no rows in, no labels out");
    CHECK(clusterEmbeddings({1.0f, 0.0f}, 1, 2, 1.0f).size() == 1, "one row is one speaker");
    CHECK(clusterEmbeddings({1.0f, 0.0f}, 4, 2, 1.0f).empty(), "short buffer must not be read past");
  }
  {
    // A threshold of zero merges nothing, which is the un-merged behaviour and the escape hatch
    // if this ever needs turning off in a hurry.
    std::vector<float> e;
    push(e, 0.0);
    push(e, 0.001);
    const auto labels = clusterEmbeddings(e, 2, 2, 0.0f);
    CHECK(labels.size() == 2 && labels[0] != labels[1], "threshold 0 merges nothing");
  }

  {
    // The cannot-link constraint. Two rows from the SAME window are two people sherpa already
    // separated using every per-segment embedding in that window — far better evidence than the
    // two averages compared here — so no threshold may put them back together. Without this,
    // AMI ES2003a collapsed five speakers into three and DER went 18.8% -> 42.6%.
    std::vector<float> e;
    push(e, 0.0);   // window 0, speaker A
    push(e, 0.02);  // window 0, speaker B — nearly identical vectors, but NOT the same person
    const std::vector<int> same_window = {0, 0};
    const auto constrained = clusterEmbeddings(e, 2, 2, 1.0f, audionotes::Linkage::AVERAGE, same_window);
    CHECK(constrained.size() == 2 && constrained[0] != constrained[1],
          "two speakers from one window must never merge, however close their averages");
    // Unconstrained, the same two vectors DO merge — which is what makes the constraint the thing
    // doing the work rather than the distance.
    const auto free_ = clusterEmbeddings(e, 2, 2, 1.0f, audionotes::Linkage::AVERAGE);
    CHECK(free_.size() == 2 && free_[0] == free_[1], "without the constraint these would merge");
  }
  {
    // The constraint must survive merging: a cluster inherits the windows of everything folded
    // into it, so A(w0) merging with A(w1) must then be barred from B(w1) as well. Getting this
    // wrong would let a two-step merge do what a one-step merge is forbidden to.
    std::vector<float> e;
    push(e, 0.00);  // row 0: window 0, speaker A
    push(e, 0.01);  // row 1: window 1, speaker A
    push(e, 0.02);  // row 2: window 1, speaker B — same window as row 1, so never with it
    const std::vector<int> groups = {0, 1, 1};
    const auto labels = clusterEmbeddings(e, 3, 2, 1.0f, audionotes::Linkage::AVERAGE, groups);
    CHECK(labels.size() == 3, "expected 3 labels, got %zu", labels.size());
    if (labels.size() == 3) {
      CHECK(labels[1] != labels[2], "two speakers from window 1 must stay apart");
      CHECK(labels[0] != labels[2] || labels[0] != labels[1],
            "row 0 cannot join both, since that would put rows 1 and 2 in one cluster");
    }
  }
  {
    // A groups vector of the wrong length is ignored rather than trusted, because a half-applied
    // constraint would be worse than none: it would bar some merges and permit others with no
    // rule anybody could state.
    std::vector<float> e;
    push(e, 0.0);
    push(e, 0.02);
    const auto labels = clusterEmbeddings(e, 2, 2, 1.0f, audionotes::Linkage::AVERAGE, {0});
    CHECK(labels.size() == 2 && labels[0] == labels[1], "a mismatched groups vector is ignored");
  }

  if (failures == 0) std::printf("test_speaker_match: all checks passed\n");
  return failures ? 1 : 0;
}
