#!/usr/bin/env python3
"""Two rules, enforced, so that today's two mistakes cannot be made again.

Standard library only, run by hand, imports nothing from the monorepo and is imported by
nothing in it (CLAUDE.md rule 0). This is not the Gate A harness — see `README.md` for
what that still needs and why it was deferred.

WHAT THIS REFUSES TO LET YOU DO

1.  **Score against a shape instead of against what was said.** On 2026-08-08 a caller
    said "Sikiru" and six runs out of six returned "Chike". The trial asserted that "a
    name-shaped token followed 'my name is'"; it passed 6/6 while being wrong 6/6, because
    ground truth was known and unused. Every comparison here takes a truth string. There
    is no code path that scores a hypothesis against a pattern, and an expected item with
    no `truth` is a refusal, not a skip.

    Matching is exact. "Chike" and "Sikiru" share three characters in order, and any
    similarity metric scores that as partial credit — that is the metric that hid this for
    a day. A name that is 60% right is 100% wrong, and so is a policy number.

2.  **Conclude from one run.** Four provider comparisons on this project were each decided
    from a single sample and each reversed by the next run; one of them enabled and then
    reverted a production flag. Fewer than three trials produces observations and no
    verdict. Three trials that disagree produce the disagreement and no verdict. A
    configuration with no recorded settings produces nothing at all, because a result
    without its configuration cannot be compared with anything.

USAGE

    python3 eval/verdict.py CLAIM.json
    python3 eval/verdict.py CLAIM.json run1.txt run2.txt run3.txt
    python3 eval/verdict.py CLAIM.json --json

`CLAIM.json` carries the ground truth and the configurations. Trials come either from a
`trials` list inside each configuration, or from the saved stdout of
`tools/stt-compare/compare.mjs` — one file per run, passed as arguments. Three runs of

    node tools/stt-compare/compare.mjs recordings/CAxxxx.ulaw | tee eval/runs/1.txt

is the intended workflow, and passing one of them is meant to be visibly unsatisfying.

EXIT CODES

    0   every expected item was measured and every one matched
    1   measured, and something did not match
    2   refused — nothing here is a measurement
"""

import json
import re
import sys
import unicodedata

MIN_TRIALS = 3
"""Below this there is no verdict. See rule 2 above."""

# A result whose settings were not written down cannot be compared with another result,
# which is the only thing anyone ever wants to do with it.
REQUIRED_CONFIG_KEYS = ("provider", "model", "encoding", "sample_rate", "language", "endpointing")

KINDS = ("name", "identifier")

_UNITS = {
    "zero": "0", "oh": "0", "o": "0", "nought": "0", "naught": "0",
    "one": "1", "two": "2", "three": "3", "four": "4", "five": "5",
    "six": "6", "seven": "7", "eight": "8", "nine": "9", "ten": "10",
    "eleven": "11", "twelve": "12", "thirteen": "13", "fourteen": "14",
    "fifteen": "15", "sixteen": "16", "seventeen": "17", "eighteen": "18",
    "nineteen": "19",
}
_TENS = {
    "twenty": "20", "thirty": "30", "forty": "40", "fourty": "40", "fifty": "50",
    "sixty": "60", "seventy": "70", "eighty": "80", "ninety": "90",
}
_REPEATS = {"double": 2, "triple": 3, "treble": 3}


class Refused(Exception):
    """The honest answer is a gap, not a number."""


# ---------------------------------------------------------------------------
# Canonicalisation. Format-insensitive, never value-tolerant.
# ---------------------------------------------------------------------------

def _strip_accents(text):
    decomposed = unicodedata.normalize("NFD", text)
    return "".join(c for c in decomposed if unicodedata.category(c) != "Mn")


def _tokens(text):
    lowered = _strip_accents(text).lower().replace("’", "'")
    return [t for t in re.split(r"[^0-9a-z'\-]+", lowered) if t not in ("", "'", "-")]


def canonical_name(text):
    """Accents stripped, lowercased, spacing collapsed. Nothing else.

    No nickname table, no edit distance, no phonetic bucketing. "Chike" and "Sikiru" must
    come out as different strings, and they do.
    """
    return " ".join(_tokens(text))


def canonical_identifier(text):
    """A read-aloud identifier reduced to the characters that carry it.

    Two providers write the same correct answer differently: OpenAI returns `PM8592625`
    where Deepgram returns `p m eight five nine two six two five` (STACK_DECISION,
    2026-08-08), and both are right. Folding those together is format-insensitivity, not
    tolerance — `PM8592624` still does not match `PM8592625`.

    Covers the forms a caller actually uses: digit by digit, letters mixed in, "oh" for
    zero, "double five" for 55, teens and tens as two digits.
    """
    out = []
    repeat = 1
    for token in _tokens(text):
        if token in _REPEATS:
            repeat = _REPEATS[token]
            continue
        piece = _UNITS.get(token) or _TENS.get(token) or re.sub(r"[^0-9a-z]", "", token)
        if piece == "":
            continue
        out.append(piece * repeat)
        repeat = 1
    return "".join(out)


