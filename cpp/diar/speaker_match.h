// Deciding whether the person talking in window 4 is the same person who talked in window 1.
//
// Windowed diarization gives every window its own speaker numbering, and nothing in those numbers
// carries across: sherpa clusters each window from scratch, so its "speaker 0" is whoever happened
// to talk first in that window. Left alone, a 90-minute meeting between four people would come
// back with thirty-odd speakers and be worse than useless — wrong attribution is the top
// diarization complaint in every review of every product in this category.
//
// So each window hands back one voice embedding per local speaker, and those get clustered again.
// This is the same operation sherpa performs INSIDE a window, deliberately: the same metric
// (cosine dissimilarity), the same linkage (complete), the same cut rule (stop at the first merge
// whose height reaches the threshold). A boundary means the same thing on both sides of it, and
// the threshold can be reasoned about against the one already tuned for CAM++.
//
// Kept free of sherpa and ONNX. The clustering is arithmetic and belongs where it can be tested
// without a model.
#pragma once
#include <cstdint>
#include <vector>

namespace audionotes {

/**
 * How close two windows' voices must be to be called the same person.
 *
 * Only consulted when windowing is on, which by default it is not — see kDiarWindowMs. Kept
 * because the numbers below are worth being able to reproduce.
 *
 * 0.65 is the middle of a plateau swept on AMI ES2002a against an un-windowed control of
 * DER 23.4% / attribution 91.4%:
 *
 *   0.35  23.9 / 89.8      0.65  22.6 / 92.4      0.85  25.0 / 88.8
 *   0.45  23.9 / 89.8      0.75  22.6 / 92.4      1.00  65.7 / 51.2
 *   0.55  22.6 / 92.4
 *
 * TWO CAVEATS, both load-bearing. That sweep used COMPLETE linkage and no cannot-link constraint,
 * and this file now defaults to average linkage WITH the constraint — so the table describes an
 * older algorithm and 0.65 has never been re-swept under the current one. And it was swept on a
 * single fixture: across all four, windowing at 0.65 measured DER 26.2-27.7 against 20.0 for one
 * pass, which is why windowing is off. Re-sweep before trusting this number for anything.
 *
 * What the table is still good for is the shape at the top end. Reusing sherpa's own within-window
 * threshold of 1.0 — the obvious value, swept to that peak for CAM++ over four AMI meetings — is a
 * catastrophe here: four speakers collapsed into one. sherpa clusters per-segment embeddings,
 * which spread far enough apart that different speakers land at negative cosine similarity; these
 * are per-speaker averages, and averaging pulls every vector toward the middle of its own cluster.
 * Dumping the pairwise distances for ES2002a put them all between 0.25 and 0.95, so a 1.0 cut
 * merged the lot.
 */
constexpr float kSpeakerMergeThreshold = 0.65f;

/**
 * How the distance between two CLUSTERS is derived from the distances between their members.
 *
 * sherpa uses COMPLETE inside a window, and complete is the conservative choice: a merge is made
 * only when every pair across it is close, so two speakers cannot be chained together through one
 * ambiguous vector. That is the right instinct with many per-segment embeddings per speaker.
 *
 * Across windows it inverts. A speaker appearing in four windows is four rows and six pairs, and
 * complete linkage requires all six to be close — so ONE window where they barely spoke, and whose
 * average is therefore noisy, blocks the whole group and splits one person into two. Measured on
 * AMI ES2002b (38 min, four windows): one speaker's 199 utterances came back as 118 and 138.
 * AVERAGE linkage asks the same question of the group's centre instead of its worst member.
 */
enum class Linkage { COMPLETE, AVERAGE };

/**
 * Agglomerative clustering of `rows` embeddings of `dim` floats each, laid out row-major, on
 * cosine dissimilarity max(0, 1 - cos).
 *
 * Rows are L2-normalised internally; a zero-length row (a speaker with too little audio to embed)
 * is given its own cluster rather than being merged with everything at distance 1.
 *
 * `groups` says which window each row came from, and is a CANNOT-LINK constraint: two rows from
 * the same window are two people sherpa already separated, with all of that window's per-segment
 * embeddings in front of it, which is far better evidence than the two averages compared here.
 * Merging them would be overruling the stronger judgement with the weaker one. Measured on AMI
 * ES2003a, doing exactly that collapsed five speakers into three and took DER from 18.8% to 42.6%.
 * Pass an empty vector to drop the constraint.
 *
 * Merging stops at the first pair whose distance reaches `threshold`, matching fastcluster's
 * cutree_cdist, which breaks on `height >= cdist`.
 *
 * Returns one label per row, numbered by first appearance so that speaker 0 is the first person
 * to talk in the meeting. Arbitrary cluster indices would be just as correct and much harder to
 * read in a transcript.
 *
 * O(rows^3) and unashamed: rows is the number of speakers summed over windows — nine windows of
 * four speakers is 36 — while the alternative is a nearest-neighbour chain that would need its own
 * test for a saving of microseconds.
 */
std::vector<int> clusterEmbeddings(const std::vector<float>& embeddings, int rows, int dim,
                                   float threshold, Linkage linkage = Linkage::AVERAGE,
                                   const std::vector<int>& groups = {});

}  // namespace audionotes
