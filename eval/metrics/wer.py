"""Word Error Rate over normalised tokens.

WER = (substitutions + deletions + insertions) / reference_words

The S/D/I split is reported, not just the total, because it says HOW a model fails: insertions
point at hallucination, deletions usually mean VAD dropped speech before ASR ever saw it.
"""
from dataclasses import dataclass

from eval.metrics.normalize import normalize


@dataclass
class WerResult:
    substitutions: int
    deletions: int
    insertions: int
    ref_words: int

    @property
    def errors(self):
        return self.substitutions + self.deletions + self.insertions

    @property
    def wer(self):
        # An empty reference has no rate to report. Returning 0.0 keeps a silent fixture from
        # aborting a whole benchmark run; the insertion count still records what was emitted.
        if self.ref_words == 0:
            return 0.0
        return self.errors / self.ref_words

    def as_dict(self):
        return {
            "wer": round(self.wer, 6),
            "substitutions": self.substitutions,
            "deletions": self.deletions,
            "insertions": self.insertions,
            "ref_words": self.ref_words,
            "errors": self.errors,
        }


def wer(reference, hypothesis):
    """Levenshtein alignment over normalised tokens. Accepts raw strings."""
    return wer_tokens(normalize(reference), normalize(hypothesis))


def wer_tokens(ref, hyp):
    """Same as `wer` for already-normalised token lists."""
    n, m = len(ref), len(hyp)

    # cost[i][j] = (edits, S, D, I) aligning ref[:i] with hyp[:j]. Full matrix rather than two
    # rows: meetings are a few thousand words, and keeping it lets us carry the S/D/I split.
    cost = [[(0, 0, 0, 0)] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        c, s, d, ins = cost[i - 1][0]
        cost[i][0] = (c + 1, s, d + 1, ins)
    for j in range(1, m + 1):
        c, s, d, ins = cost[0][j - 1]
        cost[0][j] = (c + 1, s, d, ins + 1)

    for i in range(1, n + 1):
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                cost[i][j] = cost[i - 1][j - 1]
                continue
            sub_c, sub_s, sub_d, sub_i = cost[i - 1][j - 1]
            del_c, del_s, del_d, del_i = cost[i - 1][j]
            ins_c, ins_s, ins_d, ins_i = cost[i][j - 1]
            best = min(sub_c, del_c, ins_c)
            if best == sub_c:
                cost[i][j] = (sub_c + 1, sub_s + 1, sub_d, sub_i)
            elif best == del_c:
                cost[i][j] = (del_c + 1, del_s, del_d + 1, del_i)
            else:
                cost[i][j] = (ins_c + 1, ins_s, ins_d, ins_i + 1)

    _, s, d, ins = cost[n][m]
    return WerResult(substitutions=s, deletions=d, insertions=ins, ref_words=n)
