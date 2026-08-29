# Eval Harness — Slice 1 (fixture format + AMI adapter + WER) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the shared core over a real AMI meeting and report a Word Error Rate, proving the whole measurement path end to end.

**Architecture:** A dependency-free Python harness in `eval/` that shells out to the already-built `audionotes_cli`, reads its `--json` document, and scores it against a corpus-agnostic fixture. AMI lives behind an adapter so nothing downstream knows it exists.

**Tech Stack:** Python 3.13 (stdlib only — no jiwer/numpy/pyannote), the existing `cpp/cli/build/audionotes_cli`, AMI Meeting Corpus (CC BY 4.0).

**Spec:** `docs/superpowers/specs/2026-08-24-phase1b-eval-harness-design.md`

**Scope:** Slice 1 of three. Diarization + performance (slice 2) and the LLM judge + MOM scoring (slice 3) get their own plans, written after this one lands so they benefit from what it teaches.

---

## Verified facts (already checked — do not re-derive)

- `https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/ES2002a/audio/ES2002a.Mix-Headset.wav` → 200, 38.8 MB
- `https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip` → 200, 21.8 MB, all 142 meetings
- Annotation layout inside that zip:
  - `words/<MEET>.<SPK>.words.xml` — `<w nite:id="..." starttime="77.44" endtime="77.74">Hi</w>`, punctuation tokens carry `punc="true"`
  - `segments/<MEET>.<SPK>.segments.xml` — `<segment transcriber_start="77.408" transcriber_end="80.955"><nite:child href="<MEET>.<SPK>.words.xml#id(<MEET>.<SPK>.words0)..id(<MEET>.<SPK>.words12)"/></segment>`
  - `abstractive/<MEET>.abssumm.xml` — `<abstract>`, `<decisions>`, `<actions>`, `<problems>`, each holding `<sentence>` elements
- Speakers for ES2002a are `A B C D`; files are encoded ISO-8859-1
- Models for the CLI live in the session scratchpad or re-download via URLs in `android/app/src/main/java/com/audionotes/data/ModelCatalog.kt`

---

### Task 1: Scaffold and the fixture contract

**Files:**
- Create: `eval/README.md`
- Create: `eval/tests/__init__.py` (empty)
- Create: `eval/__init__.py` (empty)
- Create: `eval/corpus/__init__.py` (empty)
- Create: `eval/metrics/__init__.py` (empty)
- Create: `.gitignore` entries

- [ ] **Step 1: Create the package skeleton**

```bash
mkdir -p eval/corpus eval/metrics eval/tests eval/fixtures eval/results
touch eval/__init__.py eval/corpus/__init__.py eval/metrics/__init__.py eval/tests/__init__.py
```

- [ ] **Step 2: Write `eval/README.md`**

```markdown
# eval/ — accuracy harness

Dev tooling. Never shipped, never linked into the app.

Runs the shared core over benchmark meetings and scores transcript / attribution / minutes /
speed. Design: `docs/superpowers/specs/2026-08-24-phase1b-eval-harness-design.md`.

## Run

    python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models <dir>

## Tests

    python3 -m unittest discover -s eval/tests -v

## Fixture format

One directory per meeting under `eval/fixtures/<meeting-id>/`:

| file | contents |
|---|---|
| `audio.wav` | 16 kHz mono PCM16 |
| `truth.json` | `{"audio_ms": N, "segments": [{"start_ms","end_ms","speaker","text"}]}` |
| `minutes.json` | `{"decisions": [...], "actions": [{"text","owner","due"}], "questions": [...]}` |
| `meta.json` | `{"source","licence","notes"}` |

`speaker` is an opaque label. Nothing downstream knows which corpus a fixture came from — that is
what lets your own recordings become a benchmark by writing these four files.
```

- [ ] **Step 3: Keep large artefacts out of git**

Append to the repo root `.gitignore`:

```
# eval harness: corpus audio + generated fixtures/results are large and re-derivable
eval/fixtures/*/audio.wav
eval/corpus/_cache/
eval/results/
```

- [ ] **Step 4: Verify the package imports**

Run: `python3 -c "import eval, eval.corpus, eval.metrics; print('ok')"`
Expected: `ok`

- [ ] **Step 5: Commit**

```bash
git add eval .gitignore
git commit -m "chore(eval): scaffold the accuracy harness package and fixture contract"
```

---

### Task 2: Text normalisation

The normaliser decides what counts as an error, so it is tested rule by rule before WER exists.

**Files:**
- Create: `eval/metrics/normalize.py`
- Create: `eval/tests/test_normalize.py`

- [ ] **Step 1: Write the failing test**