_IDENTIFIERISH = set(_UNITS) | set(_TENS) | set(_REPEATS)


def identifier_groups(text):
    """Every maximal run of identifier-ish tokens in a transcript, canonicalised.

    A transcript is one long string. Asking whether the truth's digits appear *anywhere
    inside* it would match across unrelated words and call that a hit, so runs are grouped
    first and compared whole. That keeps "exact match" meaning what it says.
    """
    groups = []
    run = []
    for token in _tokens(text):
        numberish = (
            token in _IDENTIFIERISH
            or any(c.isdigit() for c in token)
            or (len(token) == 1 and token.isalpha())
        )
        if numberish:
            run.append(token)
        elif run:
            groups.append(" ".join(run))
            run = []
    if run:
        groups.append(" ".join(run))
    canonical = [canonical_identifier(g) for g in groups]
    return [g for g in canonical if g != ""]


# ---------------------------------------------------------------------------
# One expected item against one transcript
# ---------------------------------------------------------------------------

def match(item, transcript):
    """Exact match of one expected item against one trial's transcript.

    Returns (hit, evidence). `evidence` is what was compared, so a reader can check the
    comparison rather than trust the verdict — every wrong conclusion on this project so
    far came from a summary that had thrown the comparison away.
    """
    kind = item.get("kind")
    truth = item.get("truth")

    if kind not in KINDS:
        raise Refused("expected item %r: kind must be one of %s, got %r"
                      % (item.get("id"), "/".join(KINDS), kind))
    if not isinstance(truth, str) or truth.strip() == "":
        raise Refused(
            "expected item %r has no ground truth. Nothing is scored against a shape here "
            "— that is the mistake this tool exists to prevent. Either write down what the "
            "caller actually said, or move the item to \"unlabelled\"." % (item.get("id"),)
        )

    if kind == "name":
        want = canonical_name(truth).split()
        have = canonical_name(transcript).split()
        span = len(want)
        hit = any(have[i:i + span] == want for i in range(0, max(0, len(have) - span + 1)))
        return hit, {"looked_for": " ".join(want)}

    want = canonical_identifier(truth)
    found = identifier_groups(transcript)
    return want in found, {"looked_for": want, "identifiers_in_transcript": found}


# ---------------------------------------------------------------------------
# Trials
# ---------------------------------------------------------------------------

def judge_configuration(label, config, trials, expected, min_trials=MIN_TRIALS):
    """Verdict for one configuration across its trials, or the reason there isn't one."""
    report = {"configuration": label, "config": config, "trials": len(trials)}

    missing = [k for k in REQUIRED_CONFIG_KEYS if config.get(k) in (None, "")]
    if missing:
        report["verdict"] = None
        report["refusal"] = (
            "configuration not recorded: missing %s. A result without its configuration "
            "cannot be compared with anything, so it is not scored."
            % ", ".join(missing)
        )
        return report

    if not trials:
        report["verdict"] = None
        report["refusal"] = "no trials supplied"
        return report

    items = []
    for item in expected:
        outcomes = []
        evidence = []
        for transcript in trials:
            hit, why = match(item, transcript)
            outcomes.append(hit)
            evidence.append(why)

        row = {
            "id": item.get("id"),
            "kind": item["kind"],
            "truth": item["truth"],
            "outcomes": ["match" if o else "MISS" for o in outcomes],
            "evidence": evidence[0],
        }
        if not all(outcomes):
            # A miss is only half a finding without what arrived instead. This is the
            # whole transcript rather than an excerpt around an anchor: "the token after
            # 'my name is'" is exactly the shape-shaped assertion that passed 6/6 while
            # being wrong 6/6, and it is not going back in.
            row["heard_instead"] = [t for t, o in zip(trials, outcomes) if not o][0]

        if len(trials) < min_trials:
            row["verdict"] = None
            row["refusal"] = (
                "n=%d. %d trials are required before this is a result rather than an "
                "observation — four comparisons on this project were decided from a single "
                "run and reversed by the next." % (len(trials), min_trials)
            )
        elif len(set(outcomes)) > 1:
            row["verdict"] = None
            row["refusal"] = (
                "the trials disagree (%s). Nothing is summarised over a disagreement; run "
                "more trials and report the instability, because that instability is the "
                "finding." % ", ".join(row["outcomes"])
            )
        else:
            row["verdict"] = "match" if outcomes[0] else "MISS"
            row["deterministic"] = True
        items.append(row)

    report["items"] = items
    measured = [i for i in items if i["verdict"] is not None]
    report["verdict"] = None if not measured else (
        "match" if all(i["verdict"] == "match" for i in measured) else "MISS"
    )
    if not measured:
        report["refusal"] = "nothing in this configuration reached a verdict"
    return report


