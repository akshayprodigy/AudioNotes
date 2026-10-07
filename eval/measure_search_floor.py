#!/usr/bin/env python3
"""F25: measure the cosine distribution of meaning search before choosing a relevance floor.

Passages: the AMI fixtures' truth transcripts, chunked exactly as the app does
(SearchChunker.kt: consecutive turns merged up to 100 words, never across a silence over 30 s),
plus the fixture's minutes items (decisions / actions / questions) as short `item` passages, the
way Embedder.wanted adds them. Vectors come from the app's own EmbedEngine (cpp/llm), built into
a throwaway tool (cpp/tests/embed_dump.cpp) against the libraries already in cpp/cli/build, and
stored the way the app stores them (int8 + one float scale, VecCodec.encode) so the dot product is
the one `AudioDb.meaningHits` computes: query float vector . quantised passage vector.

Queries: QUERIES below, hand-written. LABELLING RULE: for every query I read all passages and
listed the ones that substantively address the query's topic (a passing mention does not count; a
minutes item that states the topic counts). A query with an empty list has NO relevant passage in
the set -- the "pricing in the A07" case, where a search returned a ≈ row that had nothing to do
with it. Those judge the floor on rejecting noise. Anything unlabelled is counted irrelevant, so a
passage that is really on topic but unlabelled makes a floor look worse than it is.

    python3 eval/measure_search_floor.py --work <dir> [--model <gguf>] [--md]

Standard library only. Sets no threshold; prints the distributions and, for candidate floors, what
each keeps and rejects.
"""
import argparse
import json
import math
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = ["ES2002a", "ES2002b", "ES2003a", "IS1000a"]
MAX_WORDS, MAX_GAP_MS = 100, 30_000  # SearchChunker.MAX_WORDS / MAX_GAP_MS
FLOORS = [round(0.30 + 0.025 * i, 3) for i in range(0, 21)]  # 0.30 .. 0.80
MEANING_TOP = 40  # AudioDb.MEANING_TOP

MEETING = {"a": "ES2002a", "b": "ES2002b", "c": "ES2003a", "d": "IS1000a"}


def L(spec):
    """'a:9 10 item0; b:38' -> {'ES2002a#9', 'ES2002a#10', 'ES2002a#item0', 'ES2002b#38'}."""
    out = set()
    for part in filter(None, (x.strip() for x in spec.split(";"))):
        m, rest = part.split(":")
        out |= {f"{MEETING[m.strip()]}#{i}" for i in rest.split()}
    return out