```python
# eval/tests/test_normalize.py
import unittest

from eval.metrics.normalize import normalize


class TestNormalize(unittest.TestCase):
    def test_lowercases_and_splits(self):
        self.assertEqual(normalize("Hello There"), ["hello", "there"])

    def test_strips_bracketed_non_speech(self):
        # AMI annotates events our transcript never emits; counting them would measure
        # annotation convention rather than transcription quality.
        self.assertEqual(normalize("hello [laugh] there <vocalsound>"), ["hello", "there"])

    def test_drops_punctuation_but_keeps_intra_word_apostrophes(self):
        self.assertEqual(normalize("don't, stop."), ["do", "not", "stop"])

    def test_expands_contractions(self):
        self.assertEqual(normalize("we'll it's I'm"), ["we", "will", "it", "is", "i", "am"])

    def test_removes_disfluencies_from_either_side(self):
        self.assertEqual(normalize("uh so um yeah"), ["so", "yeah"])

    def test_expands_digits_to_words(self):
        # Digits -> words, never the reverse: "twenty five" must match "25" token for token.
        self.assertEqual(normalize("25"), ["twenty", "five"])
        self.assertEqual(normalize("we ship 3 items"), ["we", "ship", "three", "items"])

    def test_leaves_large_numbers_alone(self):
        self.assertEqual(normalize("12345"), ["12345"])

    def test_empty_input(self):
        self.assertEqual(normalize(""), [])
        self.assertEqual(normalize("   "), [])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 -m unittest eval.tests.test_normalize -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.metrics.normalize'`

- [ ] **Step 3: Write the implementation**

```python
# eval/metrics/normalize.py
"""Text normalisation shared by every text metric.

Applied identically to reference and hypothesis. The rules here decide what counts as an error, so
each one is justified and tested; see the spec's WER section. Two are load-bearing:

* Disfluencies are deleted from BOTH sides. AMI annotates "uh"/"um" and Whisper mostly does not, so
  without this we would score annotation convention, not transcription quality — hundreds of
  spurious deletions per meeting.
* Digits expand to words rather than words collapsing to digits, so a reference "twenty five"
  matches a hypothesis "25" token for token instead of two tokens against one.
"""
import re
import unicodedata

# Deliberately small and explicit — an opaque list is impossible to audit when a number looks wrong.
CONTRACTIONS = {
    "don't": "do not", "doesn't": "does not", "didn't": "did not",
    "won't": "will not", "wouldn't": "would not", "can't": "can not",
    "couldn't": "could not", "shouldn't": "should not", "isn't": "is not",
    "aren't": "are not", "wasn't": "was not", "weren't": "were not",
    "haven't": "have not", "hasn't": "has not", "hadn't": "had not",
    "i'm": "i am", "i've": "i have", "i'll": "i will", "i'd": "i would",
    "you're": "you are", "you've": "you have", "you'll": "you will",
    "we're": "we are", "we've": "we have", "we'll": "we will",
    "they're": "they are", "they've": "they have", "they'll": "they will",
    "it's": "it is", "that's": "that is", "there's": "there is",
    "he's": "he is", "she's": "she is", "what's": "what is",
    "let's": "let us", "who's": "who is",
}

DISFLUENCIES = {"uh", "um", "mm", "hmm", "er", "erm", "mmhmm", "uhhuh", "mm-hmm", "uh-huh"}

_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
         "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
         "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

_BRACKETED = re.compile(r"\[[^\]]*\]|<[^>]*>|\{[^}]*\}")
_NOT_WORD = re.compile(r"[^\w\s']")
_WHITESPACE = re.compile(r"\s+")


def _int_to_words(n):
    """0-999 -> word tokens. Larger numbers are left as digits (see module docstring)."""
    if n < 20:
        return [_ONES[n]]
    if n < 100:
        tens, ones = divmod(n, 10)
        return [_TENS[tens]] + ([_ONES[ones]] if ones else [])
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        out = [_ONES[hundreds], "hundred"]
        if rest:
            out += _int_to_words(rest)
        return out
    return None


def normalize(text):
    """Return the comparable token list for `text`."""
    if not text:
        return []

    s = unicodedata.normalize("NFKC", text).lower()
    s = _BRACKETED.sub(" ", s)
    s = _NOT_WORD.sub(" ", s)

    tokens = []
    for raw in _WHITESPACE.split(s):
        tok = raw.strip("'")
        if not tok:
            continue
        expanded = CONTRACTIONS.get(tok)
        tokens.extend(expanded.split() if expanded else [tok])

    out = []
    for tok in tokens:
        if tok in DISFLUENCIES:
            continue
        if tok.isdigit():
            words = _int_to_words(int(tok))
            out.extend(words if words is not None else [tok])
        else:
            out.append(tok)
    return out
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python3 -m unittest eval.tests.test_normalize -v`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add eval/metrics/normalize.py eval/tests/test_normalize.py
git commit -m "feat(eval): text normalisation with per-rule tests"
```

---

### Task 3: Word Error Rate

**Files:**
- Create: `eval/metrics/wer.py`
- Create: `eval/tests/test_wer.py`

- [ ] **Step 1: Write the failing test**

```python
# eval/tests/test_wer.py
import unittest

