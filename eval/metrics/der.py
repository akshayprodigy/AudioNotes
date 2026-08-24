"""Diarization Error Rate.

    DER = (missed + false_alarm + confusion) / scored_reference_speech

Three conventions, each of which changes the number materially, so each is explicit:

* **Optimal label mapping.** Our cluster ids are arbitrary integers. Before anything is scored,
  clusters are matched one-to-one to reference speakers so as to maximise agreement (Hungarian
  assignment). Skipping this scores a perfect-but-relabelled diarization as 100% wrong.
* **250 ms collar** around every reference boundary is excluded. Exact boundary placement is
  neither achievable nor perceptually meaningful, and without a collar the score is dominated by
  millisecond disagreements at turn changes.
* **Overlapping reference speech is excluded** and the excluded duration is reported. Our pipeline
  assigns exactly one speaker per utterance, so it cannot represent overlap; silently scoring it
  would just accumulate unavoidable error, and silently dropping it without saying so would
  flatter the result.

Scoring works over atomic intervals cut at every boundary, so there is no grid resolution to tune
and no rounding drift.
"""
from dataclasses import dataclass, field

COLLAR_MS = 250


@dataclass
class DerResult:
    missed_ms: int
    false_alarm_ms: int
    confusion_ms: int
    scored_ref_ms: int
    overlap_ms: int
    mapping: dict = field(default_factory=dict)

    @property
    def der(self):
        # No scored reference speech means there is no rate to report; returning 0.0 keeps a
        # silent fixture from aborting a run.
        if self.scored_ref_ms <= 0:
            return 0.0
        return (self.missed_ms + self.false_alarm_ms + self.confusion_ms) / self.scored_ref_ms

    def as_dict(self):
        return {
            "der": round(self.der, 6),
            "missed_ms": self.missed_ms,
            "false_alarm_ms": self.false_alarm_ms,
            "confusion_ms": self.confusion_ms,
            "scored_ref_ms": self.scored_ref_ms,
            "overlap_ms": self.overlap_ms,
            "mapping": {str(k): v for k, v in self.mapping.items()},
        }


def _hungarian(cost):
    """Min-cost assignment for a rectangular matrix (rows <= cols). Returns col per row.

    Standard O(n^3) potentials/augmenting-path method. Written out rather than pulled from scipy
    because the harness stays dependency-free — see the spec.
    """
    n, m = len(cost), len(cost[0])
    INF = float("inf")
    u = [0.0] * (n + 1)
    v = [0.0] * (m + 1)
    p = [0] * (m + 1)
    way = [0] * (m + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [INF] * (m + 1)
        used = [False] * (m + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = INF
            j1 = -1
            for j in range(1, m + 1):
                if used[j]:
                    continue
                cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta = minv[j]
                    j1 = j
            for j in range(m + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while j0:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
    out = [-1] * n
    for j in range(1, m + 1):
        if p[j]:
            out[p[j] - 1] = j - 1
    return out


def _atomic_intervals(ref, hyp):
    """Cut the timeline at every boundary so ref/hyp membership is constant within each piece."""
    points = set()
    for s in list(ref) + list(hyp):
        points.add(int(s["start_ms"]))
        points.add(int(s["end_ms"]))
    for s in ref:  # collar edges become boundaries too
        for t in (s["start_ms"] - COLLAR_MS, s["start_ms"] + COLLAR_MS,
                  s["end_ms"] - COLLAR_MS, s["end_ms"] + COLLAR_MS):
            points.add(int(t))
    ordered = sorted(p for p in points if p >= 0)
    return list(zip(ordered, ordered[1:]))


def _active(segments, start, end):
    """Labels of segments covering the interval (which lies wholly inside or outside each)."""
    mid = (start + end) / 2.0
    return [s["speaker"] for s in segments if s["start_ms"] <= mid < s["end_ms"]]


def der(reference, hypothesis):
    """`reference`/`hypothesis`: [{start_ms, end_ms, speaker}]. Hypothesis speakers may be ints."""
    reference = [s for s in reference if s["end_ms"] > s["start_ms"]]
    hypothesis = [s for s in hypothesis if s["end_ms"] > s["start_ms"]]

    ref_labels = sorted({s["speaker"] for s in reference}, key=str)
    hyp_labels = sorted({s["speaker"] for s in hypothesis}, key=str)

    intervals = _atomic_intervals(reference, hypothesis)
    collar_edges = []
    for s in reference:
        collar_edges.append((s["start_ms"] - COLLAR_MS, s["start_ms"] + COLLAR_MS))
        collar_edges.append((s["end_ms"] - COLLAR_MS, s["end_ms"] + COLLAR_MS))

    # Pass 1: agreement per (ref speaker, hyp cluster) over scored regions, for the mapping.
    agree = {r: {h: 0 for h in hyp_labels} for r in ref_labels}
    scored = []
    overlap_ms = 0
    for start, end in intervals:
        dur = end - start
        if dur <= 0:
            continue
        r_active = _active(reference, start, end)
        if len(r_active) > 1:
            overlap_ms += dur
            continue
        mid = (start + end) / 2.0
        if any(a <= mid < b for a, b in collar_edges):
            continue
        h_active = _active(hypothesis, start, end)
        scored.append((dur, r_active, h_active))
        if r_active and h_active:
            agree[r_active[0]][h_active[0]] += dur

    mapping = {}
    if ref_labels and hyp_labels:
        # Maximise agreement == minimise (max - agreement).
        best = max((agree[r][h] for r in ref_labels for h in hyp_labels), default=0)
        rows, cols = ref_labels, hyp_labels
        transposed = len(rows) > len(cols)
        if transposed:
            rows, cols = cols, rows
        cost = [[float(best - (agree[c][r] if transposed else agree[r][c]))
                 for c in cols] for r in rows]
        for i, j in enumerate(_hungarian(cost)):
            if j < 0:
                continue
            if transposed:
                mapping[rows[i]] = cols[j]      # rows are clusters
            else:
                mapping[cols[j]] = rows[i]      # cols are clusters

    # Pass 2: score with the mapping fixed.
    missed = false_alarm = confusion = scored_ref = 0
    for dur, r_active, h_active in scored:
        if r_active:
            scored_ref += dur
            if not h_active:
                missed += dur
            elif mapping.get(h_active[0]) != r_active[0]:
                confusion += dur
        elif h_active:
            false_alarm += dur

    return DerResult(missed_ms=missed, false_alarm_ms=false_alarm, confusion_ms=confusion,
                     scored_ref_ms=scored_ref, overlap_ms=overlap_ms, mapping=mapping)
