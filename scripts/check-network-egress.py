#!/usr/bin/env python3
"""Fail if anything opens a network connection outside the registered call sites.

The privacy screen counts every byte that leaves the phone, and it can only do that while there
are exactly four places a byte can leave from. Nothing a compiler checks can express "this app has
four network call sites"; a grep can, and the cost of being wrong is a screen that goes on
reporting confident numbers while quietly missing traffic — which is worse than having no screen
at all, because somebody would be relying on it.

Modelled on check-engine-encapsulation.py, which exists for the same reason: an invariant that
lives in the layout of the source rather than in its types.

    python3 scripts/check-network-egress.py
"""
import argparse
import os
import re
import sys

# The call sites that own this app's entire network access, plus the ledger seam they record
# through. Adding to this list is a deliberate act and should be argued for in review.
ALLOWED = {
    os.path.join("src", "billing", "subscription.ts"),
    os.path.join("src", "telemetry", "crash.ts"),
    os.path.join("src", "privacy", "ledger.ts"),
    os.path.join(
        "android", "app", "src", "main", "java", "com", "innocorelabs", "verbale",
        "pipeline", "ModelManagerModule.kt",
    ),
}

# Tests stub these on purpose, which is the opposite of the risk being guarded against.
ALLOWED_PREFIXES = (
    os.path.join("src", "privacy", "__tests__") + os.sep,
    os.path.join("src", "billing", "__tests__") + os.sep,
    os.path.join("src", "telemetry", "__tests__") + os.sep,
    os.path.join("scripts", "__tests__") + os.sep,
)

SEARCH_ROOTS = ("src", os.path.join("android", "app", "src", "main"))
EXTENSIONS = (".ts", ".tsx", ".kt", ".java")

PATTERN = re.compile(
    r"\bfetch\s*\(|\bXMLHttpRequest\b|\bopenConnection\s*\(|\bHttpURLConnection\b"
    r"|\bOkHttpClient\b|\bnew\s+Socket\s*\(|\bnew\s+WebSocket\s*\("
)

# A line that only talks ABOUT the rule is not a call. Comments are how this file's own reasoning
# gets written down next to the code it constrains, so tripping on them would be self-defeating.
COMMENT_STARTS = ("//", "*", "/*", "#")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        help="tree to check; defaults to the repository root",
    )
    args = parser.parse_args()
    root = args.root

    violations = []
    for search in SEARCH_ROOTS:
        base = os.path.join(root, search)
        if not os.path.isdir(base):
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [
                d for d in dirnames if d not in ("node_modules", "build", "__pycache__")
            ]
            for name in filenames:
                if not name.endswith(EXTENSIONS):
                    continue
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, root)
                if rel in ALLOWED or rel.startswith(ALLOWED_PREFIXES):
                    continue
                with open(path, encoding="utf-8", errors="replace") as f:
                    for lineno, line in enumerate(f, 1):
                        if line.lstrip().startswith(COMMENT_STARTS):
                            continue
                        if PATTERN.search(line):
                            violations.append(f"{rel}:{lineno}: {line.strip()}")

    if violations:
        print("A network call exists outside the registered call sites:\n", file=sys.stderr)
        for v in violations:
            print("  " + v, file=sys.stderr)
        print(
            "\nThe privacy screen claims to count every byte that leaves this phone. It can only\n"
            "do that while every byte leaves through a site that records to src/privacy/ledger.ts.\n"
            "Either record from the new site and add it to ALLOWED here, or route it through an\n"
            "existing one. Do not silence this without changing what the screen claims.",
            file=sys.stderr,
        )
        return 1
    print("network egress OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