from eval.metrics.wer import wer


class TestWer(unittest.TestCase):
    def test_perfect_match(self):
        r = wer("the cat sat", "the cat sat")
        self.assertEqual(r.errors, 0)
        self.assertEqual(r.wer, 0.0)
        self.assertEqual(r.ref_words, 3)

    def test_single_substitution(self):
        r = wer("the cat sat", "the dog sat")
        self.assertEqual((r.substitutions, r.deletions, r.insertions), (1, 0, 0))
        self.assertAlmostEqual(r.wer, 1 / 3)

    def test_single_deletion(self):
        r = wer("the cat sat", "the sat")
        self.assertEqual((r.substitutions, r.deletions, r.insertions), (0, 1, 0))

    def test_single_insertion(self):
        r = wer("the cat sat", "the cat sat down")
        self.assertEqual((r.substitutions, r.deletions, r.insertions), (0, 0, 1))

    def test_empty_hypothesis_is_all_deletions(self):
        r = wer("the cat sat", "")
        self.assertEqual(r.deletions, 3)
        self.assertEqual(r.wer, 1.0)

    def test_empty_reference_reports_zero_rate_not_a_crash(self):
        # A silent reference cannot have a rate; guard the divide rather than blowing up mid-run.
        r = wer("", "hello")
        self.assertEqual(r.ref_words, 0)
        self.assertEqual(r.insertions, 1)
        self.assertEqual(r.wer, 0.0)

    def test_normalisation_is_applied(self):
        # Differs only by punctuation, casing, a disfluency and digit form.
        r = wer("We ship 25 units.", "uh we ship twenty five units")
        self.assertEqual(r.errors, 0)

    def test_wer_can_exceed_one(self):
        r = wer("hello", "hello hello hello")
        self.assertGreater(r.wer, 1.0)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run it to verify it fails**

Run: `python3 -m unittest eval.tests.test_wer -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.metrics.wer'`

- [ ] **Step 3: Write the implementation**

```python
# eval/metrics/wer.py
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
    ref = normalize(reference)
    hyp = normalize(hypothesis)
    return wer_tokens(ref, hyp)


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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python3 -m unittest eval.tests.test_wer -v`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add eval/metrics/wer.py eval/tests/test_wer.py
git commit -m "feat(eval): word error rate with S/D/I breakdown"
```

---

### Task 4: AMI adapter

**Files:**
- Create: `eval/corpus/ami.py`
- Create: `eval/tests/test_ami.py`
- Create: `eval/tests/data/ES9999a.A.words.xml`
- Create: `eval/tests/data/ES9999a.A.segments.xml`
- Create: `eval/tests/data/ES9999a.abssumm.xml`

- [ ] **Step 1: Write the miniature AMI fixtures the test parses**

`eval/tests/data/ES9999a.A.words.xml`:
```xml
<?xml version="1.0" encoding="ISO-8859-1" standalone="yes"?>
<nite:root nite:id="ES9999a.A.words" xmlns:nite="http://nite.sourceforge.net/">
   <w nite:id="ES9999a.A.words0" starttime="1.00" endtime="1.30">Hi</w>
   <w nite:id="ES9999a.A.words1" starttime="1.30" endtime="1.30" punc="true">,</w>
   <w nite:id="ES9999a.A.words2" starttime="1.30" endtime="1.80">I&#39;m</w>
   <w nite:id="ES9999a.A.words3" starttime="1.80" endtime="2.20">David</w>
   <w nite:id="ES9999a.A.words4" starttime="9.00" endtime="9.40">Right</w>
</nite:root>
```

`eval/tests/data/ES9999a.A.segments.xml`:
```xml
<?xml version="1.0" encoding="ISO-8859-1" standalone="yes"?>
<nite:root nite:id="ES9999a.A.segs" xmlns:nite="http://nite.sourceforge.net/">
   <segment nite:id="ES9999a.sync.1" transcriber_start="1.00" transcriber_end="2.20">
      <nite:child href="ES9999a.A.words.xml#id(ES9999a.A.words0)..id(ES9999a.A.words3)"/>
   </segment>
   <segment nite:id="ES9999a.sync.2" transcriber_start="9.00" transcriber_end="9.40">
      <nite:child href="ES9999a.A.words.xml#id(ES9999a.A.words4)"/>
   </segment>
