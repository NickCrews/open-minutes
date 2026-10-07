# /// script
# requires-python = ">=3.12"
# dependencies = [
#     "altair==6.0.0",
#     "av==16.0.1",
#     "marimo==0.25.1",
#     "numpy==2.3.5",
#     "polars==1.35.2",
#     "sherpa-onnx==1.12.39",
# ]
# ///
"""One voiceprint per person, or a handful? See README.md next to this file.

    uvx marimo edit --sandbox docs/research/voiceprints/notebook.py   # explore
    uv run docs/research/voiceprints/notebook.py                      # headless

The first run downloads the golden meetings' audio from the object store
(~190 MB) and embeds every golden segment (a few minutes on 4 cores). Both are
cached under ~/.cache/open-minutes/research/voiceprints/.
"""

import marimo

__generated_with = "0.25.1"
app = marimo.App(width="medium")


@app.cell
def _():
    import hashlib
    import json
    import pathlib
    import shutil
    import urllib.request

    import altair as alt
    import marimo as mo
    import numpy as np
    import polars as pl

    return alt, hashlib, json, mo, np, pathlib, pl, shutil, urllib


@app.cell
def _(mo):
    mo.md(r"""
    # One voiceprint per person, or a handful?

    Today each person has **one** voiceprint: the mean CAM++ embedding of their
    3 longest turns in the meeting where we first heard them
    (`computeSpeakerEmbeddings` in `packages/audio/src/embed.ts`). A new meeting's
    speaker is matched to the person with the nearest voiceprint, if its cosine
    similarity is ≥ 0.55 (`packages/ingest/src/identify.ts`).

    The question: would keeping **up to 20 embeddings per person**, picked from
    as varied a set of their segments as we can, recognize them more often in new
    meetings, without putting the wrong name on people more often?

    **Protocol: leave one meeting out.** For each of the 7 golden meetings, build
    voiceprints from the other 6 (from the hand-labelled `identified:` segments)
    and try to recognize every speaker in the held-out one. A speaker whose person
    appears in another golden is *known* and should be matched to them; everyone
    else (people only in this meeting, and the unnamed `segmented:` voices) is
    *unknown* and should become a new person.
    """)
    return


@app.cell
def _(pathlib):
    # Paths and constants. The embedding constants mirror packages/audio/src/embed.ts.
    REPO = next(
        p
        for p in pathlib.Path(__file__).resolve().parents
        if (p / "pnpm-workspace.yaml").exists()
    )
    MEETINGS_DIR = REPO / "packages/fixtures/test-data/meetings"
    CACHE = pathlib.Path.home() / ".cache/open-minutes/research/voiceprints"
    CACHE.mkdir(parents=True, exist_ok=True)

    STORE = "https://pub-ac21478ae97547c5a797c710cdc9df3d.r2.dev"
    MODEL = "3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced"
    MODEL_URL = f"https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/{MODEL}.onnx"

    SAMPLE_RATE = 16000
    LAST_WORD_DURATION_SEC = 0.5  # packages/core/src/transcription/types.ts
    MIN_SEGMENT_SECONDS = 1.5
    MAX_EMBEDDING_SECONDS = 8
    LONGEST_SEGMENTS = 3
    MATCH_THRESHOLD = 0.55  # packages/ingest/src/identify.ts
    return (
        CACHE,
        LAST_WORD_DURATION_SEC,
        LONGEST_SEGMENTS,
        MATCH_THRESHOLD,
        MAX_EMBEDDING_SECONDS,
        MEETINGS_DIR,
        MIN_SEGMENT_SECONDS,
        MODEL,
        MODEL_URL,
        SAMPLE_RATE,
        STORE,
    )