# (name, query, relevant passage ids). Ids are "<meeting>#<chunk index>" for transcript chunks and
# "<meeting>#item<n>" for the minutes items; a=ES2002a b=ES2002b c=ES2003a d=IS1000a. Every list
# was written by reading all 214 passages (a regex only found candidates; the substring traps and
# passing mentions it threw up were removed by hand). Run with --show to see each query's top 8.
QUERIES = [
    # ---- answerable: short keywords -----------------------------------------------------
    ("pricing", "pricing", L("a:9 10 12 13 14 15 28 item0; b:38 39 40; c:14 16 17 item1; d:18 19 28 29 item0")),
    ("budget", "budget", L("a:9 28 item2; b:66; c:14 15 item0; d:20 item1")),
    ("teletext", "teletext", L("b:3 5 15 item0; d:26 29")),
    ("speech", "speech recognition", L("b:27 31 42 43 46 47 48 49 51 59 63 item14")),
    ("battery", "battery", L("b:54 65 66 item7")),
    ("colour", "company colour", L("b:3 4 5 item2")),
    ("gaming", "gaming", L("c:19 20 21 23 24 item6")),
    ("touchscreen", "touch screen", L("a:23; c:16 17 item4")),
    # ---- answerable: phrases and questions ----------------------------------------------
    ("nextmeeting", "when is the next meeting", L("a:25; b:74; c:22; d:32")),
    ("minutes", "who is writing the minutes", L("b:1 74; c:26")),
    ("target", "who is our target market", L("b:37 38 39 41 43 44 45 68 item5 item13")),
    ("roles", "who is the industrial designer", L("a:0 24 25 item3 item4 item5; b:item8 item9 item10; c:0 1; d:24 item5 item6 item7")),
    ("international", "will we sell internationally", L("a:9 10 11 12 item1; d:19 21 item2")),
    ("lost", "people keep losing the remote", L("a:21 22; b:50")),
    ("profit", "how many units do we need to sell to make a profit", L("a:9; c:14 15; d:19 20 21 item2")),
    ("buttons", "which buttons does the remote need", L("b:14 17 18 69 item3; d:22 23 26 28 29 item4")),
    ("agenda", "what is on the agenda", L("c:2 3; d:2 3 4 6 7")),
    ("mics", "problem with the microphone", L("c:6 7 27; d:0 1 12")),
    ("categories", "audio video and device controls", L("b:18 72 77 78 79 80 81 item11 item12")),
    ("decide", "what did we decide about the advanced functions", L("b:9 10 20 69 70 item15")),
    ("ages", "which age group would pay more", L("b:31 41 43 44 45 68 item5")),
    # ---- NO relevant passage in the set: judged on rejecting noise ------------------------
    ("n_revenue", "quarterly revenue forecast", set()),
    ("n_hiring", "hiring and salary", set()),
    ("n_legal", "contract renewal with the lawyers", set()),
    ("n_outage", "server outage postmortem", set()),
    ("n_vacation", "holiday schedule and time off", set()),
    ("n_security", "security audit findings", set()),
    ("n_support", "customer support tickets", set()),
    ("n_invoice", "invoice payment terms", set()),
    ("n_cloud", "cloud migration plan", set()),
    ("n_lease", "office lease", set()),
    ("n_bug", "bug in the login flow", set()),
    ("n_owner", "who owns the quarterly report", set()),
    ("n_demo", "book the demo room for Friday", set()),
]


def chunks(segs):
    """SearchChunker.chunks: turns in time order, windows of <= 100 words, split on a >30 s gap."""
    out, cur = [], None
    for u in sorted(segs, key=lambda s: s["start_ms"]):
        t = u["text"].strip()
        if not t:
            continue
        n = len(re.split(r"\s+", t))
        if cur and (u["start_ms"] - cur["end"] > MAX_GAP_MS or cur["w"] + n > MAX_WORDS):
            out.append(cur)
            cur = None
        if cur is None:
            cur = {"end": u["end_ms"], "w": 0, "t": []}
        cur["t"].append(t)
        cur["w"] += n
        cur["end"] = u["end_ms"]
    if cur:
        out.append(cur)
    return [" ".join(c["t"]) for c in out]


def passages():
    out = []  # (id, kind, text)
    for f in FIXTURES:
        with open(os.path.join(ROOT, "eval/fixtures", f, "truth.json")) as fh:
            for i, t in enumerate(chunks(json.load(fh)["segments"])):
                out.append((f"{f}#{i}", "turn", t))
        with open(os.path.join(ROOT, "eval/fixtures", f, "minutes.json")) as fh:
            m = json.load(fh)
        items = list(m.get("decisions", [])) + [a["text"] for a in m.get("actions", [])] + list(m.get("questions", []))
        for i, t in enumerate(items):
            out.append((f"{f}#item{i}", "item", t))
    return out


def build_tool(work, cli_build):
    exe = os.path.join(work, "embed_dump")
    src = os.path.join(ROOT, "cpp/tests/embed_dump.cpp")
    if os.path.exists(exe) and os.path.getmtime(exe) > os.path.getmtime(src):
        return exe
    cpp = os.path.join(ROOT, "cpp")
    lib = lambda p: os.path.join(cli_build, p)  # noqa: E731
    cmd = [
        "clang++", "-O2", "-std=gnu++17", "-mmacosx-version-min=14.5", "-DHAVE_LLAMA=1", "-DGGML_USE_BLAS", "-DGGML_USE_CPU", "-DGGML_USE_METAL",
        "-I" + cpp, "-I" + cpp + "/third_party/llama.cpp/include", "-I" + cpp + "/third_party/llama.cpp/ggml/src/../include",
        src, os.path.join(cpp, "llm/embed_engine.cpp"), "-o", exe,
        lib("llama/src/libllama.a"), lib("llama/ggml/src/libggml.a"), lib("llama/ggml/src/libggml-cpu.a"),
        lib("llama/ggml/src/ggml-blas/libggml-blas.a"), "-framework", "Accelerate",
        lib("llama/ggml/src/ggml-metal/libggml-metal.a"), lib("llama/ggml/src/libggml-base.a"),
        "-lm", "-framework", "Foundation", "-framework", "Metal", "-framework", "MetalKit",
    ]
    subprocess.run(cmd, check=True)
    return exe


