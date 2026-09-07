#include "diar/speaker_match.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace audionotes {

namespace {

// Cosine dissimilarity, clamped at zero the way sherpa's FastClustering clamps it. Rows arrive
// already normalised, so the dot product is the cosine.
float dissimilarity(const float* a, const float* b, int dim) {
  float dot = 0.0f;
  for (int i = 0; i < dim; ++i) dot += a[i] * b[i];
  const float d = 1.0f - dot;
  return d < 0.0f ? 0.0f : d;
}

}  // namespace

std::vector<int> clusterEmbeddings(const std::vector<float>& embeddings, int rows, int dim,
                                   float threshold, Linkage linkage,
                                   const std::vector<int>& groups) {
  std::vector<int> labels;
  if (rows <= 0 || dim <= 0) return labels;
  if (static_cast<size_t>(rows) * static_cast<size_t>(dim) > embeddings.size()) return labels;
  labels.assign(static_cast<size_t>(rows), 0);
  if (rows == 1) return labels;

  std::vector<float> unit(embeddings.begin(), embeddings.begin() + static_cast<size_t>(rows) * dim);
  // A row that will not normalise is a speaker we could not embed — too little audio, or an
  // extractor that was not ready. It must not be clustered: a zero vector sits at distance 1 from
  // everything, which under this threshold would quietly merge it into whoever came first.
  std::vector<bool> embeddable(static_cast<size_t>(rows), true);
  for (int r = 0; r < rows; ++r) {
    float* row = unit.data() + static_cast<size_t>(r) * dim;
    float norm = 0.0f;
    for (int i = 0; i < dim; ++i) norm += row[i] * row[i];
    norm = std::sqrt(norm);
    if (!(norm > 0.0f) || !std::isfinite(norm)) {
      embeddable[static_cast<size_t>(r)] = false;
      continue;
    }
    for (int i = 0; i < dim; ++i) row[i] /= norm;
  }

  std::vector<int> cluster(static_cast<size_t>(rows));
  for (int r = 0; r < rows; ++r) cluster[static_cast<size_t>(r)] = r;
  // Cluster sizes, for the average-linkage update. A merged cluster's distance to a third has to
  // be weighted by how many rows each side is speaking for, or two rows would outvote twenty.
  std::vector<int> members(static_cast<size_t>(rows), 1);

  std::vector<float> dist(static_cast<size_t>(rows) * static_cast<size_t>(rows), 0.0f);
  for (int i = 0; i < rows; ++i) {
    for (int j = i + 1; j < rows; ++j) {
      const bool pair_ok = embeddable[static_cast<size_t>(i)] && embeddable[static_cast<size_t>(j)];
      const float d = pair_ok ? dissimilarity(unit.data() + static_cast<size_t>(i) * dim,
                                              unit.data() + static_cast<size_t>(j) * dim, dim)
                              : std::numeric_limits<float>::infinity();
      dist[static_cast<size_t>(i) * rows + j] = d;
      dist[static_cast<size_t>(j) * rows + i] = d;
    }
  }

  // The cannot-link constraint, carried as a set of windows per cluster. Two rows from one window
  // are two people sherpa already told apart on better evidence than we have here, so no merge may
  // ever put them together — and the constraint has to survive merging, because a cluster inherits
  // the windows of everything folded into it.
  const bool constrained = static_cast<int>(groups.size()) == rows;
  std::vector<std::vector<int>> windows_of(static_cast<size_t>(rows));
  if (constrained) {
    for (int r = 0; r < rows; ++r) windows_of[static_cast<size_t>(r)].push_back(groups[static_cast<size_t>(r)]);
  }
  auto shares_window = [&](int a, int b) {
    if (!constrained) return false;
    for (int wa : windows_of[static_cast<size_t>(a)]) {
      for (int wb : windows_of[static_cast<size_t>(b)]) {
        if (wa == wb) return true;
      }
    }
    return false;
  };

  std::vector<bool> alive(static_cast<size_t>(rows), true);
  for (int step = 0; step + 1 < rows; ++step) {
    int best_i = -1, best_j = -1;
    float best = std::numeric_limits<float>::infinity();
    for (int i = 0; i < rows; ++i) {
      if (!alive[static_cast<size_t>(i)]) continue;
      for (int j = i + 1; j < rows; ++j) {
        if (!alive[static_cast<size_t>(j)]) continue;
        if (shares_window(i, j)) continue;
        const float d = dist[static_cast<size_t>(i) * rows + j];
        if (d < best) {
          best = d;
          best_i = i;
          best_j = j;
        }
      }
    }
    // The cut. fastcluster's cutree_cdist stops at the first merge height >= cdist, so this does
    // too — and an infinite distance (an un-embeddable row) can never pass it.
    if (best_i < 0 || !(best < threshold)) break;

    for (int r = 0; r < rows; ++r) {
      if (cluster[static_cast<size_t>(r)] == best_j) cluster[static_cast<size_t>(r)] = best_i;
    }
    alive[static_cast<size_t>(best_j)] = false;
    const int ni = members[static_cast<size_t>(best_i)];
    const int nj = members[static_cast<size_t>(best_j)];
    for (int k = 0; k < rows; ++k) {
      if (!alive[static_cast<size_t>(k)] || k == best_i) continue;
      const float di = dist[static_cast<size_t>(best_i) * rows + k];
      const float dj = dist[static_cast<size_t>(best_j) * rows + k];
      // Lance-Williams for the two linkages. An infinite distance — an un-embeddable row — stays
      // infinite through both, which is what keeps such a row in a cluster of its own.
      const float merged = linkage == Linkage::COMPLETE
                               ? std::max(di, dj)
                               : (static_cast<float>(ni) * di + static_cast<float>(nj) * dj) /
                                     static_cast<float>(ni + nj);
      dist[static_cast<size_t>(best_i) * rows + k] = merged;
      dist[static_cast<size_t>(k) * rows + best_i] = merged;
    }
    members[static_cast<size_t>(best_i)] = ni + nj;
    if (constrained) {
      auto& into = windows_of[static_cast<size_t>(best_i)];
      const auto& from = windows_of[static_cast<size_t>(best_j)];
      into.insert(into.end(), from.begin(), from.end());
    }
  }

  // Number by first appearance, so speaker 0 is whoever spoke first.
  std::vector<int> renumber(static_cast<size_t>(rows), -1);
  int next = 0;
  for (int r = 0; r < rows; ++r) {
    const int c = cluster[static_cast<size_t>(r)];
    if (renumber[static_cast<size_t>(c)] < 0) renumber[static_cast<size_t>(c)] = next++;
    labels[static_cast<size_t>(r)] = renumber[static_cast<size_t>(c)];
  }
  return labels;
}

}  // namespace audionotes