@app.cell
def _(LAST_WORD_DURATION_SEC, json):
    def parse_timestamp(s):
        h, m, sec = s.split(":")
        return int(h) * 3600 + int(m) * 60 + float(sec)

    def golden_segments(psv_path):
        """A golden.psv's segments as (label, start, end), like psv.ts's spans."""
        segs, cur = [], None
        for line in psv_path.read_text().splitlines()[1:]:
            t, kind, data = line.split("|", 2)
            if kind == "meta":
                d = json.loads(data)
                if "begin_speaker" in d:
                    cur = {"label": d["begin_speaker"], "words": []}
                    segs.append(cur)
            elif kind == "text" and cur is not None:
                cur["words"].append(parse_timestamp(t))
        return [
            {
                "label": s["label"],
                "start": s["words"][0],
                "end": s["words"][-1] + LAST_WORD_DURATION_SEC,
            }
            for s in segs
            if s["words"]
        ]

    return (golden_segments,)


@app.cell
def _(SAMPLE_RATE, shutil, urllib):
    import av

    def download(url, dest):
        if dest.exists():
            return dest
        # r2.dev rejects urllib's default User-Agent.
        req = urllib.request.Request(
            url, headers={"User-Agent": "open-minutes-research"}
        )
        tmp = dest.with_suffix(dest.suffix + ".part")
        with urllib.request.urlopen(req) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        tmp.rename(dest)
        return dest

    def decode_16k_mono(path):
        import numpy as np

        resampler = av.AudioResampler(format="flt", layout="mono", rate=SAMPLE_RATE)
        out = []
        with av.open(str(path)) as container:
            for frame in container.decode(audio=0):
                out += [f.to_ndarray().reshape(-1) for f in resampler.resample(frame)]
        out += [f.to_ndarray().reshape(-1) for f in resampler.resample(None)]
        return np.concatenate(out)

    return decode_16k_mono, download


@app.cell
def _(
    CACHE,
    MAX_EMBEDDING_SECONDS,
    MEETINGS_DIR,
    MIN_SEGMENT_SECONDS,
    MODEL,
    MODEL_URL,
    SAMPLE_RATE,
    STORE,
    decode_16k_mono,
    download,
    golden_segments,
    hashlib,
    json,
    mo,
    np,
    pl,
):
    import sherpa_onnx

    def embed_meeting(meeting_dir, extractor):
        """Embed every golden segment ≥ MIN_SEGMENT_SECONDS of one meeting, cached
        by the golden's and the model's contents."""
        meta = json.loads((meeting_dir / "meeting.json").read_text())
        psv = meeting_dir / "golden.psv"
        key = hashlib.sha256(psv.read_bytes() + MODEL.encode()).hexdigest()[:16]
        cached = CACHE / f"{meeting_dir.name}-{key}.npz"
        segs = [
            s
            for s in golden_segments(psv)
            if s["end"] - s["start"] >= MIN_SEGMENT_SECONDS
        ]
        if not cached.exists():
            webm = download(
                f"{STORE}/youtube/{meta['youtube_id']}/speech.webm",
                CACHE / f"{meta['youtube_id']}.webm",
            )
            wav = decode_16k_mono(webm)
            embs = []
            for s in segs:
                # Like embed.ts: only the last MAX_EMBEDDING_SECONDS of a turn.
                start = max(s["start"], s["end"] - MAX_EMBEDDING_SECONDS)
                stream = extractor.create_stream()
                stream.accept_waveform(
                    SAMPLE_RATE,
                    wav[int(start * SAMPLE_RATE) : int(s["end"] * SAMPLE_RATE)],
                )
                stream.input_finished()
                embs.append(np.array(extractor.compute(stream), dtype=np.float32))
            np.savez(cached, embeddings=np.stack(embs))
        embs = np.load(cached)["embeddings"]
        return pl.DataFrame(
            {
                "meeting": meeting_dir.name,
                "date": meta["date"],
                "label": [s["label"] for s in segs],
                "start": [s["start"] for s in segs],
                "end": [s["end"] for s in segs],
            }
        ), embs

    _model_path = download(MODEL_URL, CACHE / f"{MODEL}.onnx")
    _extractor = sherpa_onnx.SpeakerEmbeddingExtractor(
        sherpa_onnx.SpeakerEmbeddingExtractorConfig(
            model=str(_model_path), num_threads=4
        )
    )
    _frames, _embs = [], []
    _dirs = sorted(MEETINGS_DIR.iterdir())
    for _d in mo.status.progress_bar(_dirs, title="Embedding golden segments"):
        _f, _e = embed_meeting(_d, _extractor)
        _frames.append(_f)
        _embs.append(_e)

    # One row per embeddable segment. `speaker` is unique across meetings: a
    # person's slug, or "<meeting>/spk-N" for an unnamed voice.
    segments = (
        pl.concat(_frames)
        .with_row_index("i")
        .with_columns(
            duration=pl.col("end") - pl.col("start"),
            identified=pl.col("label").str.starts_with("identified:"),
        )
        .with_columns(
            speaker=pl.when(pl.col("identified"))
            .then(pl.col("label").str.strip_prefix("identified:"))
            .otherwise(
                pl.col("meeting") + "/" + pl.col("label").str.split(":").list.last()
            )
        )
    )
    _raw = np.concatenate(_embs)
    # Unit-normalize so a dot product is a cosine similarity.
    E = _raw / np.linalg.norm(_raw, axis=1, keepdims=True)
    return E, segments


