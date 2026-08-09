#!/usr/bin/env python3
"""Offline proof that `verdict.py` refuses the things it claims to refuse.

    python3 eval/selftest.py

No network, no audio, no keys, no dependencies. Every case below is either a mistake this
project actually made or the mechanism that stops it being made again.
"""

import json
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import verdict as V  # noqa: E402

PASSED = []
FAILED = []


def check(name, condition, detail=""):
    (PASSED if condition else FAILED).append(name)
    print("  %s %s%s" % ("ok  " if condition else "FAIL", name, ("  — " + detail) if detail and not condition else ""))


def refuses(name, fn, fragment=""):
    try:
        fn()
    except V.Refused as refusal:
        check(name, fragment in str(refusal), "refusal was %r" % str(refusal))
        return
    check(name, False, "did not refuse")


NAME = {"id": "caller-name", "kind": "name", "truth": "Sikiru"}
POLICY = {"id": "policy", "kind": "identifier", "truth": "PM8592625"}

CONFIG = {
    "provider": "openai-realtime",
    "model": "gpt-4o-transcribe",
    "encoding": "mulaw",
    "sample_rate": 8000,
    "language": "en",
    "endpointing": "semantic_vad/auto",
}


print("\ncanonicalisation — format-insensitive, never value-tolerant")

check("accents and case fold", V.canonical_name("Adédèjì SIKIRU") == "adedeji sikiru")
check(
    "the two provider renderings of one identifier agree",
    V.canonical_identifier("PM8592625")
    == V.canonical_identifier("p m eight five nine two six two five")
    == "pm8592625",
)
check("one wrong digit is still wrong", V.canonical_identifier("PM8592624") != "pm8592625")
check("oh is zero", V.canonical_identifier("oh eight one three") == "0813")
check("double five is 55", V.canonical_identifier("A double five") == "a55")
check(
    "identifiers are grouped, not searched for inside prose",
    V.identifier_groups("my policy number is p m eight five nine two six two five, thanks")
    == ["pm8592625"],
)
check(
    "two identifiers in one turn stay separate",
    V.identifier_groups("policy AB417 and my number is 08138178550")
    == ["ab417", "08138178550"],
)


print("\nrule 1 — ground truth is required, and the match is exact")

check("the truth matches itself", V.match(NAME, "Hi, my name is Sikiru.")[0] is True)
check(
    "CHIKE IS A MISS — the finding that a shape-based assertion hid 6/6",
    V.match(NAME, "Hi, my name is Chike. How are you doing?")[0] is False,
)
check(
    "no partial credit for a near miss",
    V.match(NAME, "my name is Sikira")[0] is False,
)
check(
    "a name inside a longer word is not a hit",
    V.match(NAME, "the sikirus")[0] is False,
)
check("identifier hit", V.match(POLICY, "policy number PM8592625")[0] is True)
check(
    "identifier miss on one digit",
    V.match(POLICY, "policy number PM8592624")[0] is False,
)

refuses(
    "an expected item with no truth is refused, not skipped",
    lambda: V.match({"id": "x", "kind": "name"}, "anything"),
    "no ground truth",
)
refuses(
    "an empty truth is refused",
    lambda: V.match({"id": "x", "kind": "name", "truth": "   "}, "anything"),
    "no ground truth",
)
refuses(
    "an unknown kind is refused rather than guessed",
    lambda: V.match({"id": "x", "kind": "vibes", "truth": "Sikiru"}, "Sikiru"),
    "kind must be one of",
)
refuses(
    "a claim with no expected text is refused outright",
    lambda: V.judge({"configurations": {"a": dict(CONFIG, trials=["x"])}}),
    "no expected text",
)


print("\nrule 2 — repeats before conclusions")

one = V.judge_configuration("a", CONFIG, ["my name is Sikiru"], [NAME])
check("n=1 reaches no verdict", one["items"][0]["verdict"] is None)
check("n=1 says why", "n=1" in one["items"][0]["refusal"])
check("n=1 still shows the observation", one["items"][0]["outcomes"] == ["match"])
check("n=1 makes the configuration unmeasured", one["verdict"] is None)

two = V.judge_configuration("a", CONFIG, ["Sikiru", "Sikiru"], [NAME])
check("n=2 reaches no verdict either", two["items"][0]["verdict"] is None)

three = V.judge_configuration("a", CONFIG, ["Sikiru"] * 3, [NAME])
check("n=3 agreeing gives a verdict", three["items"][0]["verdict"] == "match")
check("n=3 records determinism", three["items"][0].get("deterministic") is True)
check("the configuration verdict follows", three["verdict"] == "match")

deterministic_miss = V.judge_configuration("a", CONFIG, ["Chike"] * 3, [NAME])
check("n=3 agreeing on a miss is a MISS", deterministic_miss["items"][0]["verdict"] == "MISS")

