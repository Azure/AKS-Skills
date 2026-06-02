"""
AKS Skill Routing Eval
======================
Tests which skill(s) an agent would invoke for a set of AKS-related prompts.

Uses OpenAI-compatible API (works with litellm proxy, GitHub Copilot endpoint, etc.)

Setup:
  pip install openai
  export OPENAI_API_KEY=your-token
  export OPENAI_BASE_URL=http://localhost:4000/v1   # your litellm proxy

Usage:
  python skill_routing_eval.py

  # Or override via CLI:
  OPENAI_BASE_URL=http://localhost:4000/v1 OPENAI_API_KEY=xxx python skill_routing_eval.py
"""

import json
import os
from openai import OpenAI

# ─── CONFIG ──────────────────────────────────────────────────────────────────

MODEL = os.environ.get("EVAL_MODEL", "claude-sonnet-4-20250514")  # model name as litellm sees it

# ─── SKILLS ──────────────────────────────────────────────────────────────────
# Paste your skill names + descriptions here.

SKILLS = [
    {
        "name": "azure-kubernetes/best-practices",
        "description": "Plan, create, and configure production-ready AKS clusters. Day-0 decisions (networking, SKU, API server), security, observability, upgrades, node pools, reliability. WHEN: create AKS cluster, plan cluster, Day-0, networking, CNI, overlay, egress, ingress, SKU, Automatic vs Standard, security, Entra, observability, Prometheus, Grafana, upgrades, maintenance window, node pools, KEDA, reliability, PDB.",
    },
    {
        "name": "azure-kubernetes/automatic-readiness",
        "description": "Assess Kubernetes workloads and cluster configuration for AKS Automatic compatibility. Identifies incompatibilities, generates fixes, and guides migration from AKS Standard to AKS Automatic. WHEN: migrate to AKS Automatic, check AKS Automatic readiness, validate manifests for Automatic, assess cluster for Automatic compatibility.",
    },
    {
        "name": "azure-kubernetes/troubleshooting",
        "description": "Debug AKS issues: pod failures, node problems, networking, load balancer/ingress, network policy, upgrade failures, spot/zone issues. WHEN: pod crash, CrashLoopBackOff, node not ready, DNS failure, connectivity, timeout, 502, 503, upgrade stuck, OOM, eviction, load balancer, ingress error, network policy denied, spot interrupted.",
    },
    {
        "name": "azure-kubernetes/cost-optimization",
        "description": "AKS cost optimization: namespace-level cost visibility, cost anomaly detection, cluster autoscaler tuning, pod rightsizing, VPA setup, spot node pools. WHEN: cost analysis, cost add-on, namespace cost, cost anomaly, spending breakdown, idle nodes, autoscaler, scale-down, rightsizing, VPA, spot nodes, cheaper nodes.",
    },
    # Add competing skills that might steal AKS prompts:
    {
        "name": "azure-diagnostics",
        "description": "Debug Azure production issues using AppLens, Azure Monitor, resource health, and safe triage. WHEN: debug production issues, troubleshoot app service, high CPU, app service errors.",
    },
    {
        "name": "azure-cost",
        "description": "Unified Azure cost management: query historical costs, forecast future spending, and optimize to reduce waste. WHEN: Azure costs, Azure spending, Azure bill, cost breakdown.",
    },
]

# ─── TEST CASES ──────────────────────────────────────────────────────────────
# (prompt, expected_skill_name)