def embed(exe, model, texts, work, name):
    path = os.path.join(work, name + ".txt")
    with open(path, "w") as fh:
        fh.write("\n".join(t.replace("\n", " ") for t in texts) + "\n")
    res = subprocess.run([exe, model, path], check=True, capture_output=True, text=True)
    vecs = [[float(x) for x in line.split()] for line in res.stdout.splitlines()]
    if len(vecs) != len(texts):
        sys.exit(f"embedded {len(vecs)} of {len(texts)} texts")
    return vecs


def quantise(v):
    """VecCodec.encode: int8 with one float scale."""
    mx = max(abs(x) for x in v)
    scale = mx / 127.0 if mx > 0 else 1.0
    q = [max(-127, min(127, int(math.floor(x / scale + 0.5)))) for x in v]
    return q, scale


def dot(qvec, pq):
    q, scale = pq
    return sum(a * b for a, b in zip(qvec, q)) * scale


def keyword_hits(query, ps):
    """What FTS5 returns for the query (AudioDb.ftsQuery): every token must match, the last as a
    prefix. An approximation -- no ranking, the unicode61 tokenizer is imitated by \\w+ -- good
    enough to say which rows the keyword list already has, so a ≈ row is only the extra ones."""
    toks = [t.lower() for t in re.split(r"[^\w]+", query) if t]
    out = set()
    for pid, _, text in ps:
        words = [w.lower() for w in re.findall(r"\w+", text)]
        if all((any(w.startswith(t) for w in words) if i == len(toks) - 1 else t in words) for i, t in enumerate(toks)):
            out.add(pid)
    return out