@app.cell
def _(mo, pl, segments):
    _per_person = (
        segments.filter("identified")
        .group_by("speaker")
        .agg(
            meetings=pl.col("meeting").n_unique(),
            segs=pl.len(),
            minutes=pl.col("duration").sum() / 60,
        )
    )
    _recurring = _per_person.filter(pl.col("meetings") >= 2)
    mo.md(
        f"""
    ## The data

    {segments.height} embeddable segments (≥ 1.5 s) across
    {segments["meeting"].n_unique()} golden meetings;
    {segments.filter("identified").height} of them are from
    {_per_person.height} named people, **{_recurring.height} of whom speak in
    two or more meetings**. Those recurring people are the ones recognition can
    get right; their median is {_recurring["segs"].median():.0f} embeddable
    segments ({_recurring["minutes"].median():.1f} minutes) in total.
    """
    )
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## How much does a voice vary between meetings?

    If a person's segments from the same meeting are much closer to each other
    than to their segments from other meetings, a voiceprint learned in one
    meeting is a biased sample of their voice, and drawing exemplars from several
    meetings should help. Below: the cosine similarity of pairs of segments from
    the same person in the same meeting, the same person in different meetings,
    and different people.
    """)
    return


@app.cell
def _(E, alt, np, pl, segments):
    _ided = segments.filter("identified")
    _idx = _ided["i"].to_numpy()
    _sim = E[_idx] @ E[_idx].T
    _spk = _ided["speaker"].to_numpy()
    _mtg = _ided["meeting"].to_numpy()
    _iu = np.triu_indices(len(_idx), k=1)
    _same_spk = _spk[_iu[0]] == _spk[_iu[1]]
    _same_mtg = _mtg[_iu[0]] == _mtg[_iu[1]]
    pair_sims = pl.DataFrame(
        {
            "cosine": _sim[_iu],
            "pair": np.where(
                _same_spk,
                np.where(
                    _same_mtg, "same person, same meeting", "same person, other meeting"
                ),
                "different people",
            ),
        }
    )
    pair_summary = (
        pair_sims.group_by("pair")
        .agg(
            pairs=pl.len(),
            median=pl.col("cosine").median(),
            p10=pl.col("cosine").quantile(0.1),
            p90=pl.col("cosine").quantile(0.9),
        )
        .sort("median", descending=True)
    )

    _sample = pl.concat(
        [g.sample(min(g.height, 20000), seed=0) for g in pair_sims.partition_by("pair")]
    )
    pair_chart = (
        alt.Chart(_sample)
        .transform_density(
            "cosine", groupby=["pair"], as_=["cosine", "density"], extent=[-0.4, 1]
        )
        .mark_line()
        .encode(x="cosine:Q", y="density:Q", color=alt.Color("pair:N", title=None))
        .properties(width=600, height=220, title="Segment-to-segment cosine similarity")
    )
    return pair_chart, pair_summary


@app.cell
def _(pair_chart, pair_summary):
    pair_chart, pair_summary
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## Voiceprint strategies

    Each strategy turns a person's labelled segments in the *enrolment* meetings
    into a set of exemplar embeddings, and scores a probe against that set:

    | strategy | exemplars | score |
    |---|---|---|
    | **current** | mean of the 3 longest segments in the *first* meeting they appear in (first wins, as `seedGoldenMeeting` and ingest do today) | cosine |
    | **centroid, every meeting** | mean of the 3 longest segments of *each* meeting, averaged | cosine |
    | **centroid, all segments** | mean of every segment | cosine |
    | **K longest** | the K longest segments | max cosine |
    | **K random** | K segments at random | max cosine |
    | **K diverse** | K-means the person's segments into K groups; keep the segment nearest each group's centre | max cosine |
    | **K spread** | farthest-point sampling: start at the medoid, repeatedly add the segment least like those already picked | max cosine |
    | **… top-3** | same exemplars as K diverse | mean of the 3 best cosines |
    | **… centroid** | same exemplars as K diverse | cosine to their mean |

    K is 20 unless noted. A person with fewer than K segments keeps all of them.

    A **probe** is how the pipeline sees a speaker in a new meeting: the mean
    embedding of that speaker's 3 longest turns (`computeSpeakerEmbeddings`).
    """)
    return


