#!/usr/bin/env python3
"""Read and edit golden.psv transcripts.

  psvtool.py render <psv> [--from H:MM:SS] [--to H:MM:SS] [--seg N]
      Readable view: one block per segment, each sentence prefixed with the
      onset of its first word. Use those onsets to address edits.
  psvtool.py words <psv> <from> <to>
      Every word with its onset, to find a split point inside a sentence.
  psvtool.py stats <psv>
      Segments per label and the longest segments.
  psvtool.py apply <psv> <ops.jsonl> [--dry-run]
      Apply edit ops in order, then merge adjacent same-label segments and
      rewrite the file. Ops (one JSON object per line, `#` lines ignored):
        {"op":"split","at":T,"word":W,"speaker":L}
            The word W at onset T starts a new segment labelled L, which runs
            to the next existing marker. To give a turn back to the previous
            speaker, add a second split where they resume. If W already
            starts a segment, the whole segment is relabelled, so to move
            only W, first split at the word after it under the old label.
            Applying splits in descending time order avoids both traps.
        {"op":"label","at":T,"speaker":L}
            Relabel the whole segment containing the word at onset T.
        {"op":"replace","at":T,"old":"good wood","new":"Girdwood"}
            Replace the word sequence starting at onset T. `old` must match
            the word texts exactly (space separated). `new` may have more or
            fewer words; "" deletes.
        {"op":"insert","words":["0:01:57.24 Are","0:01:57.52 we"],"speaker":L}
            Add words the transcript is missing, each at its onset. With "speaker", they form their own turn and the
            words after them go back to whoever was speaking; without it,
            they join the segment they fall in. An onset that a word
            already has is refused.
        {"op":"replace_all","old":"Gridwood","new":"Girdwood"}
            Replace every occurrence of a word sequence, ignoring case and
            trailing punctuation; the last old word's trailing punctuation is
            kept. Prints the count. Because case is ignored, a later `replace`
            that expects the old spelling will fail; and a common word
            ("Kelly") may match more than one person.
  T is H:MM:SS.ss as printed by render/words. L is "identified:<slug>",
  "segmented:spk-<n>" or "unlabeled".

  Splits and merges can leave a stutter ("I I") where two turns join; run
  `pnpm fixtures:check` after each batch.
"""
import json
import re
import sys


def parse_ts(s):
    h, m, sec = s.split(":")
    return round((int(h) * 3600 + int(m) * 60 + float(sec)) * 100)


def fmt_ts(cs):
    s, c = divmod(cs, 100)
    m, s = divmod(s, 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}.{c:02d}"


def load(path):
    segs = []
    for raw in open(path, encoding="utf8"):
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("start_sec"):
            continue
        t, typ, data = line.split("|", 2)
        if typ == "meta":
            segs.append({"label": json.loads(data)["begin_speaker"], "words": []})
        elif typ == "text":
            segs[-1]["words"].append([parse_ts(t), data])
    return segs


def save(path, segs):
    rows = ["start_sec|event_type|event_data"]
    for s in segs:
        if not s["words"]:
            continue
        rows.append(f'{fmt_ts(s["words"][0][0])}|meta|{json.dumps({"begin_speaker": s["label"]}, separators=(",", ":"), ensure_ascii=False)}')
        for t, w in s["words"]:
            rows.append(f"{fmt_ts(t)}|text|{w}")
    open(path, "w", encoding="utf8").write("\n".join(rows) + "\n")


LABEL_RE = re.compile(r"^(unlabeled|segmented:spk-\d+|identified:[a-z0-9][a-z0-9-]*)$")


def check_label(l):
    if not LABEL_RE.match(l):
        raise SystemExit(f"bad speaker label {l!r}")


def find(segs, t, word=None):
    """(seg index, word index) of the word at onset t (matching `word` if given)."""
    hits = []
    for si, s in enumerate(segs):
        for wi, (wt, w) in enumerate(s["words"]):
            if wt == t:
                hits.append((si, wi, w))
    if word is not None:
        hits = [h for h in hits if h[2] == word]
    if not hits:
        near = [w for s in segs for w in s["words"] if abs(w[0] - t) < 300]
        raise SystemExit(
            f"no word {word!r} at {fmt_ts(t)}; nearby: "
            + " ".join(f"{fmt_ts(a)}={b}" for a, b in near[:12])
        )
    return hits[0][0], hits[0][1]


def norm(w):
    return re.sub(r"[.,?!;:\"']+$", "", w).lower()


def trail(w):
    m = re.search(r"[.,?!;:\"']+$", w)
    return m.group(0) if m else ""


def splice(words, i, n, new_texts):
    """Replace words[i:i+n] with new_texts, assigning onsets."""
    old = words[i : i + n]
    times = [t for t, _ in old]
    if new_texts and len(new_texts) == len(old):
        new = [[times[k], new_texts[k]] for k in range(len(old))]
    elif new_texts:
        new = [[times[min(k, len(times) - 1)], txt] for k, txt in enumerate(new_texts)]
    else:
        new = []
    words[i : i + n] = new


