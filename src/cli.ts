#!/usr/bin/env node

import { readdirSync, readFileSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { estimateWorkflow, formatDuration } from "./index.js";
import type { WorkflowEstimate, JobEstimate, CliOptions } from "./types.js";

// Resolve package.json relative to this file so --version works after compilation
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_PATH = join(__dirname, "..", "package.json");

function readPackageVersion(): string {
  try {
    const raw = readFileSync(PKG_PATH, "utf-8");
    const pkg = JSON.parse(raw) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ANSI escape codes - only emitted when stdout is a TTY
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
// Magenta is visible on both dark and light terminal backgrounds
const MAGENTA = "\x1b[35m";

const isTTY = Boolean(process.stdout.isTTY);

function colorize(text: string, color: string): string {
  if (!isTTY) return text;
  return `${color}${text}${RESET}`;
}

function bold(text: string): string {
  return colorize(text, BOLD);
}

function dim(text: string): string {
  return colorize(text, DIM);
}

function formatCost(usd: number): string {
  if (usd < 0.001) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function runnerColor(runner: string): string {
  switch (runner) {
    case "ubuntu":
      return GREEN;
    case "macos":
      return YELLOW;
    case "windows":
      return CYAN;
    default:
      // "unknown" = self-hosted - use magenta, visible on any background
      return MAGENTA;
  }
}

function printJobBreakdown(job: JobEstimate): void {
  const runnerTag = colorize(
    `[${job.runnerLabel}]`,
    runnerColor(job.runner)
  );

  const matrixTag =
    job.matrixCombinations > 1
      ? dim(` x${job.matrixCombinations} matrix`)
      : "";

  console.log(
    `  ${bold(job.name)} ${runnerTag}${matrixTag}`
  );

  for (const step of job.steps) {
    const stepLabel = step.uses
      ? dim(step.uses.split("@")[0] ?? step.uses)
      : dim(step.run ? step.run.slice(0, 50).replace(/\n/g, " ") : step.name);
    const duration = dim(formatDuration(step.estimatedSeconds));
    console.log(`    ${dim("-")} ${step.name}  ${stepLabel}  ${duration}`);
  }

  const perMatrix = formatDuration(job.estimatedSecondsPerMatrix);
  const total = formatDuration(job.estimatedTotalSeconds);
  const cost = colorize(formatCost(job.estimatedCostUsd), GREEN);

  if (job.matrixCombinations > 1) {
    console.log(
      `    ${dim("time/matrix:")} ${perMatrix}  ${dim("total:")} ${total}  ${dim("cost:")} ${cost}`
    );
  } else {
    console.log(`    ${dim("time:")} ${total}  ${dim("cost:")} ${cost}`);
  }

  console.log();
}

function printWorkflowReport(estimate: WorkflowEstimate, pushesPerDay: number): void {
  const separator = colorize("─".repeat(60), DIM);

  console.log();
  console.log(separator);
  console.log(
    `${bold("Workflow:")} ${colorize(estimate.workflowName, CYAN)}  ${dim(`(${estimate.file})`)}`
  );
  console.log(separator);
  console.log();

  for (const job of estimate.jobs) {
    printJobBreakdown(job);
  }

  console.log(separator);
  console.log(`${bold("Summary")}`);
  console.log(
    `  Total estimated time:  ${bold(formatDuration(estimate.totalEstimatedSeconds))}`
  );
  console.log(
    `  Cost per run:          ${colorize(formatCost(estimate.totalEstimatedCostPerRun), GREEN)}`
  );
  console.log(
    `  Triggers:              ${dim(estimate.triggers.join(", ") || "(none detected)")}`
  );
  if (estimate.runsPerDay === 0) {
    console.log(
      `  Cost per day           ${dim("not estimated")}  ${dim(`(${estimate.frequencyBasis})`)}`
    );
    console.log(
      `  Cost per month:        ${dim("not estimated")}`
    );
  } else {
    console.log(
      `  Cost per day           ${colorize(formatCost(estimate.totalEstimatedCostPerDay), YELLOW)}  ${dim(`(${estimate.frequencyBasis})`)}`
    );
    console.log(
      `  Cost per month:        ${colorize(formatCost(estimate.totalEstimatedCostPerMonth), RED)}  ${dim("(30.44 days)")}`
    );
  }
  console.log();

  if (estimate.hints.length > 0) {
    console.log(`${bold("Optimization hints:")}`);
    for (const hint of estimate.hints) {
      console.log(`  ${colorize("!", YELLOW)}  ${hint}`);
    }
    console.log();
  }

  console.log(separator);
  console.log();
}

function parseArgs(argv: string[]): CliOptions & { help: boolean; version: boolean } {
  const args = argv.slice(2);
  let file: string | undefined;
  let pushes = 10;
  let json = false;
  let help = false;
  let version = false;
  let selfHostedRate: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--version" || arg === "-v") {
      version = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--file" || arg === "-f") {
      file = args[++i];
    } else if (arg === "--pushes" || arg === "-p") {
      const val = parseInt(args[++i] ?? "", 10);
      if (!isNaN(val) && val > 0) pushes = val;
    } else if (arg === "--self-hosted-rate") {
      const val = parseFloat(args[++i] ?? "");
      if (!isNaN(val) && val >= 0) selfHostedRate = val;
    } else if (!arg.startsWith("-")) {
      // Positional argument treated as file path
      file = arg;
    }
  }

  return { file, pushes, json, help, version, selfHostedRate };
}

function printHelp(version: string): void {
  console.log(`
gha-cost v${version} - Estimate GitHub Actions workflow costs

USAGE
  gha-cost [options]
  gha-cost --file <path> [options]

OPTIONS
  --file, -f <path>          Path to a specific workflow YAML file
  --pushes, -p <n>           Pushes per day, applied only to push and
                             pull_request triggers (default: 10). Scheduled
                             workflows derive their rate from their own cron.
  --self-hosted-rate <rate>  Cost per minute (USD) for self-hosted runners (default: 0)
  --json                     Output results as JSON (for CI integration)
  --version, -v              Print version and exit
  --help, -h                 Show this help

EXAMPLES
  gha-cost
      Scan all workflows in .github/workflows/ of the current directory

  gha-cost --file .github/workflows/ci.yml
      Estimate cost for a specific workflow

  gha-cost --pushes 20 --json
      Output JSON with 20 pushes/day assumption

  gha-cost --self-hosted-rate 0.004
      Treat unknown (self-hosted) runners at $0.004/min

RUNNER RATES (USD per minute, GitHub-hosted)
  ubuntu-latest    $0.008
  windows-latest   $0.016
  macos-latest     $0.080
`);
}

function collectWorkflowFiles(file?: string): string[] {
  if (file) {
    return [resolve(process.cwd(), file)];
  }

  const workflowDir = join(process.cwd(), ".github", "workflows");

  let entries: string[];
  try {
    entries = readdirSync(workflowDir);
  } catch {
    console.error(
      `No .github/workflows directory found in ${process.cwd()}\nUse --file to specify a workflow file directly.`
    );
    process.exit(1);
  }

  const yamlFiles = entries
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => join(workflowDir, f));

  if (yamlFiles.length === 0) {
    console.error("No YAML workflow files found in .github/workflows/");
    process.exit(1);
  }

  return yamlFiles;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);

  if (opts.version) {
    console.log(readPackageVersion());
    process.exit(0);
  }

  if (opts.help) {
    printHelp(readPackageVersion());
    process.exit(0);
  }

  const files = collectWorkflowFiles(opts.file);
  const results: WorkflowEstimate[] = [];

  for (const filePath of files) {
    try {
      const estimate = estimateWorkflow(filePath, opts.pushes, opts.selfHostedRate);
      results.push(estimate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!opts.json) {
        console.error(`Error processing ${filePath}: ${msg}`);
      }
    }
  }

  if (results.length === 0) {
    console.error("No workflows could be estimated.");
    process.exit(1);
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  for (const estimate of results) {
    printWorkflowReport(estimate, opts.pushes);
  }

  // Multi-workflow aggregate
  if (results.length > 1) {
    const totalPerRun = results.reduce((s, r) => s + r.totalEstimatedCostPerRun, 0);
    const totalPerDay = results.reduce((s, r) => s + r.totalEstimatedCostPerDay, 0);
    const totalPerMonth = results.reduce((s, r) => s + r.totalEstimatedCostPerMonth, 0);

    const separator = colorize("=".repeat(60), DIM);
    console.log(separator);
    const unscheduled = results.filter((r) => r.runsPerDay === 0).length;
    console.log(bold(`Aggregate (${results.length} workflows)`));
    console.log(`  Cost per run:   ${colorize(formatCost(totalPerRun), GREEN)}`);
    console.log(`  Cost per day:   ${colorize(formatCost(totalPerDay), YELLOW)}`);
    console.log(`  Cost per month: ${colorize(formatCost(totalPerMonth), RED)}`);
    if (unscheduled > 0) {
      console.log(
        dim(
          `  ${unscheduled} workflow(s) run only on manual triggers and are counted at zero.`
        )
      );
    }
    console.log(
      dim("  Static estimate from the YAML, not measured. Step durations are")
    );
    console.log(
      dim("  central guesses; a large repository will exceed them.")
    );
    console.log(separator);
    console.log();
  }
}

main().catch((err) => {
  console.error("Unexpected error:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