@app.cell
def _(LONGEST_SEGMENTS, np):
    def unit(v):
        return v / np.linalg.norm(v)

    def longest(df, n):
        return df.sort("duration", descending=True).head(n)

    def centroid_of_longest(df, E):
        return unit(E[longest(df, LONGEST_SEGMENTS)["i"].to_numpy()].mean(0))

    def kmeans_medoids(X, k, seed=0, iters=25):
        """Indices (into X) of the points nearest each of k spherical-k-means centres."""
        if len(X) <= k:
            return np.arange(len(X))
        rng = np.random.default_rng(seed)
        # k-means++ init on cosine distance.
        centres = [rng.integers(len(X))]
        for _ in range(k - 1):
            d = np.clip(1 - (X @ X[centres].T).max(1), 0, None)
            if d.sum() == 0:  # fewer distinct segments than k
                break
            centres.append(rng.choice(len(X), p=d / d.sum()))
        k = len(centres)
        C = X[centres]
        for _ in range(iters):
            assign = (X @ C.T).argmax(1)
            C = np.stack(
                [
                    unit(X[assign == j].mean(0)) if (assign == j).any() else C[j]
                    for j in range(k)
                ]
            )
        assign = (X @ C.T).argmax(1)
        picks = {
            int(np.where(assign == j)[0][(X[assign == j] @ C[j]).argmax()])
            for j in range(k)
            if (assign == j).any()
        }
        return np.array(sorted(picks))

    def farthest_points(X, k):
        if len(X) <= k:
            return np.arange(len(X))
        sims = X @ X.T
        picks = [int(sims.sum(1).argmax())]  # medoid
        best = sims[picks[0]].copy()
        for _ in range(k - 1):
            nxt = int(best.argmin())
            picks.append(nxt)
            best = np.maximum(best, sims[nxt])
        return np.array(picks)

    def make_strategies(k=20):
        """name → (build(person_df, E) -> exemplars [n, d], score(exemplars, probes [p, d]) -> [p])."""
        cos = lambda ex, P: P @ ex[0]
        mx = lambda ex, P: (P @ ex.T).max(1)
        top3 = lambda ex, P: np.sort(P @ ex.T, axis=1)[:, -3:].mean(1)
        cen = lambda ex, P: P @ unit(ex.mean(0))
        all_rows = lambda df, E: E[df["i"].to_numpy()]

        def first_meeting(df, E):
            first = df.sort("date")["meeting"][0]
            return centroid_of_longest(df.filter(meeting=first), E)[None]

        def every_meeting(df, E):
            per = [centroid_of_longest(g, E) for g in df.partition_by("meeting")]
            return unit(np.mean(per, 0))[None]

        def k_longest(df, E):
            return E[longest(df, k)["i"].to_numpy()]

        def k_random(df, E):
            idx = df["i"].to_numpy()
            return E[np.random.default_rng(0).permutation(idx)[:k]]

        def k_diverse(df, E):
            X = all_rows(df, E)
            return X[kmeans_medoids(X, k)]

        def k_spread(df, E):
            X = all_rows(df, E)
            return X[farthest_points(X, k)]

        return {
            "current": (first_meeting, cos),
            "centroid, every meeting": (every_meeting, cos),
            "centroid, all segments": (
                lambda df, E: unit(all_rows(df, E).mean(0))[None],
                cos,
            ),
            f"{k} longest": (k_longest, mx),
            f"{k} random": (k_random, mx),
            f"{k} diverse": (k_diverse, mx),
            f"{k} spread": (k_spread, mx),
            f"{k} diverse, top-3": (k_diverse, top3),
            f"{k} diverse, centroid": (k_diverse, cen),
        }

    return centroid_of_longest, make_strategies