def apply(segs, ops):
    for n, op in enumerate(ops, 1):
        kind = op["op"]
        try:
            if kind == "split":
                check_label(op["speaker"])
                si, wi = find(segs, parse_ts(op["at"]), op.get("word"))
                if wi == 0:
                    segs[si]["label"] = op["speaker"]
                else:
                    s = segs[si]
                    segs.insert(si + 1, {"label": op["speaker"], "words": s["words"][wi:]})
                    s["words"] = s["words"][:wi]
            elif kind == "label":
                check_label(op["speaker"])
                si, _ = find(segs, parse_ts(op["at"]), op.get("word"))
                segs[si]["label"] = op["speaker"]
            elif kind == "replace":
                si, wi = find(segs, parse_ts(op["at"]))
                old = op["old"].split()
                words = segs[si]["words"]
                got = [w for _, w in words[wi : wi + len(old)]]
                if got != old:
                    raise SystemExit(f"expected {old} at {op['at']}, found {got}")
                splice(words, wi, len(old), op["new"].split())
            elif kind == "insert":
                speaker = op.get("speaker")
                if speaker is not None:
                    check_label(speaker)
                flat = [[t, w, s["label"]] for s in segs for t, w in s["words"]]
                taken = {t for t, _, _ in flat}
                for item in op["words"]:
                    at, _, text = item.partition(" ")
                    t = parse_ts(at)
                    if t in taken or not text.strip():
                        raise SystemExit(f"can't insert {item!r}: onset taken or no word")
                    taken.add(t)
                    before = [x for x in flat if x[0] < t]
                    label = speaker or (before[-1][2] if before else flat[0][2])
                    flat.append([t, text.strip(), label])
                flat.sort(key=lambda x: x[0])
                segs[:] = []
                for t, w, label in flat:
                    if segs and segs[-1]["label"] == label:
                        segs[-1]["words"].append([t, w])
                    else:
                        segs.append({"label": label, "words": [[t, w]]})
            elif kind == "replace_all":
                old = [norm(w) for w in op["old"].split()]
                newt = op["new"].split()
                count = 0
                for s in segs:
                    words = s["words"]
                    i = 0
                    while i <= len(words) - len(old):
                        if [norm(w) for _, w in words[i : i + len(old)]] == old:
                            p = trail(words[i + len(old) - 1][1])
                            repl = list(newt)
                            if repl:
                                repl[-1] = repl[-1] + p if not trail(repl[-1]) else repl[-1]
                            splice(words, i, len(old), repl)
                            count += 1
                            i += len(repl) or 0
                        else:
                            i += 1
                print(f"replace_all {op['old']!r} -> {op['new']!r}: {count}")
            else:
                raise SystemExit(f"unknown op {kind}")
        except SystemExit as e:
            raise SystemExit(f"op {n} {json.dumps(op)}: {e}")
    segs[:] = [s for s in segs if s["words"]]
    merged = []
    for s in segs:
        if merged and merged[-1]["label"] == s["label"]:
            merged[-1]["words"].extend(s["words"])
        else:
            merged.append(s)
    segs[:] = merged


def sentences(words):
    out, cur = [], []
    for t, w in words:
        cur.append((t, w))
        if re.search(r"[.?!]$", w) and len(cur) >= 1:
            out.append(cur)
            cur = []
    if cur:
        out.append(cur)
    return out


def render(segs, lo=None, hi=None, only=None):
    for i, s in enumerate(segs):
        w = s["words"]
        if only is not None and i != only:
            continue
        if lo is not None and w[-1][0] < lo:
            continue
        if hi is not None and w[0][0] > hi:
            continue
        print(f"=== seg {i} | {s['label']} | {fmt_ts(w[0][0])}-{fmt_ts(w[-1][0])} | {len(w)} words")
        for sent in sentences(w):
            print(f"[{fmt_ts(sent[0][0])}] " + " ".join(x for _, x in sent))
        print()


def main():
    cmd, path = sys.argv[1], sys.argv[2]
    segs = load(path)
    args = sys.argv[3:]
    if cmd == "render":
        lo = hi = only = None
        if "--from" in args:
            lo = parse_ts(args[args.index("--from") + 1] + ("" if "." in args[args.index("--from") + 1] else ".00"))
        if "--to" in args:
            hi = parse_ts(args[args.index("--to") + 1] + ("" if "." in args[args.index("--to") + 1] else ".00"))
        if "--seg" in args:
            only = int(args[args.index("--seg") + 1])
        render(segs, lo, hi, only)
    elif cmd == "words":
        lo, hi = parse_ts(args[0] if "." in args[0] else args[0] + ".00"), parse_ts(args[1] if "." in args[1] else args[1] + ".00")
        for s in segs:
            for t, w in s["words"]:
                if lo <= t <= hi:
                    print(f"{fmt_ts(t)} {w}" + ("   <-- starts " + s["label"] if (t, w) == tuple(s["words"][0]) else ""))
    elif cmd == "stats":
        from collections import Counter
        c, cw = Counter(), Counter()
        for s in segs:
            c[s["label"]] += 1
            cw[s["label"]] += len(s["words"])
        for l, n in cw.most_common():
            print(f"{l:45} {c[l]:4} segs {n:6} words")
        print("longest:")
        for i, s in sorted(enumerate(segs), key=lambda x: -len(x[1]["words"]))[:15]:
            print(f"  seg {i} {s['label']} {fmt_ts(s['words'][0][0])} {len(s['words'])} words")
    elif cmd == "apply":
        ops = [json.loads(l) for l in open(args[0]) if l.strip() and not l.startswith("#")]
        apply(segs, ops)
        if "--dry-run" not in args:
            save(path, segs)
        print(f"applied {len(ops)} ops; {len(segs)} segments")
    else:
        print(__doc__)


if __name__ == "__main__":
    main()
