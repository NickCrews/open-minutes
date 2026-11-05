"""Tests for psvtool.py. Run: python3 -m unittest discover -s .claude/skills/transcript-cleanup/scripts"""
import os
import tempfile
import unittest

import psvtool


def words(*pairs):
    """[[onset, text], ...] from ("0:00:01.00", "text") pairs."""
    return [[psvtool.parse_ts(t), w] for t, w in pairs]


def onsets(ws):
    return [(psvtool.fmt_ts(t), w) for t, w in ws]


class SpliceTest(unittest.TestCase):
    def splice(self, old, new_text):
        ws = words(*old)
        psvtool.splice(ws, 0, len(ws), new_text.split())
        return onsets(ws)

    def test_shorter_number_keeps_following_word_onset(self):
        got = self.splice(
            [("0:00:01.00", "title"), ("0:00:02.00", "twenty"), ("0:00:03.00", "one."), ("0:00:04.00", "Neighbors")],
            "Title 21. Neighbors",
        )
        self.assertEqual(got, [("0:00:01.00", "Title"), ("0:00:02.00", "21."), ("0:00:04.00", "Neighbors")])

    def test_collapsed_run_takes_first_onset(self):
        got = self.splice(
            [("0:00:01.00", "twenty"), ("0:00:02.00", "twenty"), ("0:00:03.00", "six")],
            "2026",
        )
        self.assertEqual(got, [("0:00:01.00", "2026")])

    def test_rewritten_run_maps_first_to_first_and_last_to_last(self):
        got = self.splice(
            [("0:00:01.00", "eleven"), ("0:00:02.00", "thirty"), ("0:00:03.00", "PM")],
            "11:30 p.m.",
        )
        self.assertEqual(got, [("0:00:01.00", "11:30"), ("0:00:03.00", "p.m.")])

    def test_same_length_rewrite_keeps_positions(self):
        got = self.splice(
            [("0:00:01.00", "Gridwood"), ("0:00:02.00", "board")],
            "Girdwood board",
        )
        self.assertEqual(got, [("0:00:01.00", "Girdwood"), ("0:00:02.00", "board")])

    def test_case_and_trailing_punctuation_count_as_unchanged(self):
        got = self.splice(
            [("0:00:01.00", "five"), ("0:00:02.00", "dollars"), ("0:00:03.00", "today.")],
            "$5 Today",
        )
        self.assertEqual(got, [("0:00:01.00", "$5"), ("0:00:03.00", "Today")])

    def test_inserted_word_shares_onset_of_word_before(self):
        got = self.splice(
            [("0:00:01.00", "July"), ("0:00:02.00", "August")],
            "July or August",
        )
        self.assertEqual(got, [("0:00:01.00", "July"), ("0:00:01.00", "or"), ("0:00:02.00", "August")])

    def test_expanded_run_shares_the_one_onset(self):
        got = self.splice([("0:00:01.00", "AMC")], "Anchorage Municipal Code")
        self.assertEqual(
            got, [("0:00:01.00", "Anchorage"), ("0:00:01.00", "Municipal"), ("0:00:01.00", "Code")]
        )

    def test_empty_new_deletes(self):
        self.assertEqual(self.splice([("0:00:01.00", "um"), ("0:00:02.00", "uh")], ""), [])

    def test_onsets_stay_in_order(self):
        cases = [
            ("a b c d e f", "a X Y Z f"),
            ("one two three four", "1 2 3 4 five"),
            ("ten echo two ten echo four", "10E2 10E4"),
            ("x y", "p q r s t"),
        ]
        for old, new in cases:
            with self.subTest(old=old, new=new):
                ws = [[100 * (k + 1), w] for k, w in enumerate(old.split())]
                psvtool.splice(ws, 0, len(ws), new.split())
                ts = [t for t, _ in ws]
                self.assertEqual(ts, sorted(ts))
                self.assertEqual([w for _, w in ws], new.split())

    def test_only_the_spliced_range_changes(self):
        ws = words(("0:00:01.00", "a"), ("0:00:02.00", "twenty"), ("0:00:03.00", "one"), ("0:00:04.00", "b"))
        psvtool.splice(ws, 1, 2, ["21"])
        self.assertEqual(onsets(ws), [("0:00:01.00", "a"), ("0:00:02.00", "21"), ("0:00:04.00", "b")])


PSV = """start_sec|event_type|event_data
0:00:01.00|meta|{"begin_speaker":"identified:jane-doe"}
0:00:01.00|text|title
0:00:02.00|text|twenty
0:00:03.00|text|one.
0:00:04.00|text|Neighbors
0:00:05.00|text|said
0:00:06.00|text|no.
"""


class ApplyReplaceTest(unittest.TestCase):
    def setUp(self):
        fd, self.path = tempfile.mkstemp(suffix=".psv")
        with os.fdopen(fd, "w", encoding="utf8") as f:
            f.write(PSV)

    def tearDown(self):
        os.remove(self.path)

    def test_replace_round_trip(self):
        segs = psvtool.load(self.path)
        psvtool.apply(segs, [{"op": "replace", "at": "0:00:01.00", "old": "title twenty one.", "new": "Title 21."}])
        psvtool.save(self.path, segs)
        with open(self.path, encoding="utf8") as f:
            text = f.read()
        self.assertEqual(
            text,
            """start_sec|event_type|event_data
0:00:01.00|meta|{"begin_speaker":"identified:jane-doe"}
0:00:01.00|text|Title
0:00:02.00|text|21.
0:00:04.00|text|Neighbors
0:00:05.00|text|said
0:00:06.00|text|no.
""",
        )

    def test_replace_all_keeps_unchanged_onsets(self):
        segs = psvtool.load(self.path)
        psvtool.apply(segs, [{"op": "replace_all", "old": "twenty one", "new": "21"}])
        self.assertEqual(
            onsets(segs[0]["words"]),
            [
                ("0:00:01.00", "title"),
                ("0:00:02.00", "21."),
                ("0:00:04.00", "Neighbors"),
                ("0:00:05.00", "said"),
                ("0:00:06.00", "no."),
            ],
        )

    def test_replace_refuses_mismatched_old(self):
        segs = psvtool.load(self.path)
        with self.assertRaises(SystemExit) as cm:
            psvtool.apply(segs, [{"op": "replace", "at": "0:00:02.00", "old": "twenty two", "new": "22"}])
        self.assertIn("expected ['twenty', 'two']", str(cm.exception))


if __name__ == "__main__":
    unittest.main()
