#!/usr/bin/env python3
"""Fail if the diarization constants disagree across the languages that share them.

Three of them are written down twice, in files a compiler will never compare:

    kDiarWindowMs      cpp/diar/span_map.h   <->  DiarBudget.WHOLE_MEETING       (Kotlin)
    16 kHz sample rate cpp (implicit)        <->  DiarBudget.BYTES_PER_MS        (Kotlin)
    kDiarPadMs         cpp/diar/span_map.h   <->  eval/speech_fraction.py        (reads the header)

The first is the one that bites. Diarizing a meeting in windows measured 6 DER points and 7 points
of attribution worse than diarizing it whole, so it is off — and "off" is spelled differently on
each side of the JNI call: 0 in C++, an explicit -1 from Kotlin. If either drifts, every phone
silently switches onto the worse path, and nothing fails: the app keeps working and simply starts
labelling speakers less accurately than anything anybody measured.

Modelled on check-engine-encapsulation.py and check-network-egress.py, which exist for the same
reason: an invariant that lives in the layout of the source rather than in its types.

    python3 scripts/check-diar-constants.py
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SPAN_MAP = os.path.join(ROOT, "cpp", "diar", "span_map.h")
DIAR_BUDGET = os.path.join(
    ROOT, "android", "app", "src", "main", "java", "com", "innocorelabs", "verbale",
    "pipeline", "DiarBudget.kt",
)
SPEECH_FRACTION = os.path.join(ROOT, "eval", "speech_fraction.py")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def cpp_constant(text, name):
    """`constexpr int64_t kName = <expr>;` — the expression may be arithmetic (10 * 60 * 1000)."""
    m = re.search(r"constexpr\s+int64_t\s+" + re.escape(name) + r"\s*=\s*([^;]+);", text)
    if not m:
        return None
    return arithmetic(m.group(1))


def kotlin_constant(text, name):
    """`const val NAME = <expr>` — Kotlin allows a trailing L on the literal."""
    m = re.search(r"const\s+val\s+" + re.escape(name) + r"\s*(?::\s*\w+)?\s*=\s*([^\n/]+)", text)
    if not m:
        return None
    return arithmetic(m.group(1).replace("L", "").replace("_", ""))


def arithmetic(expr):
    """Evaluate a constant expression, refusing anything that is not digits and * + - / ( )."""
    expr = expr.strip()
    if not re.fullmatch(r"[0-9\s*+\-/()]+", expr):
        return None
    try:
        return int(eval(expr, {"__builtins__": {}}, {}))  # noqa: S307 — pattern-restricted above
    except Exception:
        return None


def main():
    problems = []

    span_map = read(SPAN_MAP)
    budget = read(DIAR_BUDGET)

    # Windowing is OFF. Both sides have to agree on that, and they say it in different dialects:
    # C++ defaults kDiarWindowMs to 0, and Kotlin passes DiarBudget.WHOLE_MEETING = -1 explicitly.
    # Both mean "one pass over the whole meeting"; a non-zero kDiarWindowMs would silently switch
    # every phone onto the windowed path, which measured 6 DER points worse.
    window_cpp = cpp_constant(span_map, "kDiarWindowMs")
    whole_kt = kotlin_constant(budget, "WHOLE_MEETING")
    skip_kt = kotlin_constant(budget, "SKIP")
    if window_cpp is None:
        problems.append("could not find kDiarWindowMs in cpp/diar/span_map.h")
    elif window_cpp != 0:
        problems.append(
            f"kDiarWindowMs is {window_cpp} ms, so diarization would window by default.\n"
            "    Windowing is shelved: it measured DER 26.2-27.7 against 20.0 for one pass, because\n"
            "    reconciling speakers across windows from one averaged voice each is not accurate\n"
            "    enough. Turn it on deliberately with --diar-window-min, not by editing this."
        )
    if whole_kt is None:
        problems.append("could not find DiarBudget.WHOLE_MEETING")
    elif whole_kt >= 0:
        problems.append(
            f"DiarBudget.WHOLE_MEETING is {whole_kt}, but the native side reads a NEGATIVE window\n"
            "    as 'do not window'. A non-negative value here would window every meeting."
        )
    if skip_kt is not None and skip_kt != 0:
        problems.append(f"DiarBudget.SKIP is {skip_kt}; the skip path tests for 0.")

    # DiarBudget sizes its memory estimate from the capture rate. RecordingService.SAMPLE_RATE is
    # what the app actually records at, and the diarizer is handed that same rate.
    rate = re.search(r"BYTES_PER_MS\s*=\s*(\d+)L?\s*\*", budget)
    if not rate:
        problems.append("could not find DiarBudget.BYTES_PER_MS")
    elif int(rate.group(1)) != 16000:
        problems.append(
            f"DiarBudget.BYTES_PER_MS assumes {rate.group(1)} Hz, but the pipeline captures and "
            "diarizes at 16000 Hz.\n"
            "    The memory guard would then size every window against the wrong buffer."
        )

    # The pad is not duplicated — speech_fraction.py reads it out of the header at runtime, which
    # is the better answer. Check that the reader still finds it, so the measurement cannot start
    # silently describing a different build.
    pad = cpp_constant(span_map, "kDiarPadMs")
    if pad is None:
        problems.append("could not find kDiarPadMs in cpp/diar/span_map.h")
    else:
        sys.path.insert(0, ROOT)
        try:
            from eval.speech_fraction import pad_ms_from_header
            if pad_ms_from_header(SPAN_MAP) != pad:
                problems.append(
                    f"eval/speech_fraction.py reads kDiarPadMs as "
                    f"{pad_ms_from_header(SPAN_MAP)}, but the header says {pad}.\n"
                    "    Its parser has drifted from the declaration, so the measurement would "
                    "describe a padding the build does not use."
                )
        except Exception as e:  # the reader is the thing under test; a failure to import is one
            problems.append(f"eval/speech_fraction.py could not read the header: {e}")

    if problems:
        print("Diarization constants disagree across languages:\n", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        print(
            "\nThese are written down in more than one place because they cross a language\n"
            "boundary. Nothing else compares them, and the failure is silent: the app keeps\n"
            "working and simply stops matching what was measured.",
            file=sys.stderr,
        )
        return 1
    print(f"diarization constants OK (windowing off, pad {pad} ms)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
