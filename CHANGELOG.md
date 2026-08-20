# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.5.0] - 2026-08-20

### Changed
- Estimates are reported as a range rather than a point value. Measured across 80 real steps, durations are bimodal: checkout has a median of 1.0s and a p75 of 15s, so no single number describes it and a point estimate was false precision.
- Step heuristics recalibrated so every measured value falls inside its predicted range.

### Added
- Cache detection. A workflow declaring a dependency cache is weighted toward the fast end of each range, since a cached `npm ci` measured 24s against 45s assumed for a cold one.
- Regression tests asserting that measured durations from real runs fall inside the predicted ranges.

## [0.4.0] - 2026-08-19

### Fixed
- Run frequency is derived from the workflow's own `on:` block, so scheduled workflows are no longer billed at the push rate.
- Step duration heuristics recalibrated against measured runs.
- `deploy`, `publish` and `push` matchers are word-anchored and no longer match step names that merely contain those words.

### Added
- Trigger and cron frequency tests.

## [0.3.0] - 2026-03-12

### Added

- `--self-hosted-rate` flag: assign a per-minute USD cost to self-hosted (unknown) runners
- Multi-workflow aggregate summary when more than one workflow file is scanned
- Optimization hint for large matrices (>= 6 combinations)
- Optimization hint for Windows runners (2x cost vs ubuntu)

### Changed

- YAML parser now detects indent unit dynamically instead of assuming 2 spaces
- Tab-indented YAML files emit a warning and are parsed correctly after expansion
- `formatCost` outputs 4 decimal places for sub-cent values to avoid displaying `$0.00`

### Fixed

- Matrix block list parsing now correctly advances the line pointer past list items
- Inline array matrix values (`[18, 20, 22]`) are parsed without surrounding quotes

---

## [0.2.0] - 2026-02-20

### Added

- Colored terminal output with ANSI codes (suppressed when stdout is not a TTY)
- Per-job runner color coding: green for ubuntu, yellow for macOS, cyan for Windows, magenta for self-hosted
- Optimization hints: missing dependency cache, macOS runner cost warning, path filter suggestion

### Changed

- Step duration heuristics extended to cover Go, Rust, Java (Maven/Gradle), and Terraform
- `--json` flag now suppresses all human-readable output including error messages

---

## [0.1.0] - 2026-02-01

### Added

- Initial release
- YAML workflow parser with no external dependencies
- Job and matrix combination enumeration
- Per-step duration heuristics for common GitHub Actions and shell commands
- Cost calculation using GitHub-hosted runner rates (ubuntu, macOS, Windows)
- Per-run, per-day, and per-month cost projections
- `--file`, `--pushes`, `--json`, `--version`, `--help` CLI flags