</nite:root>
```

`eval/tests/data/ES9999a.abssumm.xml`:
```xml
<?xml version="1.0" encoding="ISO-8859-1" standalone="yes"?>
<nite:root xmlns:nite="http://nite.sourceforge.net/">
<abstract nite:id="ES9999a.x.abstract.1">
<sentence nite:id="ES9999a.x.s.1">The team met.</sentence>
</abstract>
<decisions nite:id="ES9999a.x.decisions.1">
<sentence nite:id="ES9999a.x.s.2">The remote will sell for 25 Euro.</sentence>
</decisions>
<actions nite:id="ES9999a.x.actions.1">
<sentence nite:id="ES9999a.x.s.3">The industrial designer will work on the design.</sentence>
</actions>
<problems nite:id="ES9999a.x.problems.1">
<sentence nite:id="ES9999a.x.s.4">Whether the budget covers a prototype.</sentence>
</problems>
</nite:root>
```

- [ ] **Step 2: Write the failing test**

```python
# eval/tests/test_ami.py
import os
import unittest

from eval.corpus.ami import parse_segments, parse_abstractive

DATA = os.path.join(os.path.dirname(__file__), "data")


class TestAmiAdapter(unittest.TestCase):
    def test_segments_carry_speaker_text_and_ms_timings(self):
        segs = parse_segments(DATA, "ES9999a", "A")
        self.assertEqual(len(segs), 2)
        first = segs[0]
        # Seconds -> ms, and the punctuation token is dropped rather than becoming a word.
        self.assertEqual(first["start_ms"], 1000)
        self.assertEqual(first["end_ms"], 2200)
        self.assertEqual(first["speaker"], "A")
        self.assertEqual(first["text"], "Hi I'm David")

    def test_single_word_segment_href_without_a_range(self):
        # Some segments reference one word: "#id(x)" with no "..id(y)". Mishandling this silently
        # drops real speech from the reference, which would flatter WER.
        segs = parse_segments(DATA, "ES9999a", "A")
        self.assertEqual(segs[1]["text"], "Right")

    def test_abstractive_maps_onto_our_minutes_shape(self):
        mins = parse_abstractive(DATA, "ES9999a")
        self.assertEqual(mins["decisions"], ["The remote will sell for 25 Euro."])
        self.assertEqual(mins["questions"], ["Whether the budget covers a prototype."])
        self.assertEqual(mins["actions"], [
            {"text": "The industrial designer will work on the design.", "owner": "", "due": ""}
        ])

    def test_abstract_section_is_not_treated_as_a_decision(self):
        mins = parse_abstractive(DATA, "ES9999a")
        self.assertNotIn("The team met.", mins["decisions"])


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 3: Run it to verify it fails**

Run: `python3 -m unittest eval.tests.test_ami -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'eval.corpus.ami'`

- [ ] **Step 4: Write the implementation**