@app.cell
def _(centroid_of_longest, np, pl):
    def leave_one_meeting_out(segments, E, strategies, probe_kind="speaker"):
        """Score every held-out probe against every enrolled person, per strategy.

        probe_kind "speaker": one probe per speaker per meeting, the pipeline's
        3-longest-turns centroid. "segment": one probe per segment (harder; more
        of them).

        Returns one row per (strategy, probe): the probe's true speaker, whether
        that person is enrolled, and the best-scoring person and score.
        """
        rows = []
        for held_out in segments["meeting"].unique().sort():
            enrol = segments.filter(pl.col("meeting") != held_out, "identified")
            test = segments.filter(meeting=held_out)
            people = enrol["speaker"].unique().sort().to_list()
            by_person = {p: enrol.filter(speaker=p) for p in people}

            if probe_kind == "speaker":
                groups = test.partition_by("speaker")
                truth = [g["speaker"][0] for g in groups]
                P = np.stack([centroid_of_longest(g, E) for g in groups])
            else:
                truth = test["speaker"].to_list()
                P = E[test["i"].to_numpy()]

            for name, (build, score) in strategies.items():
                S = np.stack([score(build(by_person[p], E), P) for p in people], axis=1)
                best = S.argmax(1)
                rows.append(
                    pl.DataFrame(
                        {
                            "strategy": name,
                            "held_out": held_out,
                            "truth": truth,
                            "known": [t in by_person for t in truth],
                            "best": [people[j] for j in best],
                            "score": S[np.arange(len(P)), best],
                            # The true person's own score, for the score-distribution chart.
                            "true_score": [
                                S[r, people.index(t)] if t in by_person else None
                                for r, t in enumerate(truth)
                            ],
                        }
                    )
                )
        return pl.concat(rows)

    def at_threshold(results, t):
        """Recall (known probes named correctly) and wrong-name rate (probes given
        a name that isn't theirs, whether known or not) at threshold t."""
        return results.group_by("strategy", maintain_order=True).agg(
            recall=((pl.col("best") == pl.col("truth")) & (pl.col("score") >= t)).sum()
            / pl.col("known").sum(),
            wrong_name=(
                (pl.col("best") != pl.col("truth")) & (pl.col("score") >= t)
            ).mean(),
        )

    def operating_points(results, wrong_name_budgets=(0.01, 0.02, 0.05)):
        """Per strategy: closed-set rank-1 accuracy, and the best recall reachable
        with a wrong-name rate at most each budget (and the threshold that gets it)."""
        out = []
        for name in results["strategy"].unique(maintain_order=True):
            r = results.filter(strategy=name)
            correct = (r["best"] == r["truth"]).to_numpy()
            score = r["score"].to_numpy()
            n_known = r["known"].sum()
            order = np.argsort(-score)
            # Sweeping the threshold down through each probe's score:
            tp = np.cumsum(correct[order]) / n_known
            fp = np.cumsum(~correct[order]) / len(r)
            row = {
                "strategy": name,
                "rank-1 (known only)": correct[r["known"].to_numpy()].mean(),
            }
            for b in wrong_name_budgets:
                ok = np.where(fp <= b)[0]
                i = ok[tp[ok].argmax()] if len(ok) else None
                row[f"recall @ ≤{b:.0%} wrong"] = tp[i] if i is not None else 0.0
                row[f"threshold @ ≤{b:.0%}"] = (
                    score[order][i] if i is not None else None
                )
            out.append(row)
        return pl.DataFrame(out)

    def curve(results):
        """Recall vs wrong-name rate as the threshold sweeps, per strategy."""
        frames = []
        for name in results["strategy"].unique(maintain_order=True):
            r = results.filter(strategy=name).sort("score", descending=True)
            correct = (r["best"] == r["truth"]).cast(pl.Int32)
            frames.append(
                pl.DataFrame(
                    {
                        "strategy": name,
                        "threshold": r["score"],
                        "recall": correct.cum_sum() / r["known"].sum(),
                        "wrong_name": (1 - correct).cum_sum() / r.height,
                    }
                )
            )
        return pl.concat(frames)

    return at_threshold, curve, leave_one_meeting_out, operating_points


