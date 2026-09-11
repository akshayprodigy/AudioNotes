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
#
# telemetry/crash.ts was here until crash reporting moved from Sentry to Crashlytics. It is not a
# call site any more: the previous SDK was driven from JavaScript, so the upload passed through a
# beforeSend hook that recorded its exact byte count, while Crashlytics assembles and sends reports
# from native Play Services code this app cannot reach. It counts for nothing here BECAUSE it can
# no longer be counted, which is a loss, not a tidy-up — and the privacy screen names it as an
# uncounted source for exactly that reason. See src/telemetry/crash.ts and PrivacyScreen.tsx.
ALLOWED = {
    os.path.join("src", "billing", "subscription.ts"),
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

    # EVERY DECLARED ROOT MUST EXIST, checked before anything is scanned.
    #
    # A total-scanned count is not enough and the first version of this check proved it: with six
    # roots, renaming one leaves `scanned` comfortably nonzero, so the guard never fires and the
    # checker reports success over a tree it is now blind in. That is the realistic shape — nobody
    # moves both at once — and it is how a directory rename silently disables a gate.
    #
    # EXISTENCE rather than a per-root file count, because the two fail on different things. A
    # declared root that is not there means it moved (the guard is blind wherever it went) or the
    # list is stale; both deserve a failure, so failing is right in every case. A root that exists
    # and holds no sources is legitimate — a directory emptied mid-refactor — and a per-root count
    # would reject it. The total below still catches every root existing and none holding a source.
    missing = [r for r in SEARCH_ROOTS if not os.path.isdir(os.path.join(root, r))]
    if missing:
        print(
            "SEARCH_ROOTS names a directory that is not there:\n  " + "\n  ".join(missing)
            + "\n\nThe privacy screen claims to count every byte that leaves this phone, and this\n"
              "check is blind wherever that code moved to. Point SEARCH_ROOTS in\n"
              "scripts/check-network-egress.py at the new location.",
            file=sys.stderr,
        )
        return 1

    violations = []
    scanned = 0
    for search in SEARCH_ROOTS:
        base = os.path.join(root, search)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [
                d for d in dirnames if d not in ("node_modules", "build", "__pycache__")
            ]
            for name in filenames:
                if not name.endswith(EXTENSIONS):
                    continue
                path = os.path.join(dirpath, name)
                rel = os.path.relpath(path, root)
                # Counted BEFORE the allowlist: a tree holding nothing but registered call sites
                # has still been examined, and only a tree with no sources at all has not.
                scanned += 1
                if rel in ALLOWED or rel.startswith(ALLOWED_PREFIXES):
                    continue
                with open(path, encoding="utf-8", errors="replace") as f:
                    for lineno, line in enumerate(f, 1):
                        if line.lstrip().startswith(COMMENT_STARTS):
                            continue
                        if PATTERN.search(line):
                            violations.append(f"{rel}:{lineno}: {line.strip()}")

    # Both roots are there and neither holds a source file. Rarer than a rename and the same
    # conclusion: a run that examined nothing is not a pass.
    if not scanned:
        print(
            "Every directory in SEARCH_ROOTS exists and not one holds a "
            + "/".join(EXTENSIONS)
            + " file, so this run examined nothing and is not a pass.",
            file=sys.stderr,
        )
        return 1

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
    print(f"network egress OK ({scanned} files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
