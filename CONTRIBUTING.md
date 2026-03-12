# Contributing

Thank you for your interest in contributing to gha-cost.

---

## Prerequisites

- Node.js >= 18
- npm >= 9

No other tools are required. The project has zero runtime dependencies and uses only the TypeScript compiler as a dev dependency.

---

## Setup

```bash
git clone https://github.com/barissozudogru/gha-cost.git
cd gha-cost
npm install
npm run build
```

To test the CLI against a local workflow file:

```bash
node dist/cli.js --file path/to/workflow.yml
```

---

## Project Structure

```
src/
  cli.ts       Entry point — argument parsing, terminal output, multi-workflow aggregation
  index.ts     Core logic — YAML parser, step heuristics, cost calculation, hint generation
  types.ts     Shared TypeScript interfaces
dist/          Compiled output (generated, not committed)
```

---

## Making Changes

### Adding a step duration heuristic

Step durations are estimated in `src/index.ts` via the `STEP_DURATION_HEURISTICS` array. Each entry is:

```ts
{ pattern: /regex/i, seconds: number, label: string }
```

Patterns are matched against the concatenation of `stepName + uses + run`. The first match wins, so order matters — place more specific patterns before broader ones.

### Adding a new CLI flag

1. Add the flag to the `parseArgs` function in `src/cli.ts`
2. Add it to the `CliOptions` interface in `src/types.ts`
3. Pass it through to `estimateWorkflow` or handle it in `main`
4. Document it in the help text inside `printHelp` and in `README.md`

---

## Testing

There is currently no automated test suite. Manual testing steps:

1. Run against the included release workflow: `node dist/cli.js --file .github/workflows/release.yml`
2. Run against a workflow with a matrix strategy and verify matrix combinations multiply correctly
3. Run with `--json` and validate the output is valid JSON matching the documented schema
4. Run with `--self-hosted-rate 0.005` against a workflow that uses a custom runner label

---

## Submitting a Pull Request

1. Fork the repository and create a branch from `main`
2. Make your changes and rebuild: `npm run build`
3. Verify the CLI works as expected against real workflow files
4. Open a pull request with a clear description of what changed and why

---

## Reporting Issues

Open an issue on GitHub. Include:

- The workflow YAML that produces unexpected output (redact secrets)
- The exact command you ran
- The actual output vs what you expected
- Your Node.js version (`node --version`)

---

## License

By contributing, you agree that your contributions are licensed under the MIT License.
