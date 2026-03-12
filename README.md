<h1 align="center">gha-cost</h1>

<p align="center">
  Know what your GitHub Actions workflows cost before you push.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=flat&logo=node.js&logoColor=white" alt="Node.js >= 18">
  <img src="https://img.shields.io/badge/License-MIT-blue?style=flat" alt="MIT License">
  <img src="https://img.shields.io/badge/Zero_Dependencies-brightgreen?style=flat" alt="Zero Dependencies">
</p>

---

## What It Does

`gha-cost` reads your workflow YAML files without executing them, then:

- Enumerates every job and expands all matrix combinations
- Estimates per-step duration using heuristics for common actions and shell commands
- Applies GitHub's per-minute billing rates, rounded up to the nearest minute per job
- Projects cost per run, per day, and per month based on your expected trigger frequency
- Surfaces optimization hints: missing caches, expensive runners, oversized matrices

Everything runs locally. No API calls, no tokens required.

---

## GitHub Runner Pricing

Rates used for estimation (USD per minute, GitHub-hosted runners):

| Runner | Rate / min | Relative cost |
|--------|-----------|---------------|
| `ubuntu-latest` | $0.008 | 1x (baseline) |
| `windows-latest` | $0.016 | 2x |
| `macos-latest` | $0.080 | 10x |
| Self-hosted | $0.000 | configurable via `--self-hosted-rate` |

Rates reflect [GitHub's published billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions). GitHub charges in whole-minute increments per job.

---

## Quick Start

```bash
# Run without installing
npx @barissozudogru/gha-cost

# Or install globally
npm install -g @barissozudogru/gha-cost
gha-cost
```

---

## Usage

```
gha-cost [options]
```

Run from the root of any repository. With no flags, `gha-cost` scans every YAML file under `.github/workflows/`.

---

## Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--file <path>` | `-f` | auto-scan | Path to a specific workflow YAML file |
| `--pushes <n>` | `-p` | `10` | Estimated triggers per day |
| `--self-hosted-rate <rate>` | | `0` | Cost per minute (USD) for self-hosted runners |
| `--json` | | `false` | Output results as JSON (CI-friendly) |
| `--version` | `-v` | | Print version and exit |
| `--help` | `-h` | | Show help |

**Examples:**

```bash
# Scan all workflows in the current repository
gha-cost

# Estimate a specific workflow file
gha-cost --file .github/workflows/ci.yml

# Model a busier repository (50 pushes per day)
gha-cost --pushes 50

# Machine-readable output for CI gates or dashboards
gha-cost --json | jq '.[] | .totalEstimatedCostPerMonth'

# Assign a cost to self-hosted runners
gha-cost --self-hosted-rate 0.004

# Print the installed version
gha-cost --version
```

---

## Example Output

Given a typical CI workflow with lint, a 4-node test matrix, build, and deploy jobs:

```
────────────────────────────────────────────────────────────
Workflow: CI  (ci.yml)
────────────────────────────────────────────────────────────

  lint  [ubuntu-latest]
    - Checkout          actions/checkout      30s
    - Setup Node.js     actions/setup-node    45s
    - Install deps      npm ci                2m
    - Lint              npm run lint          1m
    time: 4m 15s  cost: $0.0016

  test  [ubuntu-latest]  x4 matrix
    - Checkout          actions/checkout      30s
    - Setup Node.js     actions/setup-node    45s
    - Install deps      npm ci                2m
    - Run tests         npm test              5m
    time/matrix: 8m 15s  total: 33m  cost: $0.0128

  build  [ubuntu-latest]
    - Checkout          actions/checkout      30s
    - Setup Node.js     actions/setup-node    45s
    - Install deps      npm ci                2m
    - Build             npm run build         3m
    time: 6m 15s  cost: $0.0024

  deploy  [ubuntu-latest]
    - Checkout          actions/checkout      30s
    - Deploy            deploy to production  2m
    time: 2m 30s  cost: $0.0008

────────────────────────────────────────────────────────────
Summary
  Total estimated time:  45m 30s
  Cost per run:          $0.0176
  Cost per day:          $0.176   (10 pushes/day)
  Cost per month:        $5.28    (30 days)

Optimization hints:
  !  Job "test": Matrix has 4 combinations. Consider reducing matrix dimensions
     or using fail-fast: false only when necessary.
  !  Consider adding path filters (on.push.paths) to skip workflows when
     unrelated files change.
────────────────────────────────────────────────────────────
```

The monthly projection assumes the configured `--pushes` value every day for 30 days. Adjust with `--pushes` to match your actual merge cadence.

---

## JSON Output Schema

Use `--json` to integrate cost data into CI pipelines, budget dashboards, or cost-gate scripts:

```bash
gha-cost --json | jq '.[] | {workflow: .workflowName, monthly: .totalEstimatedCostPerMonth}'
```

```json
[
  {
    "file": "ci.yml",
    "workflowName": "CI",
    "jobs": [
      {
        "id": "test",
        "name": "test",
        "runner": "ubuntu",
        "runnerLabel": "ubuntu-latest",
        "steps": [
          {
            "name": "Checkout",
            "uses": "actions/checkout@v4",
            "estimatedSeconds": 30
          }
        ],
        "matrix": [{ "key": "node-version", "values": ["18", "20", "22", "24"] }],
        "matrixCombinations": 4,
        "estimatedSecondsPerMatrix": 495,
        "estimatedTotalSeconds": 1980,
        "estimatedCostUsd": 0.0128
      }
    ],
    "totalEstimatedSeconds": 2730,
    "totalEstimatedCostPerRun": 0.0176,
    "totalEstimatedCostPerDay": 0.176,
    "totalEstimatedCostPerMonth": 5.28,
    "hints": [
      "Job \"test\": Matrix has 4 combinations. Consider reducing matrix dimensions or using fail-fast: false only when necessary."
    ]
  }
]
```

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success — at least one workflow estimated |
| `1` | No workflow files found, or all files failed to parse |

---

## License

MIT — see [LICENSE](./LICENSE).
