# gha-cost

[![npm version](https://img.shields.io/npm/v/@barissozudogru/gha-cost)](https://www.npmjs.com/package/@barissozudogru/gha-cost)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)

[npm](https://www.npmjs.com/package/@barissozudogru/gha-cost) · [Source](https://github.com/barissozudogru/gha-cost) · [Issues](https://github.com/barissozudogru/gha-cost/issues)

Estimate GitHub Actions runtime and cost ranges before you push.

`gha-cost` parses workflow YAML files locally without executing them or making API calls. It expands matrix combinations, estimates step durations using heuristics for common actions, rounds job runtimes to whole-minute increments per GitHub billing rules, and projects costs per run, day, and month.

## Usage

```bash
# Run without installing
npx @barissozudogru/gha-cost

# Or install globally
npm install -g @barissozudogru/gha-cost
gha-cost [options]
```

Run `gha-cost` from the root of a repository to scan all YAML files under `.github/workflows/`.

## Options

| Flag | Short | Default | Description |
|------|-------|---------|-------------|
| `--file <path>` | `-f` | auto-scan | Path to a specific workflow YAML file |
| `--pushes <n>` | `-p` | `10` | Estimated triggers per day |
| `--self-hosted-rate <rate>` | | `0` | Cost per minute (USD) for self-hosted runners |
| `--json` | | `false` | Output results as JSON |
| `--version` | `-v` | | Print version and exit |
| `--help` | `-h` | | Show help |

Examples:

```bash
# Scan all workflows in the current repository
gha-cost

# Estimate a specific workflow file
gha-cost --file .github/workflows/ci.yml

# Model a busier repository (50 pushes per day)
gha-cost --pushes 50

# Machine-readable output for CI gates or dashboards
gha-cost --json | jq '.[] | .totalEstimatedCostPerMonth'

# Assign a cost rate to self-hosted runners
gha-cost --self-hosted-rate 0.004
```

## Runner Pricing

Standard GitHub-hosted runner rates used on the default branch, checked on 2026-10-04 (USD per minute):

| Runner | Rate / min |
|---|---|
| `ubuntu-latest` | $0.006 |
| `windows-latest` | $0.010 |
| `macos-latest` | $0.062 |
| Self-hosted or unrecognised | $0.000 by default; configurable via `--self-hosted-rate` |

GitHub rounds each job up to a whole minute. Check the
[official runner pricing](https://docs.github.com/en/billing/reference/actions-runner-pricing)
before making a budget decision. The latest npm release may use an older rate
snapshot until changes on the default branch are published.

## Output and interpretation

The terminal report includes estimated job durations, cost ranges, matrix
multipliers, run frequency, and optimisation hints. These are heuristic estimates;
the tool does not measure execution time or read your billing account.

Use JSON output to inspect workflow totals:

```bash
gha-cost --json | jq '.[] | {workflow: .workflowName, monthly: .totalEstimatedCostPerMonth}'
```

The JSON includes job estimates and low/high duration and cost bounds, alongside
`totalEstimatedCostPerRun`, `totalEstimatedCostPerDay`, and
`totalEstimatedCostPerMonth`. Monthly projections use 30.44 days and the estimated
run frequency. Review the reported frequency and use `--pushes` when modelling
push-triggered workflows.

Standard hosted runners are [free for public repositories](https://docs.github.com/en/billing/concepts/product-billing/github-actions). Included private-repository
minutes, discounts, taxes, storage, and account-specific allowances are not subtracted
from the estimate. Larger and specialised runner prices are not modelled individually;
an OS classification can underestimate their cost. Unknown labels default to zero
unless a custom rate is supplied.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success - at least one workflow estimated |
| `1` | No workflow files found or all files failed to parse |

## Development and support

Report problems through [GitHub issues](https://github.com/barissozudogru/gha-cost/issues). See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution workflow.

To build and test a source checkout with Node.js 22:

```bash
npm ci
npm test
npm run build
```

The default branch can contain changes that have not yet been published to npm.

## License

MIT - see [LICENSE](./LICENSE).
