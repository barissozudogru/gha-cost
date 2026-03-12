# gha-cost

Estimate GitHub Actions workflow costs before running them.

Parses your workflow YAML files, counts jobs and matrix combinations, estimates runtime per step, and calculates approximate cost per run, per day, and per month.

## Installation

```bash
npm install -g @barissozudogru/gha-cost
```

Or run without installing:

```bash
npx @barissozudogru/gha-cost
```

## Usage

```
gha-cost [options]
```

### Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--file <path>` | `-f` | auto-scan | Path to a specific workflow YAML file |
| `--pushes <n>` | `-p` | `10` | Estimated triggers per day |
| `--self-hosted-rate <rate>` | | `0` | Cost per minute (USD) for self-hosted runners |
| `--json` | | false | Output results as JSON (CI-friendly) |
| `--version` | `-v` | | Print version and exit |
| `--help` | `-h` | | Show help |

### Examples

```bash
# Scan all workflows in .github/workflows/ of the current directory
gha-cost

# Estimate a specific workflow
gha-cost --file .github/workflows/ci.yml

# Assume 50 pushes per day
gha-cost --pushes 50

# Machine-readable output for CI
gha-cost --json | jq '.[] | .totalEstimatedCostPerMonth'

# Treat self-hosted runners as $0.004/min
gha-cost --self-hosted-rate 0.004

# Print the installed version
gha-cost --version
```

## Cost Rates

GitHub-hosted runner rates used for estimation (USD per minute):

| Runner | Rate/min |
|--------|----------|
| ubuntu-latest | $0.008 |
| windows-latest | $0.016 |
| macos-latest | $0.080 |

Rates match [GitHub's published billing](https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions) at the time of this release. Adjust your own rates accordingly.

## How It Works

1. Reads each workflow YAML without external dependencies.
2. Extracts jobs, `runs-on`, `strategy.matrix`, and `steps`.
3. Estimates each step's duration from its `uses` action name or `run` command content.
4. Multiplies by matrix combination count.
5. Applies per-minute billing rounded up to the nearest minute.
6. Reports cost per run, per day, and per month.
7. Emits optimization hints (missing cache, expensive runners, large matrices).

## JSON Output Schema

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
        "steps": [...],
        "matrix": [{ "key": "node-version", "values": ["18", "20"] }],
        "matrixCombinations": 2,
        "estimatedSecondsPerMatrix": 615,
        "estimatedTotalSeconds": 1230,
        "estimatedCostUsd": 0.0016
      }
    ],
    "totalEstimatedSeconds": 1230,
    "totalEstimatedCostPerRun": 0.0016,
    "totalEstimatedCostPerDay": 0.016,
    "totalEstimatedCostPerMonth": 0.48,
    "hints": []
  }
]
```

## License

MIT