@app.cell
def _(E, leave_one_meeting_out, make_strategies, segments):
    strategies = make_strategies(20)
    speaker_results = leave_one_meeting_out(segments, E, strategies, "speaker")
    return speaker_results, strategies


@app.cell
def _(mo, pl, speaker_results):
    _r = speaker_results.filter(strategy="current")
    mo.md(
        f"""
    ## Results: recognizing a speaker in a new meeting

    {_r.height} probes across the 7 held-out meetings:
    **{_r["known"].sum()} known** (a person enrolled from another meeting) and
    {(~_r["known"]).sum()} unknown ({_r.filter(~pl.col("known"), pl.col("truth").str.contains("/")).height}
    of them unnamed `segmented:` voices).

    A strategy can trade recall for wrong names by moving its threshold, and
    strategies that take a *max* over many exemplars score everyone higher, so
    comparing them at today's 0.55 alone would be unfair. The table gives each
    strategy's best recall at a fixed wrong-name budget, and the threshold that
    reaches it. **Recall** = known speakers given their own name.
    **Wrong-name rate** = all probes given someone else's name (an unknown voice
    matched to a known person, or a known person matched to the wrong one).
    """
    )
    return


@app.cell
def _(operating_points, speaker_results):
    speaker_table = operating_points(speaker_results)
    speaker_table
    return


@app.cell
def _(alt, curve, speaker_results):
    _c = curve(speaker_results)
    alt.Chart(_c).mark_line(interpolate="step-after").encode(
        x=alt.X(
            "wrong_name:Q", title="wrong-name rate", scale=alt.Scale(domain=[0, 0.3])
        ),
        y=alt.Y("recall:Q", title="recall of known speakers"),
        color=alt.Color("strategy:N"),
        tooltip=["strategy", "threshold", "recall", "wrong_name"],
    ).transform_filter("datum.wrong_name <= 0.3").properties(
        width=600,
        height=360,
        title="Speaker probes: recall vs wrong names as the threshold sweeps",
    ).interactive()
    return


@app.cell
def _(MATCH_THRESHOLD, at_threshold, mo, speaker_results):
    mo.vstack(
        [
            mo.md(f"At today's fixed threshold of {MATCH_THRESHOLD}:"),
            at_threshold(speaker_results, MATCH_THRESHOLD),
        ]
    )
    return