```python
# eval/corpus/ami.py
"""AMI Meeting Corpus -> our fixture format.

AMI is CC BY 4.0 (https://groups.inf.ed.ac.uk/ami/corpus/license.shtml). Everything corpus-specific
lives in this file: nothing downstream knows AMI exists, which is what lets the user's own
recordings become a benchmark by writing the fixture files directly.

Caveat recorded into every fixture's meta.json and repeated in reports: AMI is 2000s meeting-room
audio, headset/far-field mics, mostly British/European accents, scenario-driven, no code-switching.
Good for detecting whether a change helped. Not evidence the product works for a phone on a table.
"""
import os
import re
import xml.etree.ElementTree as ET

NITE = "{http://nite.sourceforge.net/}"
_HREF_IDS = re.compile(r"id\(([^)]+)\)")

ANNOTATION_URL = "https://groups.inf.ed.ac.uk/ami/AMICorpusAnnotations/ami_public_manual_1.6.2.zip"
AUDIO_URL = ("https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus/"
             "{meeting}/audio/{meeting}.Mix-Headset.wav")


def _read(path):
    # The corpus ships ISO-8859-1; parsing it as UTF-8 raises on the first accented name.
    with open(path, "r", encoding="iso-8859-1") as f:
        return ET.fromstring(f.read())


def parse_words(data_dir, meeting, speaker):
    """Ordered [(word_id, text)] for one speaker, punctuation tokens excluded."""
    root = _read(os.path.join(data_dir, f"{meeting}.{speaker}.words.xml"))
    words = []
    for w in root.iter():
        if not w.tag.endswith("}w") and w.tag != "w":
            continue
        if w.get("punc") == "true":
            continue
        text = (w.text or "").strip()
        if text:
            words.append((w.get(f"{NITE}id"), text))
    return words


def parse_segments(data_dir, meeting, speaker):
    """Speaker-labelled segments with ms timings, in file order."""
    words = parse_words(data_dir, meeting, speaker)
    index = {wid: i for i, (wid, _) in enumerate(words)}

    root = _read(os.path.join(data_dir, f"{meeting}.{speaker}.segments.xml"))
    segments = []
    for seg in root.iter():
        if not (seg.tag.endswith("}segment") or seg.tag == "segment"):
            continue
        start = seg.get("transcriber_start")
        end = seg.get("transcriber_end")
        if start is None or end is None:
            continue

        ids = []
        for child in seg:
            ids.extend(_HREF_IDS.findall(child.get("href", "")))
        if not ids:
            continue
        # "#id(a)..id(b)" spans a range; "#id(a)" is a single word. Treating the second form as a
        # range of one is what keeps single-word segments from vanishing.
        first, last = ids[0], ids[-1]
        if first not in index or last not in index:
            continue
        text = " ".join(t for _, t in words[index[first]:index[last] + 1])
        if not text:
            continue
        segments.append({
            "start_ms": int(round(float(start) * 1000)),
            "end_ms": int(round(float(end) * 1000)),
            "speaker": speaker,
            "text": text,
        })
    return segments


def _sentences(root, tag):
    for node in root.iter():
        if node.tag.endswith("}" + tag) or node.tag == tag:
            out = []
            for s in node.iter():
                if s.tag.endswith("}sentence") or s.tag == "sentence":
                    text = " ".join((s.text or "").split())
                    if text:
                        out.append(text)
            return out
    return []


def parse_abstractive(data_dir, meeting):
    """AMI's abstractive summary -> our minutes shape.

    DECISIONS -> decisions, ACTIONS -> actions, PROBLEMS/ISSUES -> questions. The ABSTRACT section
    is prose about the meeting, not a decision, so it is deliberately not mapped: folding it in
    would inflate reference decision counts and depress recall for no reason.

    AMI does not annotate owner or due date, so both are empty and scoring treats an empty
    reference field as "not required" rather than as a miss.
    """
    root = _read(os.path.join(data_dir, f"{meeting}.abssumm.xml"))
    return {
        "decisions": _sentences(root, "decisions"),
        "actions": [{"text": t, "owner": "", "due": ""} for t in _sentences(root, "actions")],
        "questions": _sentences(root, "problems"),
    }


def speakers_for(data_dir, meeting):
    """Speaker letters that actually have segment files for this meeting."""
    found = []
    for name in sorted(os.listdir(data_dir)):
        m = re.fullmatch(rf"{re.escape(meeting)}\.([A-Z])\.segments\.xml", name)
        if m:
            found.append(m.group(1))
    return found
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `python3 -m unittest eval.tests.test_ami -v`
Expected: PASS, 4 tests

- [ ] **Step 6: Commit**

```bash
git add eval/corpus/ami.py eval/tests/test_ami.py eval/tests/data
git commit -m "feat(eval): AMI adapter — words/segments/abstractive into the fixture format"
```

---

### Task 5: Fixture builder

Turns a downloaded AMI meeting into `eval/fixtures/<id>/`. Kept separate from the adapter so the
parsing logic stays unit-testable without network or audio tooling.

**Files:**
- Create: `eval/corpus/build_fixture.py`

- [ ] **Step 1: Write the builder**

```python
# eval/corpus/build_fixture.py
"""Download one AMI meeting and write it out as a fixture.

    python3 -m eval.corpus.build_fixture ES2002a

Downloads are cached under eval/corpus/_cache (gitignored) so re-running is cheap. Audio is
converted to the 16 kHz mono PCM16 the CLI requires; AMI Mix-Headset is 16 kHz already, but the
conversion is unconditional so a corpus that is not gets handled the same way.
"""
import json
import os
import subprocess
import sys
import urllib.request
import zipfile

from eval.corpus import ami

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CACHE = os.path.join(ROOT, "eval", "corpus", "_cache")
FIXTURES = os.path.join(ROOT, "eval", "fixtures")

CAVEAT = ("AMI Meeting Corpus (CC BY 4.0). 2000s meeting-room audio, headset/far-field mics, "
          "mostly British/European accents, scenario-driven, no code-switching. A proxy for "
          "detecting regressions, NOT evidence the product works for in-person phone capture.")


def _download(url, dest):
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        print(f"cached  {os.path.basename(dest)}")
        return dest
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print(f"fetch   {url}")
    urllib.request.urlretrieve(url, dest)
    return dest