def judge(claim, trials_by_label=None, min_trials=MIN_TRIALS):
    """The whole claim. Raises Refused when there is no ground truth at all."""
    expected = claim.get("expected") or []
    if not expected:
        raise Refused(
            "the claim carries no expected text. A run with no ground truth is refused "
            "rather than reported (R9.1.4: never seed truth from a candidate's output)."
        )
    for item in expected:
        match(item, "")  # validates kind and truth up front, before any scoring happens

    configurations = claim.get("configurations") or {}
    if not configurations:
        raise Refused("the claim names no configurations")

    results = []
    for label in sorted(configurations):
        config = dict(configurations[label])
        trials = config.pop("trials", None)
        if trials_by_label is not None:
            trials = trials_by_label.get(label, [])
        results.append(judge_configuration(label, config, trials or [], expected, min_trials))

    return {
        "claim": claim.get("claim"),
        "audio": claim.get("audio"),
        "expected": expected,
        "unlabelled": claim.get("unlabelled") or [],
        "results": results,
    }


# ---------------------------------------------------------------------------
# Reading trials out of compare.mjs stdout
# ---------------------------------------------------------------------------

_MARKER = "=== transcripts, same audio ==="
_END = "=== how to read this ==="


def parse_compare_output(text):
    """One run of `tools/stt-compare/compare.mjs` as {label: transcript}.

    The tool prints each configuration's finals as JSON string literals under a bare
    label. Its notes (`! …`) are diagnostics about why a run produced nothing and are not
    transcript, so they are dropped here rather than scored.
    """
    if _MARKER not in text:
        raise Refused("not compare.mjs output: %r is missing" % _MARKER)
    body = text.split(_MARKER, 1)[1].split(_END, 1)[0]

    out = {}
    label = None
    finals = []
    for raw in body.splitlines():
        if raw.strip() == "":
            continue
        if not raw.startswith(" "):
            if label is not None:
                out[label] = " ".join(finals)
            label = raw.strip()
            finals = []
            continue
        line = raw.strip()
        if line.startswith("!") or line == "(nothing)":
            continue
        try:
            finals.append(json.loads(line))
        except ValueError:
            finals.append(line)
    if label is not None:
        out[label] = " ".join(finals)
    return out


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def render(report):
    lines = []
    if report.get("claim"):
        lines.append(report["claim"])
    if report.get("audio"):
        lines.append("audio: %s" % report["audio"])
    lines.append("")
    lines.append("ground truth")
    for item in report["expected"]:
        lines.append("  %-14s %-11s %s" % (item.get("id"), item["kind"], json.dumps(item["truth"])))
    for gap in report["unlabelled"]:
        lines.append("  %-14s %-11s NOT LABELLED — %s"
                     % (gap.get("id"), gap.get("kind", "?"), gap.get("reason", "no reason given")))
    lines.append("")

    for result in report["results"]:
        lines.append("%s  (%d trial%s)"
                     % (result["configuration"], result["trials"],
                        "" if result["trials"] == 1 else "s"))
        config = result["config"]
        lines.append("  config: %s" % ", ".join(
            "%s=%s" % (k, config.get(k)) for k in REQUIRED_CONFIG_KEYS))
        extra = sorted(k for k in config if k not in REQUIRED_CONFIG_KEYS)
        if extra:
            lines.append("          %s" % ", ".join("%s=%s" % (k, config[k]) for k in extra))
        if "items" not in result:
            lines.append("  REFUSED: %s" % result["refusal"])
            lines.append("")
            continue
        for item in result["items"]:
            outcomes = " ".join(item["outcomes"])
            if item["verdict"] is None:
                lines.append("  %-14s no verdict   [%s]" % (item["id"], outcomes))
                lines.append("      %s" % item["refusal"])
            else:
                lines.append("  %-14s %-12s [%s]" % (item["id"], item["verdict"], outcomes))
            evidence = item["evidence"]
            lines.append("      looked for %s" % json.dumps(evidence["looked_for"]))
            if "identifiers_in_transcript" in evidence:
                lines.append("      transcript held %s"
                             % json.dumps(evidence["identifiers_in_transcript"]))
            if "heard_instead" in item:
                heard = item["heard_instead"]
                lines.append("      heard instead %s"
                             % json.dumps(heard if len(heard) <= 240 else heard[:240] + "…"))
        lines.append("")

    return "\n".join(lines)


def exit_code(report):
    verdicts = [r.get("verdict") for r in report["results"]]
    if all(v is None for v in verdicts):
        return 2
    return 0 if all(v in (None, "match") for v in verdicts) else 1


def main(argv):
    args = [a for a in argv if a != "--json"]
    as_json = "--json" in argv
    if not args:
        sys.stderr.write(__doc__)
        return 2

    with open(args[0]) as handle:
        claim = json.load(handle)

    trials_by_label = None
    if len(args) > 1:
        trials_by_label = {}
        for path in args[1:]:
            with open(path) as handle:
                for label, transcript in parse_compare_output(handle.read()).items():
                    trials_by_label.setdefault(label, []).append(transcript)

    try:
        report = judge(claim, trials_by_label)
    except Refused as refusal:
        sys.stderr.write("REFUSED: %s\n" % refusal)
        return 2

    print(json.dumps(report, indent=2) if as_json else render(report))
    return exit_code(report)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
