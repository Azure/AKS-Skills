#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, asdict
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import urllib.request

# Minimal YAML reader for the specific test_case.yaml structure used by HolmesGPT fixtures.
# We avoid PyYAML dependency by supporting only the subset we need.

def _strip_comments(s: str) -> str:
    out = []
    for line in s.splitlines():
        if line.strip().startswith("#"):
            continue
        out.append(line)
    return "\n".join(out)


def parse_test_case_yaml(text: str) -> Dict[str, Any]:
    text = _strip_comments(text)
    # Very simple parser: keys: user_prompt (string), expected_output (list or string), before_test (block), after_test (block)
    # We will use regex to extract block scalars and simple lists.
    result: Dict[str, Any] = {}

    # user_prompt: "..."
    m = re.search(r"^user_prompt:\s*\"(.*)\"\s*$", text, flags=re.M)
    if m:
        result["user_prompt"] = m.group(1)

    # expected_output: can be list of '- ...' lines or a single string
    exp_list: List[str] = []
    exp_block = re.search(r"^expected_output:\s*\n((?:\s*-\s*.*\n?)+)", text, flags=re.M)
    if exp_block:
        for line in exp_block.group(1).splitlines():
            line = line.strip()
            if line.startswith("- "):
                exp_list.append(line[2:].strip())
    else:
        m2 = re.search(r"^expected_output:\s*\"(.*)\"\s*$", text, flags=re.M)
        if m2:
            exp_list.append(m2.group(1))
    result["expected_output"] = exp_list

    # before_test: |\n  ...
    m = re.search(r"^before_test:\s*\|\s*\n([\s\S]*?)\n(?=\w|$)", text, flags=re.M)
    if m:
        result["before_test"] = m.group(1)

    # after_test: |\n  ...
    m = re.search(r"^after_test:\s*\|\s*\n([\s\S]*?)\n(?=\w|$)", text, flags=re.M)
    if m:
        result["after_test"] = m.group(1)

    return result


@dataclass
class CaseResult:
    case: str
    prompt: str
    expected: List[str]
    output_text: str
    passed: bool
    score: int
    details: Dict[str, Any]