TEST_CASES = [
    # Best Practices
    ("I need to create a new production AKS cluster with 3 availability zones", "azure-kubernetes/best-practices"),
    ("What networking option should I use for my AKS cluster — overlay or VNet-routable?", "azure-kubernetes/best-practices"),
    ("Should I use AKS Automatic or Standard for my workload?", "azure-kubernetes/best-practices"),
    ("How do I set up Workload Identity on AKS?", "azure-kubernetes/best-practices"),
    ("What's the best node pool configuration for production?", "azure-kubernetes/best-practices"),
    ("Help me design AKS observability with Prometheus and Grafana", "azure-kubernetes/best-practices"),

    # Troubleshooting
    ("My pod is stuck in CrashLoopBackOff, how do I debug it?", "azure-kubernetes/troubleshooting"),
    ("AKS nodes are showing NotReady status", "azure-kubernetes/troubleshooting"),
    ("Getting 502 errors on my AKS ingress", "azure-kubernetes/troubleshooting"),
    ("DNS resolution is failing inside my AKS pods", "azure-kubernetes/troubleshooting"),
    ("My AKS upgrade is stuck and not progressing", "azure-kubernetes/troubleshooting"),
    ("Pods are being evicted with OOMKilled", "azure-kubernetes/troubleshooting"),

    # Cost Optimization
    ("How do I rightsize my pod resource requests?", "azure-kubernetes/cost-optimization"),
    ("I want to set up VPA to get resource recommendations", "azure-kubernetes/cost-optimization"),
    ("How do I add spot node pools for my batch workloads?", "azure-kubernetes/cost-optimization"),
    ("My cluster has idle nodes, how do I tune the autoscaler to scale down?", "azure-kubernetes/cost-optimization"),
    ("Enable namespace-level cost breakdown for my AKS cluster", "azure-kubernetes/cost-optimization"),
    ("How can I reduce my AKS spending?", "azure-kubernetes/cost-optimization"),

    # Automatic Readiness
    ("Is my cluster ready to migrate to AKS Automatic?", "azure-kubernetes/automatic-readiness"),
    ("Check if my deployments are compatible with AKS Automatic", "azure-kubernetes/automatic-readiness"),
    ("What are the migration blockers for AKS Automatic?", "azure-kubernetes/automatic-readiness"),

    # Ambiguous / edge cases
    ("My AKS pods are using too much memory", "azure-kubernetes/cost-optimization"),
    ("AKS cluster performance is degraded", "azure-kubernetes/troubleshooting"),
    ("How do I configure autoscaling on AKS?", "azure-kubernetes/best-practices"),
]

# ─── EVAL LOGIC ──────────────────────────────────────────────────────────────

SYSTEM_PROMPT = """You are an AI agent with access to specialized skills. When a user asks a question, decide which skill to invoke. You MUST call the pick_skill function with the most relevant skill name. Pick exactly one skill."""


def build_system_prompt():
    skill_list = "\n".join(
        f"- **{s['name']}**: {s['description']}" for s in SKILLS
    )
    return f"{SYSTEM_PROMPT}\n\nAvailable skills:\n{skill_list}"


TOOL_DEFINITION = {
    "type": "function",
    "function": {
        "name": "pick_skill",
        "description": "Select the most relevant skill for the user's request.",
        "parameters": {
            "type": "object",
            "properties": {
                "skill": {
                    "type": "string",
                    "enum": [s["name"] for s in SKILLS],
                    "description": "The skill to invoke.",
                },
                "reasoning": {
                    "type": "string",
                    "description": "Brief reasoning for why this skill was chosen.",
                },
            },
            "required": ["skill", "reasoning"],
        },
    },
}


def run_eval():
    client = OpenAI()  # picks up OPENAI_BASE_URL and OPENAI_API_KEY from env
    results = []

    print(f"Model: {MODEL}")
    print(f"Base URL: {client.base_url}")
    print(f"Running {len(TEST_CASES)} test cases...\n")
    print(f"{'#':<3} {'Result':<6} {'Expected':<40} {'Actual':<40} Prompt")
    print("-" * 140)

    for i, (prompt, expected) in enumerate(TEST_CASES):
        response = client.chat.completions.create(
            model=MODEL,
            max_tokens=300,
            messages=[
                {"role": "system", "content": build_system_prompt()},
                {"role": "user", "content": prompt},
            ],
            tools=[TOOL_DEFINITION],
            tool_choice={"type": "function", "function": {"name": "pick_skill"}},
        )

        # Extract tool call
        actual = None
        reasoning = ""
        msg = response.choices[0].message
        if msg.tool_calls:
            args = json.loads(msg.tool_calls[0].function.arguments)
            actual = args.get("skill")
            reasoning = args.get("reasoning", "")

        match = "✅" if actual == expected else "❌"
        results.append({
            "prompt": prompt,
            "expected": expected,
            "actual": actual,
            "reasoning": reasoning,
            "match": actual == expected,
        })

        print(f"{i+1:<3} {match:<6} {expected:<40} {(actual or 'NONE'):<40} {prompt[:50]}")

    # Summary
    correct = sum(1 for r in results if r["match"])
    total = len(results)
    print(f"\n{'='*140}")
    print(f"Score: {correct}/{total} ({100*correct/total:.0f}%)")

    # Show mismatches
    mismatches = [r for r in results if not r["match"]]
    if mismatches:
        print(f"\n❌ Mismatches ({len(mismatches)}):")
        for r in mismatches:
            print(f"  Prompt:   {r['prompt']}")
            print(f"  Expected: {r['expected']}")
            print(f"  Actual:   {r['actual']}")
            print(f"  Reason:   {r['reasoning']}")
            print()

    # Write full results to JSON
    with open("skill_routing_results.json", "w") as f:
        json.dump(results, f, indent=2)
    print("Full results written to skill_routing_results.json")


if __name__ == "__main__":
    run_eval()