split = V.judge_configuration("a", CONFIG, ["Sikiru", "Chike", "Sikiru"], [NAME])
check("trials that disagree reach no verdict", split["items"][0]["verdict"] is None)
check("the disagreement is reported", "disagree" in split["items"][0]["refusal"])
check("both outcomes are shown", split["items"][0]["outcomes"] == ["match", "MISS", "match"])
check("a split configuration is unmeasured", split["verdict"] is None)


print("\na result without its configuration is not a result")

for key in V.REQUIRED_CONFIG_KEYS:
    incomplete = dict(CONFIG)
    del incomplete[key]
    result = V.judge_configuration("a", incomplete, ["Sikiru"] * 3, [NAME])
    check("missing %s is refused" % key,
          result["verdict"] is None and "not recorded" in result.get("refusal", ""))


print("\nreading tools/stt-compare/compare.mjs output")

SAMPLE = """openai mu-law 8k     4 turn(s)

=== transcripts, same audio ===

openai mu-law 8k
  "Hi, good afternoon."
  "My name is Chike."
  ! speech detected but no turn ever committed

deepgram mu-law 8k
  (nothing)

=== how to read this ===
  providers disagree        -> provider or its configuration
"""

parsed = V.parse_compare_output(SAMPLE)
check("labels are read", sorted(parsed) == ["deepgram mu-law 8k", "openai mu-law 8k"])
check("finals are joined", parsed["openai mu-law 8k"] == "Hi, good afternoon. My name is Chike.")
check("notes are not transcript", "speech detected" not in parsed["openai mu-law 8k"])
check("nothing means nothing", parsed["deepgram mu-law 8k"] == "")
refuses("non-compare output is refused", lambda: V.parse_compare_output("hello"), "not compare.mjs output")


print("\nend to end, through the CLI")

HERE = os.path.dirname(os.path.abspath(__file__))


def run_cli(claim, runs=()):
    with tempfile.TemporaryDirectory() as tmp:
        claim_path = os.path.join(tmp, "claim.json")
        with open(claim_path, "w") as handle:
            json.dump(claim, handle)
        paths = []
        for i, text in enumerate(runs):
            path = os.path.join(tmp, "run%d.txt" % i)
            with open(path, "w") as handle:
                handle.write(text)
            paths.append(path)
        proc = subprocess.run(
            [sys.executable, os.path.join(HERE, "verdict.py"), claim_path] + paths,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, universal_newlines=True)
        return proc.returncode, proc.stdout + proc.stderr


def compare_output(transcript):
    return "%s\n\nopenai mu-law 8k\n  %s\n\n%s\n" % (
        V._MARKER, json.dumps(transcript), V._END)


code, out = run_cli(
    {"claim": "t", "expected": [NAME],
     "configurations": {"openai mu-law 8k": dict(CONFIG, trials=["Sikiru"] * 3)}})
check("a deterministic match exits 0", code == 0, out)

code, out = run_cli(
    {"claim": "t", "expected": [NAME],
     "configurations": {"openai mu-law 8k": dict(CONFIG, trials=["Chike"] * 3)}})
check("a deterministic miss exits 1", code == 1, out)
check("the miss is visible in the report", "MISS" in out)

code, out = run_cli(
    {"claim": "t", "expected": [NAME],
     "configurations": {"openai mu-law 8k": dict(CONFIG, trials=["Sikiru"])}})
check("a single trial exits 2 — nothing measured", code == 2, out)

code, out = run_cli({"claim": "t", "expected": [],
                     "configurations": {"a": dict(CONFIG, trials=["x"] * 3)}})
check("no ground truth exits 2", code == 2, out)
check("and says so on stderr", "REFUSED" in out)

code, out = run_cli(
    {"claim": "t", "expected": [NAME],
     "configurations": {"openai mu-law 8k": dict(CONFIG)}},
    runs=[compare_output("my name is Chike"),
          compare_output("my name is Chike"),
          compare_output("my name is Chike")])
check("three saved compare.mjs runs are read as three trials", code == 1, out)
check("the report shows three outcomes", "MISS MISS MISS" in out, out)

code, out = run_cli(
    {"claim": "t", "expected": [NAME],
     "configurations": {"openai mu-law 8k": dict(CONFIG)}},
    runs=[compare_output("my name is Chike")])
check("one saved run is refused", code == 2, out)


print("\nthe shipped claim file loads and is honest about its gaps")

with open(os.path.join(HERE, "claims", "CAa280584f-name.json")) as handle:
    shipped = json.load(handle)
report = V.judge(shipped, trials_by_label={})
check("it refuses with no trials", all(r["verdict"] is None for r in report["results"]))
check("it declares an unlabelled identifier", any(
    g["id"] == "policy-number" for g in report["unlabelled"]))
check("every unlabelled gap carries a reason", all(
    g.get("reason") for g in report["unlabelled"]))
rendered = V.render(report)
check("the report prints the gaps", "NOT LABELLED" in rendered)


print("\n%d passed, %d failed" % (len(PASSED), len(FAILED)))
if FAILED:
    for name in FAILED:
        print("  FAILED: %s" % name)
sys.exit(1 if FAILED else 0)
