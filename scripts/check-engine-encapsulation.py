#!/usr/bin/env python3
"""Fail if anything constructs an ASR engine by name instead of asking the factory.

This exists because of a real bug, not a hypothetical one. The Qwen3-ASR engine shipped compiled
into the app and completely unreachable: cpp/jni/audionotes_jni.cpp constructed WhisperAsr
directly, so the language could never select anything else. Every unit test passed, because the
JNI is not built by any desktop target — the code was dead in exactly the place no test looked.

A grep is a blunt instrument, but the invariant is a source-level one: "the mapping from language
to engine exists once, in asr_factory.cpp". Nothing a compiler checks can express that, and the
cost of it being wrong is a whole feature that silently does nothing.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The factory is where engines are named. whisper_asr.cpp and qwen3_asr.cpp define themselves.
ALLOWED = {
    os.path.join("cpp", "asr", "asr_factory.cpp"),
    os.path.join("cpp", "asr", "whisper_asr.cpp"),
    os.path.join("cpp", "asr", "qwen3_asr.cpp"),
    os.path.join("cpp", "asr", "sherpa_asr.cpp"),
}

# Tests name engines on purpose, to assert the contract each one declares — chunk budget, chunk
# mode, supported languages. That is the opposite of the bug this guards: it pins the values a
# production caller relies on rather than bypassing the choice between them.
ALLOWED_PREFIXES = (os.path.join("cpp", "tests") + os.sep,)

ENGINES = ("WhisperAsr", "Qwen3Asr", "SherpaAsr")
# A constructor call or a declaration, not a mention in a comment or a type in a header.
PATTERN = re.compile(r"^\s*(?:audionotes::)?(?:%s)\s+\w+\s*\(|new\s+(?:audionotes::)?(?:%s)\s*\("
                     % ("|".join(ENGINES), "|".join(ENGINES)))


def main():
    violations = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(ROOT, "cpp")):
        dirnames[:] = [d for d in dirnames if d != "third_party"]
        for name in filenames:
            if not name.endswith((".cpp", ".cc", ".h")):
                continue
            path = os.path.join(dirpath, name)
            rel = os.path.relpath(path, ROOT)
            if rel in ALLOWED or rel.startswith(ALLOWED_PREFIXES):
                continue
            with open(path, encoding="utf-8", errors="replace") as f:
                for lineno, line in enumerate(f, 1):
                    if line.lstrip().startswith("//"):
                        continue
                    if PATTERN.search(line):
                        violations.append(f"{rel}:{lineno}: {line.strip()}")

    if violations:
        print("An ASR engine is being constructed by name outside the factory:\n", file=sys.stderr)
        for v in violations:
            print("  " + v, file=sys.stderr)
        print("\nUse makeAsrEngine(AsrConfig) instead. Naming a class here is how Qwen3-ASR "
              "shipped unreachable: the language could never select it.", file=sys.stderr)
        return 1
    print("engine encapsulation OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
