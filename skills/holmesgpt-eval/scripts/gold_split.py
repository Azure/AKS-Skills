#!/usr/bin/env python3
"""
Split expected_output (the gold answer) out of a HolmesGPT test_case.yaml into a separate file,
so the solver can answer blind without access to the gold.

Default (non-destructive):
- Reads <case>/test_case.yaml
- Writes <case>/test_case.solver.yaml (same content minus expected_output)
- Writes <gold_root>/<rel_case>/gold.json with { expected_output: [...], evaluation: {...} }
- Leaves the original test_case.yaml untouched

Optionally, use --in-place to overwrite test_case.yaml and write a .bak for restore.

Usage:
  python3 scripts/gold_split.py split --case <path-to-case-dir> [--gold-root <dir>] [--in-place]
  python3 scripts/gold_split.py restore --case <path-to-case-dir> [--gold-root <dir>] [--in-place]

Bulk example:
  find vendor/holmesgpt/tests/llm/fixtures/test_ask_holmes -type f -name test_case.yaml -exec \
    python3 scripts/gold_split.py split --case "$(dirname {})" \;
"""

import argparse
import json
import os
import sys
from pathlib import Path

try:
    import yaml
except Exception:
    print("ERROR: PyYAML is required (pip install pyyaml)", file=sys.stderr)
    sys.exit(2)


def read_yaml(path: Path):
    with path.open('r', encoding='utf-8') as f:
        return yaml.safe_load(f)


def write_yaml(path: Path, data: dict):
    # Note: style/formatting may differ from original; this is intended for solver use.
    with path.open('w', encoding='utf-8') as f:
        yaml.safe_dump(data, f, sort_keys=False, default_flow_style=False)


def write_json(path: Path, data: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    with tmp.open('w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    tmp.replace(path)


def split_case(case_dir: Path, gold_root: Path, in_place: bool):
    tc = case_dir / 'test_case.yaml'
    if not tc.exists():
        raise FileNotFoundError(f"{tc} not found")

    data = read_yaml(tc)

    # Normalize expected_output to a list of strings, if present
    expected = data.get('expected_output', None)
    if expected is None:
        expected_list = []
    elif isinstance(expected, list):
        expected_list = [str(x) for x in expected]
    else:
        expected_list = [str(expected)]

    # Prepare gold payload: only expected_output is moved out
    gold_payload = {
        'expected_output': expected_list,
    }

    # Compute gold output path under gold_root, mirroring relative structure from repo root if possible
    # Use case_dir relative to the skills/holmesgpt-eval root when present
    # Fallback: store under gold_root/<case_dir_name>
    try:
        # Attempt to find repo root by walking up until we see skills/holmesgpt-eval
        p = case_dir
        root = None
        for _ in range(8):
            if (p / 'skills' / 'holmesgpt-eval').exists():
                root = p
                break
            p = p.parent
        if root is None:
            raise RuntimeError
        rel = case_dir.relative_to(root)
    except Exception:
        rel = Path(case_dir.name)

    gold_path = gold_root / rel / 'gold.json'
    write_json(gold_path, gold_payload)

    # Produce solver YAML (without expected_output) — keep evaluation and other fields intact
    data.pop('expected_output', None)

    if in_place:
        # Backup original and overwrite
        bak = tc.with_suffix('.yaml.bak')
        if not bak.exists():
            tc.replace(bak)
        write_yaml(tc, data)
    else:
        solver = case_dir / 'test_case.solver.yaml'
        write_yaml(solver, data)

    return {
        'gold': str(gold_path),
        'solver': str(tc if in_place else (case_dir / 'test_case.solver.yaml')),
        'in_place': in_place,
    }


def restore_case(case_dir: Path, gold_root: Path, in_place: bool):
    tc = case_dir / 'test_case.yaml'
    bak = case_dir / 'test_case.yaml.bak'
    solver = case_dir / 'test_case.solver.yaml'

    # If we overwrote in-place previously, restore from .bak
    if in_place and bak.exists():
        tc.unlink(missing_ok=True)
        bak.replace(tc)
        return {'restored': str(tc), 'from': str(bak)}

    # Non-destructive mode: nothing to restore inside case_dir
    # Gold files can be left as-is; they are outside case_dir.
    if solver.exists():
        # Solver file can be removed if desired
        solver.unlink()
        return {'removed_solver': str(solver)}

    return {'noop': True}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('command', choices=['split', 'restore'])
    ap.add_argument('--case', required=True, help='Path to a single case directory (contains test_case.yaml)')
    ap.add_argument('--gold-root', default=str(Path.home() / '.openclaw' / 'workspace' / 'skills' / 'holmesgpt-eval' / '_gold'),
                    help='Directory where gold.json will be written (outside the case dir)')
    ap.add_argument('--in-place', action='store_true', help='Modify test_case.yaml in place (creates .bak) instead of writing test_case.solver.yaml')
    args = ap.parse_args()

    case_dir = Path(args.case).resolve()
    gold_root = Path(args.gold_root).resolve()

    if args.command == 'split':
        out = split_case(case_dir, gold_root, args.in_place)
        print(json.dumps({'ok': True, **out}))
    else:
        out = restore_case(case_dir, gold_root, args.in_place)
        print(json.dumps({'ok': True, **out}))


if __name__ == '__main__':
    main()