def ensure_annotations():
    """Fetch and unpack the (21.8 MB) annotation bundle covering all 142 meetings."""
    zip_path = _download(ami.ANNOTATION_URL, os.path.join(CACHE, "ami_annotations.zip"))
    out = os.path.join(CACHE, "annotations")
    if not os.path.isdir(os.path.join(out, "words")):
        with zipfile.ZipFile(zip_path) as z:
            z.extractall(out)
    return out


def _flatten(annotations_dir, meeting):
    """Copy the meeting's XML into one flat directory, which is what the adapter expects."""
    flat = os.path.join(CACHE, "flat", meeting)
    os.makedirs(flat, exist_ok=True)
    for sub in ("words", "segments"):
        src_dir = os.path.join(annotations_dir, sub)
        for name in os.listdir(src_dir):
            if name.startswith(meeting + "."):
                dst = os.path.join(flat, name)
                if not os.path.exists(dst):
                    with open(os.path.join(src_dir, name), "rb") as s, open(dst, "wb") as d:
                        d.write(s.read())
    abs_src = os.path.join(annotations_dir, "abstractive", f"{meeting}.abssumm.xml")
    abs_dst = os.path.join(flat, f"{meeting}.abssumm.xml")
    if os.path.exists(abs_src) and not os.path.exists(abs_dst):
        with open(abs_src, "rb") as s, open(abs_dst, "wb") as d:
            d.write(s.read())
    return flat


def build(meeting):
    annotations = ensure_annotations()
    flat = _flatten(annotations, meeting)

    speakers = ami.speakers_for(flat, meeting)
    if not speakers:
        raise SystemExit(f"no speaker segment files for {meeting}")

    segments = []
    for spk in speakers:
        segments.extend(ami.parse_segments(flat, meeting, spk))
    segments.sort(key=lambda s: s["start_ms"])
    if not segments:
        raise SystemExit(f"no segments parsed for {meeting}")

    out_dir = os.path.join(FIXTURES, meeting)
    os.makedirs(out_dir, exist_ok=True)

    raw_audio = _download(ami.AUDIO_URL.format(meeting=meeting),
                          os.path.join(CACHE, "audio", f"{meeting}.Mix-Headset.wav"))
    audio_path = os.path.join(out_dir, "audio.wav")
    subprocess.run(
        ["afconvert", "-f", "WAVE", "-d", "LEI16@16000", "-c", "1", raw_audio, audio_path],
        check=True)

    audio_ms = int(os.path.getsize(audio_path) / 32)  # 16 kHz * 2 bytes = 32 bytes per ms
    _write(os.path.join(out_dir, "truth.json"), {"audio_ms": audio_ms, "segments": segments})
    _write(os.path.join(out_dir, "minutes.json"), ami.parse_abstractive(flat, meeting))
    _write(os.path.join(out_dir, "meta.json"),
           {"source": "ami", "meeting": meeting, "speakers": speakers,
            "licence": "CC BY 4.0", "notes": CAVEAT})

    words = sum(len(s["text"].split()) for s in segments)
    print(f"\n{meeting}: {len(segments)} segments, {len(speakers)} speakers, {words} words, "
          f"{audio_ms / 1000:.0f}s audio -> {out_dir}")


