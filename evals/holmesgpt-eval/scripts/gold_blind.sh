#!/usr/bin/env bash
# gold_blind.sh - helpers to enforce gold-blind answering for eval cases
# Usage (from a case directory containing test_case.yaml):
#   source evals/holmesgpt-eval/scripts/gold_blind.sh
#   lock_case_yaml   # chmod 000 test_case.yaml
#   unlock_case_yaml # chmod 644 test_case.yaml (if exists)

set -euo pipefail

lock_case_yaml() {
  if [ -f test_case.yaml ]; then
    chmod 000 test_case.yaml || true
  fi
}

unlock_case_yaml() {
  if [ -f test_case.yaml ]; then
    chmod 644 test_case.yaml || true
  elif [ -f test_case.yaml.locked ]; then
    mv test_case.yaml.locked test_case.yaml || true
  fi
}