def pct(xs, p):
    xs = sorted(xs)
    if not xs:
        return float("nan")
    k = (len(xs) - 1) * p
    lo, hi = int(math.floor(k)), int(math.ceil(k))
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def summary(xs):
    return {"n": len(xs), "min": min(xs), "q1": pct(xs, .25), "median": pct(xs, .5), "q3": pct(xs, .75),
            "p95": pct(xs, .95), "max": max(xs)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True, help="scratch directory for the built tool and text files")
    ap.add_argument("--model", default=os.path.join(ROOT, "eval/models/bge-small-en-v1.5-q8_0.gguf"))
    ap.add_argument("--cli-build", default=os.path.join(ROOT, "cpp/cli/build"))
    ap.add_argument("--min-words", type=int, default=0,
                    help="sensitivity: leave out passages of fewer words (what not indexing backchannel would do)")
    ap.add_argument("--show", action="store_true", help="print each query's labelled passages and its top 8")
    ap.add_argument("--json", help="write the raw numbers here")
    a = ap.parse_args()
    os.makedirs(a.work, exist_ok=True)

    ps = [p for p in passages() if len(p[2].split()) >= a.min_words]
    ids = [p[0] for p in ps]
    exe = build_tool(a.work, a.cli_build)
    pvecs = [quantise(v) for v in embed(exe, a.model, [p[2] for p in ps], a.work, "passages")]
    qvecs = embed(exe, a.model, [q[1] for q in QUERIES], a.work, "queries")

    rel = {name: ids_ & set(ids) for name, _, ids_ in QUERIES}
    unknown = {i for r in rel.values() for i in r} - set(ids)
    if unknown:
        sys.exit(f"labelled ids that are not passages: {sorted(unknown)}")

    R, I = [], []  # dot products of relevant / irrelevant (query, passage) pairs
    per_query = {}
    for (name, text, _), qv in zip(QUERIES, qvecs):
        scored = sorted(((dot(qv, pv), pid) for pid, pv in zip(ids, pvecs)), reverse=True)
        for s, pid in scored:
            (R if pid in rel[name] else I).append(s)
        per_query[name] = scored
        if a.show:
            print(f"\n== {name}: {text!r}  relevant={sorted(rel[name])}")
            for s, pid in scored[:8]:
                print(f"   {s:.3f} {'REL' if pid in rel[name] else '   '} {pid}  {dict((p[0], p[2]) for p in ps)[pid][:90]}")

    answerable = [q[0] for q in QUERIES if rel[q[0]]]
    nothing = [q[0] for q in QUERIES if not rel[q[0]]]
    top1_no = [per_query[n][0][0] for n in nothing]
    top1_yes = [per_query[n][0][0] for n in answerable]
    best_rel = [max(s for s, pid in per_query[n] if pid in rel[n]) for n in answerable]

    print(f"passages: {len(ps)} ({sum(p[1] == 'turn' for p in ps)} chunks + {sum(p[1] == 'item' for p in ps)} items), "
          f"queries: {len(QUERIES)} ({len(answerable)} answerable, {len(nothing)} with no relevant passage)")
    print(f"labelled relevant pairs: {len(R)}   irrelevant pairs: {len(I)}\n")
    print("dot-product distribution          n     min    q1  median   q3   p95    max")
    for label, xs in (("relevant pairs", R), ("irrelevant pairs", I),
                      ("best relevant per query", best_rel), ("top-1 of answerable q", top1_yes),
                      ("top-1 of NO-ANSWER q", top1_no)):
        s = summary(xs)
        print(f"{label:<28}{s['n']:>6}  {s['min']:.3f} {s['q1']:.3f}  {s['median']:.3f} {s['q3']:.3f} {s['p95']:.3f}  {s['max']:.3f}")

    print("\n             all pairs           |   what the person sees: keyword rows + meaning rows (top-40) at or above the floor")
    print("floor  relevant-kept  irrel-rejected | ≈ rows rel / irrel | answerable q with no relevant row | NO-ANSWER q left with 0 rows | irrel rows per q")
    table = []
    kw = {q[0]: keyword_hits(q[1], ps) for q in QUERIES}
    for fl in FLOORS:
        kept = sum(x >= fl for x in R) / len(R)
        rej = sum(x < fl for x in I) / len(I)
        extra_rel = extra_irr = shown_irr = lost_q = clean_q = 0
        for n in answerable + nothing:
            meaning = [pid for s, pid in per_query[n][:MEANING_TOP] if s >= fl]
            extra = [pid for pid in meaning if pid not in kw[n]]
            shown = kw[n] | set(meaning)
            extra_rel += sum(pid in rel[n] for pid in extra)
            extra_irr += sum(pid not in rel[n] for pid in extra)
            shown_irr += sum(pid not in rel[n] for pid in shown)
            if n in answerable and not (shown & rel[n]):
                lost_q += 1
            if n in nothing and not shown:
                clean_q += 1
        table.append({"floor": fl, "kept": kept, "rejected": rej, "extra_rel": extra_rel, "extra_irr": extra_irr,
                      "lost_q": lost_q, "clean_q": clean_q, "irr_per_q": shown_irr / len(QUERIES)})
        print(f"{fl:.3f}  {kept:>12.1%}  {rej:>13.1%} | {extra_rel:>6} / {extra_irr:<6}    | {lost_q:>3} of {len(answerable)}"
              f"                        | {clean_q:>3} of {len(nothing)}                      | {shown_irr / len(QUERIES):.1f}")
    kwq = [n for n in answerable if kw[n]]
    print(f"\nanswerable queries the keyword list already finds something for: {len(kwq)} of {len(answerable)}; "
          f"no-answer queries with keyword hits: {sum(bool(kw[n]) for n in nothing)} of {len(nothing)}")
    if a.json:
        with open(a.json, "w") as fh:
            json.dump({"R": summary(R), "I": summary(I), "best_rel": summary(best_rel), "top1_yes": summary(top1_yes),
                       "top1_no": summary(top1_no), "table": table,
                       "per_query": {n: {"relevant": len(rel[n]), "top1": per_query[n][0][0]} for n in rel}}, fh, indent=1)


if __name__ == "__main__":
    main()