@app.cell
def _(mo):
    mo.md(r"""
    ### Sensitivity: named speakers only

    Some of the highest-scoring "wrong names" look like gaps in the goldens, not
    recognition errors: an unnamed `segmented:` voice that is probably a known
    person (e.g. the unnamed voice chairing GBOS in May and June scores 0.73 to
    0.77 against Jennifer Wingard). The same table, with the unnamed voices left
    out, so every probe's answer is hand-verified:
    """)
    return


@app.cell
def _(operating_points, pl, speaker_results):
    named_table = operating_points(
        speaker_results.filter(~pl.col("truth").str.contains("/"))
    )
    named_table
    return


@app.cell
def _(alt, pl, speaker_results):
    # Where do the true person's score and the best impostor's score fall? Max-of-K
    # lifts both, which is why the threshold has to move with the strategy.
    _r = speaker_results.filter(pl.col("strategy").is_in(["current", "20 diverse"]))
    _genuine = (
        _r.filter("known")
        .select("strategy", score="true_score")
        .with_columns(kind=pl.lit("true person"))
    )
    _impostor = (
        _r.filter(pl.col("best") != pl.col("truth"))
        .select("strategy", "score")
        .with_columns(kind=pl.lit("best wrong person"))
    )
    alt.Chart(pl.concat([_genuine, _impostor])).mark_tick(thickness=2).encode(
        x=alt.X("score:Q", scale=alt.Scale(domain=[0, 1])),
        y=alt.Y("kind:N", title=None),
        row=alt.Row("strategy:N", title=None),
        color=alt.Color("kind:N", legend=None),
    ).properties(width=560, height=60, title="Speaker-probe scores")
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## How many exemplars?

    The best-performing exemplar picker, swept over K. K = 1 is a single
    medoid-like segment; large K keeps nearly everything.
    """)
    return


@app.cell
def _(
    E,
    leave_one_meeting_out,
    make_strategies,
    operating_points,
    pl,
    segments,
):
    _rows = []
    for _k in [1, 3, 5, 10, 20, 40]:
        _s = make_strategies(_k)
        _pick = {
            f"{_k} diverse": _s[f"{_k} diverse"],
            f"{_k} longest": _s[f"{_k} longest"],
        }
        _t = operating_points(leave_one_meeting_out(segments, E, _pick, "speaker"))
        _rows.append(
            _t.with_columns(
                K=pl.lit(_k), picker=pl.col("strategy").str.split(" ").list.last()
            )
        )
    k_sweep = (
        pl.concat(_rows)
        .select("picker", "K", pl.exclude("picker", "K", "strategy"))
        .sort("picker", "K")
    )
    k_sweep
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## Segment probes

    Each held-out segment on its own, matched against the same voiceprints. This
    is a harder task than a 3-turn speaker centroid, but there are far more
    probes, so it is a check that the speaker-level ranking is not noise.
    """)
    return


@app.cell
def _(E, leave_one_meeting_out, operating_points, segments, strategies):
    segment_results = leave_one_meeting_out(segments, E, strategies, "segment")
    segment_table = operating_points(segment_results)
    segment_table
    return


@app.cell
def _(mo):
    mo.md(r"""
    ## Caveats

    - Probes are built from **hand-labelled** segments, so each "speaker" is
      pure. Real diarization clusters mix voices sometimes, which hurts every
      strategy; it may hurt max-scoring more, because one stray exemplar can
      match anything.
    - The enrolment side is also hand-labelled. In production, a person's
      exemplars would come from segments the pipeline itself assigned to them,
      mistakes included. A diverse picker is, by design, drawn towards outliers,
      and an outlier is more likely to be a mislabelled segment.
    - 7 meetings and ~80 known speaker probes: differences of a few points of
      recall are within noise. The segment-level table has more probes.
    """)
    return


if __name__ == "__main__":
    app.run()
