"""Asking a local model whether our minutes captured what the meeting decided.

Three things here are deliberate:

*Batched.* Loading a 7B GGUF costs seconds and a meeting produces dozens of judgements, so every
question for a meeting is collected, asked in one process, and replayed. `score_minutes` is pure
given its judge, so it simply runs twice — once with a collector, once with the answers.

*Greedy.* The judge binary samples greedily. A score that moves between identical runs is not a
measurement.

*Unparseable means NO.* The dangerous default is YES: a judge whose output format drifts would
report perfect recall, and nothing downstream would look twice.
"""
import re
import subprocess

from eval.metrics.mom import CATEGORIES, Verdict, score_minutes

SEPARATOR = "%%PROMPT%%"
TERMINATOR = "%%END%%"

_VERDICT = re.compile(r"^\s*verdict\s*:\s*(yes|no)\b", re.I | re.M)
# A bare YES/NO alone on its line. Observed from Qwen2.5-7B on a terse prompt, and another judge
# may do the same; scoring that as unparseable would silently understate recall. Anything with
# prose around it stays unparseable — "yes, if you squint" is not a verdict.
_BARE = re.compile(r"^\s*(yes|no)\s*[.!]?\s*$", re.I | re.M)
_EVIDENCE = re.compile(r"^\s*evidence\s*:\s*(.*)$", re.I | re.M)

SINGULAR = {"decisions": "decision", "actions": "action item", "questions": "open question"}


def parse_verdict(text):
    m = _VERDICT.search(text or "") or _BARE.search(text or "")
    if not m:
        return Verdict(False, note=f"unparseable judge output: {(text or '')[:120]!r}")
    evidence = ""
    e = _EVIDENCE.search(text)
    if e:
        evidence = e.group(1).strip()
        if evidence.upper() in ("NONE", "N/A", ""):
            evidence = ""
    return Verdict(m.group(1).lower() == "yes", evidence)


def render_minutes(produced):
    out = []
    for category in CATEGORIES:
        items = produced.get(category) or []
        out.append(category.upper())
        if not items:
            out.append("  (none produced)")
        for item in items:
            if isinstance(item, dict):
                extra = " ".join(x for x in [f"owner: {item['owner']}" if item.get("owner") else "",
                                             f"due: {item['due']}" if item.get("due") else ""] if x)
                out.append(f"  - {item['text']}" + (f"   [{extra}]" if extra else ""))
            else:
                out.append(f"  - {item}")
    return "\n".join(out)


def capture_prompt(item, category, produced):
    return f"""You are grading the minutes a system produced for a meeting.

REFERENCE {SINGULAR[category].upper()} — this really happened in the meeting:
{item}

MINUTES THE SYSTEM PRODUCED:
{render_minutes(produced)}

Did the produced minutes capture that reference item? The wording will differ: the reference is
a summary, the minutes often quote the meeting directly. Count it as captured if a produced line
conveys the same {SINGULAR[category]}, even in different words. Do not count a line that is
merely on the same topic.

Reply with exactly two lines:
VERDICT: YES or NO
EVIDENCE: the produced line that captures it, or NONE"""


def support_prompt(item, category, transcript):
    return f"""You are checking a meeting-minutes system for invented content.

TRANSCRIPT OF WHAT WAS ACTUALLY SAID:
{transcript}

{SINGULAR[category].upper()} THE SYSTEM CLAIMS:
{item}

Is that claim supported by the transcript? Answer NO if it asserts something the transcript does
not say, even if it sounds plausible for this meeting.

Reply with exactly two lines:
VERDICT: YES or NO
EVIDENCE: the transcript sentence that supports it, or NONE"""


BATCH_CLAIMS = 20   # keeps the answer well inside max_tokens and the prompt inside the context


def support_batch_prompt(items, category, transcript):
    """Every claim in one prompt, so the transcript is read once instead of once per claim.

    Measured at ~9k tokens of prefill per support prompt against a full AMI transcript: asking
    per item turned a minute of work into an hour.
    """
    numbered = "\n".join(f"{i}. {item}" for i, item in enumerate(items, 1))
    return f"""You are checking a meeting-minutes system for invented content.

TRANSCRIPT OF WHAT WAS ACTUALLY SAID:
{transcript}

{SINGULAR[category].upper()}S THE SYSTEM CLAIMS:
{numbered}

For EACH numbered claim, is it supported by the transcript? Answer NO if it asserts something
the transcript does not say, even if it sounds plausible for this meeting.

Reply with exactly {len(items)} lines, nothing else:
1: YES or NO
2: YES or NO
... one line per claim, in the same order."""


