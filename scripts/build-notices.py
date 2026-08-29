#!/usr/bin/env python3
"""
Generate src/legal/notices.ts — the open-source notices the app actually shows.

    ./scripts/build-notices.py

## Why generated

MIT, Apache-2.0, BSD-3-Clause and the OFL all require the licence text to travel with the software.
Shipping the string "MIT" next to a project name does not discharge that; it names the obligation
without meeting it. So the app has to carry the real text, and the real text has to be *right* —
which is the reason this is generated from the LICENSE files already vendored in the tree rather
than typed out. Copying a licence from memory is how a notice ends up subtly wrong, and a subtly
wrong notice is worse than an honest link because it looks discharged.

Every body below is read off disk. Where a dependency's licence file is not vendored (a Maven AAR,
a model downloaded at runtime), the body is still taken from an on-disk copy of the SAME licence —
these are standard texts, identical across projects — and only the copyright line differs.

Re-run after adding or removing a dependency.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src/legal/notices.ts"

# Where each licence body is read from, and how much of the head to drop to leave the body alone.
BODIES = {
    "MIT": ("cpp/third_party/whisper.cpp/LICENSE", r"^MIT License\s*\n\s*Copyright[^\n]*\n"),
    "Apache-2.0": ("cpp/third_party/sherpa-onnx/LICENSE", None),
    "BSD-3-Clause": ("node_modules/ieee754/LICENSE", r"^Copyright[^\n]*\n"),
    "OFL-1.1": ("assets/fonts/OFL.txt", r"^Copyright[^\n]*\n"),
}

# name, copyright holder, licence, what it does here, and whether it ships in the app or arrives
# as a downloaded model. The split matters: the models are redistributed from our own mirror, which
# is itself an act of distribution and carries the same obligation as bundling them would.
COMPONENTS = [
    ("whisper.cpp", "Copyright (c) 2023-2026 The ggml authors", "MIT",
     "Transcribes what was said, on the phone", "app"),
    ("llama.cpp", "Copyright (c) 2023-2026 The ggml authors", "MIT",
     "Runs the model that writes the minutes", "app"),
    ("ggml", "Copyright (c) 2023-2026 The ggml authors", "MIT",
     "The tensor library underneath both of the above", "app"),
    ("sherpa-onnx", "Copyright (c) 2022-2026 Xiaomi Corporation", "Apache-2.0",
     "Tells the speakers apart", "app"),
    ("ONNX Runtime", "Copyright (c) Microsoft Corporation", "MIT",
     "Runs the speech models", "app"),
    ("nlohmann/json", "Copyright (c) 2013-2026 Niels Lohmann", "MIT",
     "Carries results between the native core and the app", "app"),
    ("SQLCipher", "Copyright (c) 2008-2026 Zetetic LLC", "BSD-3-Clause",
     "Encrypts the meetings database", "app"),
    ("React Native", "Copyright (c) Meta Platforms, Inc. and affiliates", "MIT",
     "The app's user interface", "app"),
    ("React Navigation", "Copyright (c) 2017 React Navigation Contributors", "MIT",
     "Moving between screens", "app"),
    ("react-native-screens", "Copyright (c) 2018 Software Mansion", "MIT",
     "Native screen containers", "app"),
    ("react-native-svg", "Copyright (c) 2015-2026 react-native-svg authors", "MIT",
     "Draws the icons and the mascot", "app"),
    ("react-native-safe-area-context", "Copyright (c) 2019 Th3rd Wave", "MIT",
     "Keeps the layout clear of the notch", "app"),
    ("Zustand", "Copyright (c) 2019 Paul Henschel", "MIT", "Holds the app's state", "app"),
    ("Nunito", "Copyright 2014 The Nunito Project Authors", "OFL-1.1", "The typeface", "app"),

    ("Silero VAD", "Copyright (c) 2024 Silero Team", "MIT",
     "Finds the speech and skips the silence", "model"),
    ("Whisper", "Copyright (c) 2022 OpenAI", "MIT", "The transcription weights", "model"),
    ("pyannote segmentation 3.0", "Copyright (c) 2023 Herve Bredin", "MIT",
     "Hears when the speaker changes", "model"),
    ("3D-Speaker CAM++", "Copyright (c) 2023 Alibaba DAMO Academy", "Apache-2.0",
     "Groups the turns into speakers", "model"),
    ("Qwen2.5 1.5B Instruct", "Copyright (c) 2024 Alibaba Cloud", "Apache-2.0",
     "Writes the summary and the minutes", "model"),
]


def body(licence: str) -> str:
    path, strip = BODIES[licence]
    full = (ROOT / path)
    if not full.exists():
        raise SystemExit(
            f"cannot read the {licence} text from {path}.\n"
            "Vendored dependencies must be checked out (git submodule update --init) and\n"
            "node_modules installed before the notices can be generated."
        )
    text = full.read_text(encoding="utf-8").strip("\n")
    if strip:
        text = re.sub(strip, "", text, count=1, flags=re.MULTILINE).strip("\n")
    # Sanity: a body that lost its teeth is a body that no longer discharges anything.
    if len(text) < 400:
        raise SystemExit(f"the {licence} text read from {path} is suspiciously short ({len(text)} chars)")
    return text


def main() -> int:
    texts = {name: body(name) for name in BODIES}

    used = {c[2] for c in COMPONENTS}
    unknown = used - set(texts)
    if unknown:
        raise SystemExit(f"no text on disk for: {', '.join(sorted(unknown))}")
    unused = set(texts) - used
    if unused:
        print(f"note: {', '.join(sorted(unused))} has a text but no component using it")

    notices = [
        {"name": n, "by": by, "licence": lic, "used": used_for, "where": where}
        for n, by, lic, used_for, where in COMPONENTS
    ]

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        "/**\n"
        " * Open-source notices. GENERATED — do not edit.\n"
        " *\n"
        " *   ./scripts/build-notices.py\n"
        " *\n"
        " * MIT, Apache-2.0, BSD-3-Clause and the OFL all require their text to travel with the\n"
        " * software. Naming the licence does not discharge that, so the full text is here and is\n"
        " * read verbatim off the LICENSE files vendored in this repository — a licence copied from\n"
        " * memory is how a notice ends up subtly wrong, and subtly wrong is worse than absent\n"
        " * because it looks done.\n"
        " *\n"
        " * The models are listed too. We serve them from our own mirror, and serving them is\n"
        " * distribution just as bundling them would be.\n"
        " */\n\n"
        "export type LicenceId = " + " | ".join(f"'{k}'" for k in sorted(texts)) + ";\n\n"
        "export interface Notice {\n"
        "  name: string;\n"
        "  /** The copyright line the licence requires be reproduced. */\n"
        "  by: string;\n"
        "  licence: LicenceId;\n"
        "  /** What it does here, so the list reads as an explanation and not an inventory. */\n"
        "  used: string;\n"
        "  /** 'app' ships inside the download; 'model' arrives on first run. */\n"
        "  where: 'app' | 'model';\n"
        "}\n\n"
        "export const NOTICES: Notice[] = " + json.dumps(notices, indent=2, ensure_ascii=False) + ";\n\n"
        "export const LICENCE_TEXTS: Record<LicenceId, string> = {\n"
        + "".join(
            f"  '{name}': {json.dumps(text, ensure_ascii=False)},\n" for name, text in sorted(texts.items())
        )
        + "};\n",
        encoding="utf-8",
    )

    total = sum(len(t) for t in texts.values())
    print(f"wrote {OUT.relative_to(ROOT)}")
    print(f"  {len(notices)} components, {len(texts)} licence texts, {total:,} characters")
    for name, text in sorted(texts.items()):
        count = sum(1 for c in COMPONENTS if c[2] == name)
        print(f"    {name:14s} {len(text):6,d} chars   {count} component(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