def _write(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
        f.write("\n")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("usage: python3 -m eval.corpus.build_fixture <MEETING-ID>  e.g. ES2002a")
    build(sys.argv[1])
```

- [ ] **Step 2: Build the first real fixture**

Run: `python3 -m eval.corpus.build_fixture ES2002a`
Expected: downloads ~22 MB of annotations and ~39 MB of audio, then prints something close to
`ES2002a: 300+ segments, 4 speakers, 3000+ words, ~1160s audio -> eval/fixtures/ES2002a`

- [ ] **Step 3: Sanity-check the fixture by eye**

```bash
python3 -c "
import json
t=json.load(open('eval/fixtures/ES2002a/truth.json'))
m=json.load(open('eval/fixtures/ES2002a/minutes.json'))
print('audio_ms', t['audio_ms'], 'segments', len(t['segments']))
print('speakers', sorted({s[\"speaker\"] for s in t['segments']}))
print('first', t['segments'][0])
print('decisions', len(m['decisions']), '| actions', len(m['actions']), '| questions', len(m['questions']))
print('sample decision:', m['decisions'][0] if m['decisions'] else '(none)')
"
```
Expected: four speakers `['A','B','C','D']`, a first segment whose text reads like real speech with
sensible ms timings, and a non-empty decisions list.

Stop and investigate if segment timings exceed `audio_ms`, or if any list is empty — either means
the adapter is mis-parsing and every downstream number would be wrong.

- [ ] **Step 4: Confirm the audio is what the CLI needs**

Run: `afinfo eval/fixtures/ES2002a/audio.wav | grep -E "Data format|duration"`
Expected: `1 ch, 16000 Hz, Int16` and a duration matching `audio_ms` above.

- [ ] **Step 5: Commit (the builder and the small JSON, not the audio)**

```bash
git add eval/corpus/build_fixture.py eval/fixtures/ES2002a/truth.json \
        eval/fixtures/ES2002a/minutes.json eval/fixtures/ES2002a/meta.json
git commit -m "feat(eval): AMI fixture builder + the ES2002a benchmark fixture"
```

---

### Task 6: Run the core and report WER

**Files:**
- Create: `eval/run.py`
- Create: `eval/report.py`

- [ ] **Step 1: Write the report renderer**

```python
# eval/report.py
"""Render a run's results as markdown.

Every report repeats the corpus caveat. A number without its provenance invites being quoted as
"our WER is X", which for a proxy corpus would be misleading.
"""


def render(results):
    lines = ["# Eval run", "", f"- run id: `{results['run_id']}`",
             f"- cli: `{results['cli']}`", ""]

    lines += ["## Summary", "",
              "| fixture | source | audio | WER | S | D | I | ref words |",
              "|---|---|---:|---:|---:|---:|---:|---:|"]
    for r in results["fixtures"]:
        w = r["wer"]
        lines.append(
            f"| {r['id']} | {r['source']} | {r['audio_ms'] / 1000:.0f}s | "
            f"{w['wer'] * 100:.1f}% | {w['substitutions']} | {w['deletions']} | "
            f"{w['insertions']} | {w['ref_words']} |")

    total_err = sum(r["wer"]["errors"] for r in results["fixtures"])
    total_ref = sum(r["wer"]["ref_words"] for r in results["fixtures"])
    overall = (total_err / total_ref) if total_ref else 0.0
    lines += ["", f"**Overall WER: {overall * 100:.1f}%** "
                  f"({total_err} errors over {total_ref} reference words)", ""]

    caveats = sorted({r["notes"] for r in results["fixtures"] if r.get("notes")})
    if caveats:
        lines += ["## Corpus caveats", ""] + [f"- {c}" for c in caveats] + [""]
    return "\n".join(lines)
```

- [ ] **Step 2: Write the runner**

```python
# eval/run.py
"""Run the core over every fixture and score it.

    python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models <dir>

`--models` holds ggml-base-q5_1.bin, silero_vad.onnx, diar_segmentation.onnx, diar_embedding.onnx
(the same files ModelCatalog.kt downloads on Android).
"""
import argparse
import datetime
import json
import os
import subprocess
import sys

from eval.metrics.wer import wer_tokens
from eval.metrics.normalize import normalize
from eval import report

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run_cli(cli, models, fixture_dir, out_json):
    """Invoke the shared core. Returns the parsed --json document."""
    cmd = [cli,
           os.path.join(models, "ggml-base-q5_1.bin"),
           os.path.join(fixture_dir, "audio.wav"),
           "--vad", os.path.join(models, "silero_vad.onnx"),
           "--json", out_json]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.exists(out_json):
        sys.stderr.write(proc.stderr[-2000:] + "\n")
        raise SystemExit(f"CLI failed for {fixture_dir} (exit {proc.returncode})")
    with open(out_json) as f:
        return json.load(f)


def score(fixture_dir, doc):
    with open(os.path.join(fixture_dir, "truth.json")) as f:
        truth = json.load(f)
    with open(os.path.join(fixture_dir, "meta.json")) as f:
        meta = json.load(f)

    # Whole-meeting WER: concatenate in time order on both sides. Segment-level alignment would
    # need the hypothesis split to match the reference split, which it never does.
    ref_tokens = []
    for seg in sorted(truth["segments"], key=lambda s: s["start_ms"]):
        ref_tokens.extend(normalize(seg["text"]))
    hyp_tokens = []
    for utt in sorted(doc.get("transcript", []), key=lambda u: u["start_ms"]):
        hyp_tokens.extend(normalize(utt["text"]))

    return {
        "id": os.path.basename(fixture_dir.rstrip("/")),
        "source": meta.get("source", "unknown"),
        "notes": meta.get("notes", ""),
        "audio_ms": truth["audio_ms"],
        "wer": wer_tokens(ref_tokens, hyp_tokens).as_dict(),
        "timings": doc.get("timings", {}),
        "utterances": len(doc.get("transcript", [])),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cli", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--fixtures", default=os.path.join(ROOT, "eval", "fixtures"))
    ap.add_argument("--only", help="run a single fixture id")
    args = ap.parse_args()

    run_id = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = os.path.join(ROOT, "eval", "results", run_id)
    os.makedirs(out_dir, exist_ok=True)

    ids = sorted(d for d in os.listdir(args.fixtures)
                 if os.path.isdir(os.path.join(args.fixtures, d)))
    if args.only:
        ids = [i for i in ids if i == args.only]
    if not ids:
        raise SystemExit("no fixtures found — run: python3 -m eval.corpus.build_fixture ES2002a")

    results = {"run_id": run_id, "cli": args.cli, "fixtures": []}
    for fid in ids:
        fixture_dir = os.path.join(args.fixtures, fid)
        if not os.path.exists(os.path.join(fixture_dir, "audio.wav")):
            print(f"skip {fid}: audio.wav missing (gitignored; rebuild the fixture)")
            continue
        print(f"running {fid} …")
        doc = run_cli(args.cli, args.models, fixture_dir,
                      os.path.join(out_dir, f"{fid}.cli.json"))
        r = score(fixture_dir, doc)
        results["fixtures"].append(r)
        print(f"  WER {r['wer']['wer'] * 100:.1f}%  "
              f"({r['wer']['errors']}/{r['wer']['ref_words']} words)")

    with open(os.path.join(out_dir, "results.json"), "w") as f:
        json.dump(results, f, indent=1)
    md = report.render(results)
    with open(os.path.join(out_dir, "report.md"), "w") as f:
        f.write(md)
    print("\n" + md)


if __name__ == "__main__":
    main()
```

- [ ] **Step 3: Run the whole suite of harness tests**

Run: `python3 -m unittest discover -s eval/tests -v`
Expected: PASS, 20 tests (8 normalize + 8 wer + 4 ami)

- [ ] **Step 4: Run the harness end to end**

```bash
S=<scratchpad-with-models>   # see memory/portable-core.md
python3 -m eval.run --cli cpp/cli/build/audionotes_cli --models $S --only ES2002a
```
Expected: `running ES2002a …`, a WER line, then the markdown report. ES2002a is ~19 minutes of
audio, so whisper-base will take several minutes.

**Interpreting the number:** published whisper-base WER on AMI headset audio sits around 20-30%.
A result in that region means the path is sound. Above ~60% means something structural is wrong —
check first whether the hypothesis is far shorter than the reference (VAD dropping speech), which
the D count in the report will show.

- [ ] **Step 5: Commit**

```bash
git add eval/run.py eval/report.py
git commit -m "feat(eval): runner + markdown report — first WER over a real AMI meeting"
```

---

### Task 7: Record the baseline and wrap up

- [ ] **Step 1: Save the run as the reference point Phase 2 measures against**

```bash
cp eval/results/<run-id>/report.md docs/superpowers/eval-baseline-whisper-base.md
git add docs/superpowers/eval-baseline-whisper-base.md
git commit -m "docs(eval): baseline WER for whisper-base on AMI ES2002a"
```

- [ ] **Step 2: Update the harness README with the real numbers observed**

Add to `eval/README.md` under a `## Baseline` heading: the fixture, the model, the WER, and the
date. Future readers need to know what "normal" looks like to spot when a run is broken.

- [ ] **Step 3: Update memory**

Edit `~/.claude/projects/-Users-akshayghosh-ReactNative-InnoCoreLabs-Verbale/memory/portable-core.md`:
Phase 1b slice 1 done, the AMI URLs and sizes above, the baseline WER, and that slices 2 (DER +
perf) and 3 (LLM judge + MOM) still need their plans.

- [ ] **Step 4: Verify the tree is clean and everything passes**

```bash
python3 -m unittest discover -s eval/tests
git status --short
```
Expected: all tests pass; no unexpected modified files (fixture audio and results stay ignored).

---

## Self-review notes (already applied)

- **Spec coverage:** fixture format §4 → Task 1/5; AMI adapter §4.1 → Task 4; WER §5.1 → Tasks 2-3;
  outputs §6 → Task 6; harness tests §7 → Tasks 2/3/4. Slice-1 scope per §8. DER/perf/MOM (§5.2,
  §5.3, §5.5) are deliberately out — slices 2 and 3.
- **The spec's one open item is closed:** AMI URLs, sizes and annotation formats were verified
  before writing this plan, so Task 5 downloads a known-good URL rather than exploring.
- **Type consistency:** `normalize()` returns tokens and is consumed by `wer_tokens()`; `wer()`
  wraps it for raw strings; `WerResult.as_dict()` is the only shape `report.py` and `results.json`
  read. Fixture keys (`start_ms`/`end_ms`/`speaker`/`text`) are identical in the adapter, the
  builder and the scorer.
- **Known sharp edge:** `run.py` scores whole-meeting concatenated WER. That is correct for a
  transcript-quality number but cannot attribute errors to a moment in the meeting. Per-segment
  attribution needs the alignment path from slice 2's DER work; deliberately not built twice.