def parse_batch_verdicts(text, n):
    """-> exactly `n` verdicts. A line the model omitted becomes NO rather than shifting every
    later claim onto the wrong answer."""
    found = {}
    for m in re.finditer(r"^\s*(\d+)\s*[:.)-]\s*(yes|no)\b", text or "", re.I | re.M):
        found[int(m.group(1))] = m.group(2).lower() == "yes"
    out = []
    for i in range(1, n + 1):
        if i in found:
            out.append(Verdict(found[i]))
        else:
            out.append(Verdict(False, note=f"unparseable judge output for claim {i}"))
    return out


def _norm(s):
    return " ".join(re.sub(r"[^\w\s]", " ", (s or "").lower()).split())


class _Collector:
    """Pass one: record every question, answer nothing.

    Capture questions stay per-item (the minutes are short, so the prompt is cheap). Support
    questions are collected per category and asked together, because each one would otherwise
    carry the whole transcript.
    """

    def __init__(self):
        self.prompts = []
        self.support = {}

    def captures(self, item, category, produced):
        self.prompts.append(capture_prompt(item, category, produced))
        return Verdict(False)

    def supported(self, item, category, transcript):
        if _norm(item) and _norm(item) in _norm(transcript):
            return Verdict(True, note="verbatim")     # answered without the model, see _Replay
        self.support.setdefault(category, []).append(item)
        return Verdict(False)


class _Replay:
    """Pass two: hand back the answers in the order the questions were asked."""

    def __init__(self, answers):
        self._answers = list(answers)
        self._i = 0

    def _next(self):
        if self._i >= len(self._answers):
            return Verdict(False, note="no answer returned for this question")
        v = parse_verdict(self._answers[self._i])
        self._i += 1
        return v

    def captures(self, item, category, produced):
        return self._next()

    def supported(self, item, category, transcript):
        if _norm(item) and _norm(item) in _norm(transcript):
            return Verdict(True, note="verbatim in transcript")
        return self._next()


class BatchedJudge:
    """`run(prompts) -> [completion]`. Injected so the arithmetic is testable without a model."""

    # A support prompt carries the whole ground-truth transcript, and a long meeting will not fit
    # a judge's context. Truncating it silently would turn "the model could not see that part"
    # into "the system invented this", so an over-long transcript disables the support check and
    # says so instead.
    # ~4 chars per token, so 40k chars is ~10k tokens — comfortable inside the 16k context the
    # runner asks for, with room for the instructions and the answer. Set from measurement: AMI
    # meeting transcripts here run 13k-35k chars, and the first pass at 12k silently skipped the
    # support check on three fixtures out of four.
    def __init__(self, run, max_transcript_chars=40000):
        self._run = run
        self._max = max_transcript_chars

    def score(self, reference, doc, transcript="", own_transcript=""):
        skipped = ""
        if transcript and len(transcript) > self._max:
            skipped = (f"transcript is {len(transcript)} chars, over the {self._max} the judge "
                       f"can see at once — support/hallucination not checked for this fixture")
            transcript = ""
        collector = _Collector()
        score_minutes(reference, doc, collector, transcript, own_transcript)

        answers = list(self._run(collector.prompts)) if collector.prompts else []

        # score_minutes asks all capture questions first, then all support questions in CATEGORIES
        # order, so the support answers are appended in exactly that order.
        for category in CATEGORIES:
            items = collector.support.get(category) or []
            for start in range(0, len(items), BATCH_CLAIMS):
                chunk = items[start:start + BATCH_CLAIMS]
                reply = self._run([support_batch_prompt(chunk, category, transcript)])[0]
                answers.extend("1: YES" if v.matched else "1: NO"
                               for v in parse_batch_verdicts(reply, len(chunk)))

        result = score_minutes(reference, doc, _Replay(answers), transcript, own_transcript)
        result["notes"] = [skipped] if skipped else []
        return result


def local_runner(binary, model, ctx=16384, threads=0, max_tokens=192, timeout=7200):
    """A `run` backed by the audionotes_judge binary — one process for the whole batch."""

    def run(prompts):
        payload = f"\n{SEPARATOR}\n".join(prompts)
        cmd = [binary, model, "--ctx", str(ctx), "--max-tokens", str(max_tokens)]
        if threads:
            cmd += ["--threads", str(threads)]
        proc = subprocess.run(cmd, input=payload, capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0:
            raise SystemExit(f"judge failed (exit {proc.returncode}):\n{proc.stderr[-2000:]}")
        answers = [a.strip() for a in proc.stdout.split(TERMINATOR)]
        answers = [a for a in answers if a]
        if len(answers) != len(prompts):
            raise SystemExit(
                f"judge returned {len(answers)} answers for {len(prompts)} prompts — refusing to "
                f"score, because misaligned answers would attribute one item's verdict to another")
        return answers

    return run