class HttpClient:
    def __init__(self, base_url: str):
        self.base_url = base_url.rstrip("/")

    def ask(self, prompt: str) -> Dict[str, Any]:
        url = f"{self.base_url}/api/chat"
        payload = json.dumps({"ask": prompt, "stream": False})
        req = urllib.request.Request(url, data=payload.encode("utf-8"), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return json.loads(raw)
            except Exception:
                return {"raw": raw}


def extract_text_from_any(resp: Dict[str, Any]) -> str:
    # Try common fields
    for key in ["answer", "final_answer", "analysis", "message", "content", "text"]:
        v = resp.get(key)
        if isinstance(v, str) and v.strip():
            return v
    # Sometimes nested under data/result
    for path in [["data", "answer"], ["result", "answer"], ["data", "content"], ["message", "content"]]:
        cur = resp
        try:
            for p in path:
                cur = cur[p]
            if isinstance(cur, str) and cur.strip():
                return cur
        except Exception:
            pass
    return json.dumps(resp)[:5000]


def run_shell(block: str, cwd: Optional[str] = None) -> subprocess.CompletedProcess:
    return subprocess.run(block, shell=True, cwd=cwd, check=True, text=True, capture_output=True)


def ask_via_shell(cmd: str, prompt: str) -> str:
    proc = subprocess.run(
        cmd,
        input=prompt,
        shell=True,
        text=True,
        capture_output=True,
        check=True,
    )
    return proc.stdout.strip()


def ask_via_http(base_url: str, prompt: str) -> str:
    client = HttpClient(base_url)
    resp = client.ask(prompt)
    return extract_text_from_any(resp)


# --- Scoring aligned with classifiers.py intent (no external LLM) ---
# We express the rubric here and apply it deterministically so agents can follow it natively.
# Modes:
# - strict: pass only if ALL expected elements are sufficiently present
# - loose: pass if the output reasonably matches the expected content overall


def evaluate_deterministic(expected: List[str], output_text: str, evaluation_type: str) -> Tuple[bool, int, Dict[str, Any]]:
    # Heuristics approximating "sufficiently present":
    # - case-insensitive substring presence as baseline
    # - tolerate punctuation/whitespace differences (already covered by substring on raw text)
    # - agents may choose to normalize numbers/phrases before calling this to be more permissive
    out_lower = output_text.lower()

    if evaluation_type == "loose":
        # Loose: pass if ANY expected element is present
        present = [e for e in expected if e.lower() in out_lower]
        missing = [] if present else expected
        passed = len(present) > 0
    else:
        # Strict: pass if ALL expected elements are present
        missing = [e for e in expected if e.lower() not in out_lower]
        passed = len(missing) == 0

    score = 1 if passed else 0
    meta: Dict[str, Any] = {"missing": missing}
    return passed, score, meta


def evaluate_with_llm(expected: List[str], output_text: str, evaluation_type: str, model: str, base_url: str, api_key: str) -> Tuple[bool, int, Dict[str, Any]]:
    prompt = build_eval_prompt(expected, output_text, evaluation_type)
    # Call OpenAI-compatible Chat Completions API
    url = f"{base_url.rstrip('/')}/v1/chat/completions"
    payload = {
        "model": model,
        "temperature": 0,
        "max_tokens": 64,
        "messages": [
            {"role": "system", "content": "You are a strict evaluator. Reply with 'A' or 'B' on the first line, then a brief rationale."},
            {"role": "user", "content": prompt},
        ],
    }
    data = json.dumps(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
    req = urllib.request.Request(url, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            j = json.loads(raw)
            content = j.get("choices", [{}])[0].get("message", {}).get("content", "").strip()
    except Exception as e:
        return evaluate_deterministic(expected, output_text, evaluation_type)

    first_line = content.splitlines()[0].strip() if content else ""
    choice = "A" if first_line.upper().startswith("A") else "B"
    score = 1 if choice == "A" else 0
    passed = score == 1
    return passed, score, {"choice": choice, "rationale": content}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fixtures-root", required=True)
    ap.add_argument("--filter", default="")
    ap.add_argument("--output", default=str(Path(__file__).resolve().parents[1] / "results"))
    ap.add_argument("--mode", choices=["shell", "http"], required=True)
    ap.add_argument("--ask-cmd", default="")
    ap.add_argument("--eval", choices=["strict", "loose"], default="strict")
    # LLM-based evaluation removed per skill guidance; agents should apply the scoring rules directly.
    args = ap.parse_args()

    fixtures_root = Path(args.fixtures_root)
    if not fixtures_root.exists():
        print(f"Fixtures root not found: {fixtures_root}", file=sys.stderr)
        sys.exit(1)

    cases = [p for p in sorted(fixtures_root.iterdir()) if p.is_dir() and (args.filter in p.name)]
    if not cases:
        print("No cases found matching filter", file=sys.stderr)
        sys.exit(1)

    base_url = os.environ.get("HOLMESGPT_URL", "http://127.0.0.1:5050")

    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = Path(args.output) / ts
    out_dir.mkdir(parents=True, exist_ok=True)

    results: List[CaseResult] = []

    for case_dir in cases:
        yaml_path = case_dir / "test_case.yaml"
        if not yaml_path.exists():
            continue
        raw = yaml_path.read_text()
        tc = parse_test_case_yaml(raw)
        user_prompt = tc.get("user_prompt", "").strip()
        expected = tc.get("expected_output", [])
        before = tc.get("before_test", "").strip()
        after = tc.get("after_test", "").strip()

        print(f"\n=== Running case: {case_dir.name} ===")
        print(f"Prompt: {user_prompt}")

        before_stdout = before_stderr = after_stdout = after_stderr = ""
        output_text = ""
        passed = False
        score = 0
        eval_meta: Dict[str, Any] = {}

        try:
            if before:
                print("-- before_test --")
                completed = run_shell(before, cwd=str(case_dir))
                before_stdout, before_stderr = completed.stdout, completed.stderr

            # Ask the agent via selected backend
            if args.mode == "shell":
                if not args.ask_cmd:
                    raise RuntimeError("shell mode requires --ask-cmd")
                output_text = ask_via_shell(args.ask_cmd, user_prompt)
            else:
                output_text = ask_via_http(base_url, user_prompt)

            # Evaluate
            if args.llm_eval and os.getenv("OPENAI_API_KEY"):
                passed, score, eval_meta = evaluate_with_llm(
                    expected, output_text, args.eval, args.classifier_model, args.openai_base, os.environ["OPENAI_API_KEY"]
                )
            else:
                passed, score, eval_meta = evaluate_deterministic(expected, output_text, args.eval)
        except subprocess.CalledProcessError as e:
            before_stderr = before_stderr + "\n" + str(e)
            print(f"before_test failed: {e}")
        except Exception as e:
            print(f"Error during ask/eval: {e}")
        finally:
            try:
                if after:
                    print("-- after_test --")
                    completed = run_shell(after, cwd=str(case_dir))
                    after_stdout, after_stderr = completed.stdout, completed.stderr
            except subprocess.CalledProcessError as e:
                after_stderr = after_stderr + "\n" + str(e)

        details = {
            "case_dir": str(case_dir),
            "before_stdout": before_stdout,
            "before_stderr": before_stderr,
            "after_stdout": after_stdout,
            "after_stderr": after_stderr,
            "evaluation": eval_meta,
            "mode": args.mode,
            "evaluation_type": args.eval,
            "llm_eval": bool(args.llm_eval and os.getenv("OPENAI_API_KEY")),
        }

        results.append(
            CaseResult(
                case=case_dir.name,
                prompt=user_prompt,
                expected=expected,
                output_text=output_text,
                passed=passed,
                score=score,
                details=details,
            )
        )

    # Write JSON results
    json_path = out_dir / "results.json"
    with json_path.open("w") as f:
        json.dump([asdict(r) for r in results], f, indent=2)

    # Write Markdown report (inspired by run_benchmarks_local.py)
    total = len(results)
    passed_n = sum(1 for r in results if r.passed)
    failed_n = total - passed_n

    md: List[str] = []
    md.append(f"# HolmesGPT Local Eval Report (Agent-Agnostic)\n")
    md.append(f"Date: {datetime.now().isoformat()}\n")
    md.append("")
    md.append(f"Summary: {passed_n}/{total} passed, {failed_n} failed\n")
    md.append("")

    for r in results:
        md.append(f"## {r.case} — {'PASSED' if r.passed else 'FAILED'}\n")
        md.append("")
        md.append(f"Prompt: {r.prompt}\n")
        md.append("")
        md.append("Expected contains (evaluation: {}):\n".format(r.details.get("evaluation_type", "strict")))
        for e in r.expected:
            md.append(f"- {e}\n")
        md.append("")
        md.append("Agent Output:\n")
        md.append("""```\n""" + (r.output_text or "") + "\n```\n")
        if not r.passed and r.details.get("evaluation", {}).get("missing"):
            md.append("Missing elements:\n")
            for m in r.details["evaluation"]["missing"]:
                md.append(f"- {m}\n")
        if r.details.get("llm_eval") and r.details.get("evaluation", {}).get("rationale"):
            md.append("LLM rationale:\n")
            md.append("""```\n""" + r.details["evaluation"]["rationale"] + "\n```\n")
        md.append("")

    report_path = out_dir / "report.md"
    report_path.write_text("\n".join(md))

    # Update latest-results.md as a simple redirect (relative)
    latest = Path(__file__).resolve().parents[1] / "latest-results.md"
    rel = os.path.relpath(report_path, start=latest.parent)
    latest.write_text(
        f"# Latest Results\n\nSee [{report_path.name}]({rel}).\n"
    )

    print(f"\nWrote {json_path}")
    print(f"Wrote {report_path}")


if __name__ == "__main__":
    main()
