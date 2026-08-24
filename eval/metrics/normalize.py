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
