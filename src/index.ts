import { parseTriggers, estimateRunsPerDay } from "./triggers.js";
import { readFileSync } from "fs";
import { basename } from "path";
import type {
  RunnerType,
  StepEstimate,
  MatrixDimension,
  JobEstimate,
  WorkflowEstimate,
  CostRates,
} from "./types.js";

// GitHub Actions per-minute billing rates (USD)
const COST_RATES: CostRates = {
  ubuntu: 0.008,
  macos: 0.08,
  windows: 0.016,
  unknown: 0,
};

// Minimum billing increment is 1 minute per job
const BILLING_INCREMENT_SECONDS = 60;

/**
 * Step duration heuristics, as a range rather than a single number.
 *
 * Measured across 80 real steps from three repositories, the distribution is
 * bimodal rather than merely mis-centred. Checkout has a median of 1.0s and a
 * p75 of 15s. Setup has a median of 0.0s and a p90 of 7s. Generic steps run 6s
 * at the median and 49s at the maximum. No single value describes that, so a
 * point estimate is false precision no matter which value is chosen.
 *
 * The low end is a warm-cache run of a small project. The high end is a cold
 * cache or a large one. Where the workflow declares caching, the estimate is
 * weighted toward the low end, because that declaration is real evidence about
 * which mode the run is in.
 */
const STEP_DURATION_HEURISTICS: Array<{
  pattern: RegExp;
  low: number;
  high: number;
  label: string;
  /** True where a dependency cache materially changes the duration. */
  cacheSensitive?: boolean;
}> = [
  { pattern: /actions\/checkout/i, low: 1, high: 25, label: "checkout" },
  { pattern: /actions\/setup-node/i, low: 1, high: 25, label: "setup-node", cacheSensitive: true },
  { pattern: /actions\/setup-python/i, low: 2, high: 20, label: "setup-python", cacheSensitive: true },
  { pattern: /actions\/setup-java/i, low: 5, high: 35, label: "setup-java", cacheSensitive: true },
  { pattern: /actions\/setup-go/i, low: 2, high: 20, label: "setup-go", cacheSensitive: true },
  { pattern: /actions\/cache/i, low: 2, high: 20, label: "cache" },
  { pattern: /actions\/upload-artifact/i, low: 3, high: 25, label: "upload-artifact" },
  { pattern: /actions\/download-artifact/i, low: 2, high: 20, label: "download-artifact" },
  { pattern: /docker\/build-push-action/i, low: 45, high: 300, label: "docker-build-push", cacheSensitive: true },
  { pattern: /docker\/login-action/i, low: 1, high: 8, label: "docker-login" },
  { pattern: /aws-actions\//i, low: 3, high: 25, label: "aws-action" },
  { pattern: /google-github-actions\//i, low: 3, high: 25, label: "gcp-action" },
  { pattern: /azure\//i, low: 3, high: 25, label: "azure-action" },
  { pattern: /npm\s+(ci|install)/i, low: 15, high: 120, label: "npm-install", cacheSensitive: true },
  { pattern: /npm\s+(run\s+)?test/i, low: 20, high: 300, label: "npm-test" },
  { pattern: /npm\s+(run\s+)?build/i, low: 10, high: 180, label: "npm-build" },
  { pattern: /npm\s+(run\s+)?lint/i, low: 5, high: 60, label: "npm-lint" },
  { pattern: /yarn\s+(install|ci)/i, low: 15, high: 120, label: "yarn-install", cacheSensitive: true },
  { pattern: /yarn\s+(test|jest)/i, low: 20, high: 300, label: "yarn-test" },
  { pattern: /yarn\s+build/i, low: 15, high: 150, label: "yarn-build" },
  { pattern: /pnpm\s+(install|ci)/i, low: 10, high: 100, label: "pnpm-install", cacheSensitive: true },
  { pattern: /pnpm\s+test/i, low: 20, high: 300, label: "pnpm-test" },
  { pattern: /pnpm\s+build/i, low: 15, high: 150, label: "pnpm-build" },
  { pattern: /pytest/i, low: 15, high: 300, label: "pytest" },
  { pattern: /go\s+test/i, low: 20, high: 240, label: "go-test" },
  { pattern: /go\s+build/i, low: 10, high: 150, label: "go-build" },
  { pattern: /cargo\s+test/i, low: 45, high: 420, label: "cargo-test" },
  { pattern: /cargo\s+build/i, low: 40, high: 360, label: "cargo-build" },
  { pattern: /mvn\s+(test|verify)/i, low: 45, high: 400, label: "maven-test" },
  { pattern: /gradle\s+(test|build)/i, low: 45, high: 400, label: "gradle-build" },
  { pattern: /terraform\s+(plan|apply)/i, low: 15, high: 180, label: "terraform" },
  // Word-anchored. An unanchored /publish/i once matched a step named
  // "Published content identity scan", a shell one-liner measuring 0.1s.
  { pattern: /\bdeploy(s|ing|ment)?\b/i, low: 8, high: 90, label: "deploy" },
  { pattern: /\bpublish\b/i, low: 5, high: 45, label: "publish" },
  { pattern: /\bpush\b/i, low: 3, high: 30, label: "push" },
];

/** Generic shell steps: median 6s, p90 33s, max 49s across the measured sample. */
const GENERIC_STEP = { low: 0, high: 60 };

/**
 * Does the workflow declare a dependency cache?
 *
 * Either a setup-* action with `cache:` set, or an explicit actions/cache step.
 * This is the single strongest predictor of which mode a run lands in: a cached
 * `npm ci` measured 24s against 45s assumed for a cold one.
 */
export function detectsCaching(content: string): boolean {
  if (/uses:\s*actions\/cache/i.test(content)) return true;
  // `cache:` nested under a setup-* action's `with:` block.
  return /uses:\s*actions\/setup-[a-z]+[\s\S]{0,200}?^\s+cache:\s*\S/im.test(content);
}

export interface DurationRange {
  low: number;
  high: number;
}

function estimateStepDuration(
  stepName: string,
  uses?: string,
  run?: string,
  cached = false
): DurationRange {
  const haystack = [stepName, uses ?? "", run ?? ""].join(" ").toLowerCase();

  for (const h of STEP_DURATION_HEURISTICS) {
    if (h.pattern.test(haystack)) {
      // A declared cache is evidence the run is in the fast mode, so the upper
      // bound comes down rather than the whole range shifting.
      if (cached && h.cacheSensitive) {
        return { low: h.low, high: Math.round(h.low + (h.high - h.low) * 0.5) };
      }
      return { low: h.low, high: h.high };
    }
  }
  return { ...GENERIC_STEP };
}

function detectRunnerType(runsOn: string): RunnerType {
  const label = runsOn.toLowerCase();
  if (label.includes("self-hosted")) return "unknown";
  if (label.includes("ubuntu") || label.includes("linux")) return "ubuntu";
  if (label.includes("macos") || label.includes("mac-os") || label.includes("osx")) return "macos";
  if (label.includes("windows")) return "windows";
  return "unknown";
}

function roundUpToMinute(seconds: number): number {
  return Math.ceil(seconds / BILLING_INCREMENT_SECONDS) * BILLING_INCREMENT_SECONDS;
}

function calculateJobCost(
  seconds: number,
  runner: RunnerType,
  selfHostedRate?: number
): number {
  const billedSeconds = roundUpToMinute(seconds);
  const minutes = billedSeconds / 60;
  const rate =
    runner === "unknown"
      ? (selfHostedRate ?? COST_RATES.unknown)
      : COST_RATES[runner];
  return minutes * rate;
}

// Minimal YAML parser for GitHub Actions workflow structure.
// Handles: top-level keys, jobs block, strategy.matrix, runs-on, steps (name/uses/run).
// Does not need to be a full YAML parser - only extracts what we need for cost estimation.

interface RawStep {
  name: string;
  uses?: string;
  run?: string;
}

interface RawJob {
  id: string;
  name: string;
  runsOn: string;
  steps: RawStep[];
  matrix: MatrixDimension[];
}

interface RawWorkflow {
  name: string;
  jobs: RawJob[];
}

function getIndent(line: string): number {
  // Treat leading tabs as spaces (1 tab = 2 spaces) and emit a warning once
  const expanded = line.replace(/^\t+/, (tabs) => "  ".repeat(tabs.length));
  return expanded.length - expanded.trimStart().length;
}

function expandTabs(line: string): string {
  return line.replace(/^\t+/, (tabs) => "  ".repeat(tabs.length));
}

function stripInlineComment(value: string): string {
  // Remove inline YAML comments (but not inside quoted strings - simple heuristic)
  const hashIdx = value.indexOf(" #");
  if (hashIdx !== -1) return value.slice(0, hashIdx).trim();
  return value.trim();
}

function parseMatrixValues(lines: string[], startIndex: number, indent: number): string[] {
  const values: string[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = expandTabs(lines[i]);
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const lineIndent = getIndent(line);
    if (lineIndent < indent) break;
    if (lineIndent === indent && line.trimStart().startsWith("- ")) {
      const val = stripInlineComment(line.trimStart().slice(2));
      if (val !== "") values.push(val);
    }
    i++;
  }

  return values;
}

function parseInlineArray(value: string): string[] {
  // Parse [a, b, c] or [1, 2, 3]
  const match = value.match(/^\[(.+)\]$/);
  if (!match) return [];
  return match[1].split(",").map((v) => stripInlineComment(v.trim()).replace(/^['"]|['"]$/g, ""));
}

/**
 * Detect the indent unit used in this YAML file by examining the first key
 * found inside the jobs: block. Returns the number of spaces per indent level.
 * Falls back to 2 if detection fails.
 */
function detectJobIndent(lines: string[], jobsStart: number): number {
  for (let j = jobsStart; j < lines.length; j++) {
    const line = expandTabs(lines[j]);
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    // This is the first non-blank line after jobs:
    const indent = getIndent(line);
    if (indent > 0) return indent;
    // If indent is 0, we've hit a top-level key - no jobs found
    break;
  }
  return 2;
}

/**
 * Check whether a line contains a tab character at the start (before expansion).
 * Used to emit a one-time warning.
 */
function hasLeadingTab(line: string): boolean {
  return line.length > 0 && line[0] === "\t";
}

function parseWorkflowYaml(content: string): RawWorkflow {
  const rawLines = content.split("\n");

  // Warn once if tabs are used for indentation
  const tabLine = rawLines.findIndex(hasLeadingTab);
  if (tabLine !== -1) {
    process.stderr.write(
      `Warning: tab indentation detected (line ${tabLine + 1}). Tabs have been converted to spaces.\n`
    );
  }

  // Work with tab-expanded lines throughout
  const lines = rawLines.map(expandTabs);

  const workflow: RawWorkflow = { name: "", jobs: [] };

  // Extract top-level name
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (/^name:\s*/.test(line)) {
      workflow.name = stripInlineComment(
        line.replace(/^name:\s*/, "").replace(/^['"]|['"]$/g, "")
      );
      break;
    }
  }

  // Find jobs: block
  let jobsStart = -1;
  for (let j = 0; j < lines.length; j++) {
    if (/^jobs:\s*$/.test(lines[j])) {
      jobsStart = j + 1;
      break;
    }
  }

  if (jobsStart === -1) return workflow;

  // Detect the indentation unit used under jobs:
  const jobIndent = detectJobIndent(lines, jobsStart);
  // Children of job entries are one additional indent level deeper
  const jobChildIndent = jobIndent * 2;
  const strategyIndent = jobIndent * 3;
  const matrixIndent = jobIndent * 4;
  const matrixKeyIndent = jobIndent * 4;
  const matrixValueIndent = jobIndent * 5;
  const stepListIndent = jobIndent * 3;
  const stepPropIndent = jobIndent * 4;

  let i = jobsStart;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = getIndent(line);

    // Job-level keys are at jobIndent and look like "  job-id:"
    // Must be exactly at job indent and be a bare key (no leading dash)
    if (
      indent === jobIndent &&
      /^[\w-]+:\s*$/.test(line.trimStart())
    ) {
      const jobId = line.trim().replace(/:$/, "");
      const job: RawJob = {
        id: jobId,
        name: jobId,
        runsOn: "ubuntu-latest",
        steps: [],
        matrix: [],
      };

      i++;

      // Parse job body - lines at indent > jobIndent belong to this job
      while (i < lines.length) {
        const jobLine = lines[i];

        if (jobLine.trim() === "" || jobLine.trim().startsWith("#")) {
          i++;
          continue;
        }

        const jobLineIndent = getIndent(jobLine);

        // End of this job (next job at same indent, or top-level key)
        if (jobLineIndent <= jobIndent) break;

        // Job name override - at jobChildIndent
        if (jobLineIndent === jobChildIndent && /^name:\s*/.test(jobLine.trimStart())) {
          job.name = stripInlineComment(
            jobLine.trimStart().replace(/^name:\s*/, "").replace(/^['"]|['"]$/g, "")
          );
          i++;
          continue;
        }

        // runs-on - at jobChildIndent
        if (jobLineIndent === jobChildIndent && /^runs-on:\s*/.test(jobLine.trimStart())) {
          job.runsOn = stripInlineComment(
            jobLine.trimStart().replace(/^runs-on:\s*/, "").replace(/^['"]|['"]$/g, "")
          );
          i++;
          continue;
        }

        // strategy: - at jobChildIndent
        if (jobLineIndent === jobChildIndent && /^strategy:\s*$/.test(jobLine.trimStart())) {
          i++;
          while (i < lines.length) {
            const stratLine = lines[i];
            if (stratLine.trim() === "" || stratLine.trim().startsWith("#")) {
              i++;
              continue;
            }
            if (getIndent(stratLine) <= jobChildIndent) break;

            if (
              getIndent(stratLine) === strategyIndent &&
              /^matrix:\s*$/.test(stratLine.trimStart())
            ) {
              i++;
              while (i < lines.length) {
                const matLine = lines[i];
                if (matLine.trim() === "" || matLine.trim().startsWith("#")) {
                  i++;
                  continue;
                }
                if (getIndent(matLine) <= strategyIndent) break;

                // Matrix key: [values] (inline)
                const inlineMatch = matLine
                  .trimStart()
                  .match(/^([\w-]+):\s*(\[.+\])/);
                if (inlineMatch && getIndent(matLine) === matrixKeyIndent) {
                  const values = parseInlineArray(inlineMatch[2]);
                  if (values.length > 0) {
                    job.matrix.push({ key: inlineMatch[1], values });
                  }
                  i++;
                  continue;
                }

                // Matrix key: (block list)
                const blockMatch = matLine.trimStart().match(/^([\w-]+):\s*$/);
                if (blockMatch && getIndent(matLine) === matrixKeyIndent) {
                  i++;
                  const values = parseMatrixValues(lines, i, matrixValueIndent);
                  // Advance i past the list items
                  while (i < lines.length) {
                    const vl = lines[i];
                    if (vl.trim() === "" || vl.trim().startsWith("#")) {
                      i++;
                      continue;
                    }
                    if (
                      getIndent(vl) < matrixValueIndent ||
                      !vl.trimStart().startsWith("- ")
                    )
                      break;
                    i++;
                  }
                  if (values.length > 0) {
                    job.matrix.push({ key: blockMatch[1], values });
                  }
                  continue;
                }

                i++;
              }
              continue;
            }

            i++;
          }
          continue;
        }

        // steps: - at jobChildIndent
        if (jobLineIndent === jobChildIndent && /^steps:\s*$/.test(jobLine.trimStart())) {
          i++;
          let currentStep: Partial<RawStep> | null = null;

          while (i < lines.length) {
            const stepLine = lines[i];

            if (stepLine.trim() === "" || stepLine.trim().startsWith("#")) {
              i++;
              continue;
            }

            const stepIndent = getIndent(stepLine);

            if (stepIndent < jobChildIndent) break;

            // New step item - list items are at stepListIndent (jobIndent * 3)
            if (
              stepIndent === stepListIndent &&
              /^-\s/.test(stepLine.trimStart())
            ) {
              if (currentStep) {
                job.steps.push({
                  name: currentStep.name ?? "unnamed step",
                  uses: currentStep.uses,
                  run: currentStep.run,
                });
              }
              currentStep = {};

              // Check for inline key on same line as dash: "- uses: actions/checkout@v4"
              const inlineKey = stepLine.trimStart().replace(/^-\s+/, "");
              const keyMatch = inlineKey.match(/^(name|uses|run):\s*(.*)/);
              if (keyMatch) {
                const key = keyMatch[1] as "name" | "uses" | "run";
                currentStep[key] = stripInlineComment(keyMatch[2]);
              }

              i++;
              continue;
            }

            // Step properties at stepPropIndent (jobIndent * 4)
            if (stepIndent === stepPropIndent && currentStep !== null) {
              const propMatch = stepLine
                .trimStart()
                .match(/^(name|uses|run):\s*(.*)/);
              if (propMatch) {
                const key = propMatch[1] as "name" | "uses" | "run";
                let val = stripInlineComment(propMatch[2]).replace(/^['"]|['"]$/g, "");

                // Handle multi-line run blocks (pipe | or folded >)
                if (val === "|" || val === ">") {
                  val = "";
                  i++;
                  while (i < lines.length) {
                    const runLine = lines[i];
                    // Blank lines are valid inside a block scalar - include them
                    // and only stop when we see a non-blank line at <= stepPropIndent
                    if (runLine.trim() === "") {
                      val += " ";
                      i++;
                      continue;
                    }
                    if (getIndent(runLine) <= stepPropIndent) break;
                    val += " " + runLine.trim();
                    i++;
                  }
                  val = val.trim();
                } else {
                  i++;
                }
                currentStep[key] = val;
                continue;
              }
            }

            i++;
          }

          // Push last step
          if (currentStep && (currentStep.name || currentStep.uses || currentStep.run)) {
            job.steps.push({
              name: currentStep.name ?? "unnamed step",
              uses: currentStep.uses,
              run: currentStep.run,
            });
          }

          continue;
        }

        i++;
      }

      workflow.jobs.push(job);
      continue;
    }

    i++;
  }

  return workflow;
}

function computeMatrixCombinations(matrix: MatrixDimension[]): number {
  if (matrix.length === 0) return 1;
  return matrix.reduce((acc, dim) => acc * dim.values.length, 1);
}

function generateHints(jobs: JobEstimate[]): string[] {
  const hints: string[] = [];

  // Detect missing cache steps
  for (const job of jobs) {
    const hasCache = job.steps.some(
      (s) =>
        s.uses?.includes("actions/cache") ||
        s.name.toLowerCase().includes("cache") ||
        s.uses?.includes("setup-node") // setup-node has built-in cache option
    );
    const hasInstall = job.steps.some(
      (s) =>
        /npm\s+(ci|install)/i.test(s.run ?? "") ||
        /yarn\s+(install|ci)/i.test(s.run ?? "") ||
        /pnpm\s+(install)/i.test(s.run ?? "")
    );
    if (hasInstall && !hasCache) {
      hints.push(
        `Job "${job.name}": Add actions/cache or use setup-node's built-in cache to speed up dependency installs.`
      );
    }
  }

  // Detect large matrices
  for (const job of jobs) {
    if (job.matrixCombinations >= 6) {
      hints.push(
        `Job "${job.name}": Matrix has ${job.matrixCombinations} combinations. Consider reducing matrix dimensions or using fail-fast: false only when necessary.`
      );
    }
  }

  // Detect macOS runners (10x cost vs ubuntu)
  const macosJobs = jobs.filter((j) => j.runner === "macos");
  if (macosJobs.length > 0) {
    hints.push(
      `Jobs [${macosJobs.map((j) => j.name).join(", ")}] use macOS runners (10x cost vs ubuntu). Run only required tests on macOS.`
    );
  }

  // Detect windows runners (2x cost vs ubuntu)
  const winJobs = jobs.filter((j) => j.runner === "windows");
  if (winJobs.length > 0) {
    hints.push(
      `Jobs [${winJobs.map((j) => j.name).join(", ")}] use Windows runners (2x cost vs ubuntu). Consider limiting cross-platform jobs.`
    );
  }

  // Detect no path filters on push triggers (cannot detect easily from job level, just a general hint)
  if (jobs.length > 3) {
    hints.push(
      "Consider adding path filters (on.push.paths) to skip workflows when unrelated files change."
    );
  }

  return hints;
}

export function estimateWorkflow(
  filePath: string,
  pushesPerDay: number,
  selfHostedRate?: number
): WorkflowEstimate {
  const content = readFileSync(filePath, "utf-8");
  const raw = parseWorkflowYaml(content);

  // Read once for the whole file: the cache declaration tells us which mode
  // the run is likely in, and it is already in the YAML being parsed.
  const cached = detectsCaching(content);

  const jobEstimates: JobEstimate[] = [];

  for (const rawJob of raw.jobs) {
    const runner = detectRunnerType(rawJob.runsOn);

    const steps: StepEstimate[] = rawJob.steps.map((s) => {
      const r = estimateStepDuration(s.name, s.uses, s.run, cached);
      return {
        name: s.name,
        uses: s.uses,
        run: s.run,
        estimatedSeconds: Math.round((r.low + r.high) / 2),
        estimatedSecondsLow: r.low,
        estimatedSecondsHigh: r.high,
      };
    });

    // If no steps were detected, assume a minimal job time
    const totalSecondsPerMatrix =
      steps.length > 0 ? steps.reduce((sum, s) => sum + s.estimatedSeconds, 0) : 60;
    const lowSecondsPerMatrix =
      steps.length > 0 ? steps.reduce((sum, s) => sum + s.estimatedSecondsLow, 0) : 30;
    const highSecondsPerMatrix =
      steps.length > 0 ? steps.reduce((sum, s) => sum + s.estimatedSecondsHigh, 0) : 120;

    const matrixCombinations = computeMatrixCombinations(rawJob.matrix);
    const totalSeconds = totalSecondsPerMatrix * matrixCombinations;
    const costPerRun =
      calculateJobCost(totalSecondsPerMatrix, runner, selfHostedRate) * matrixCombinations;

    jobEstimates.push({
      id: rawJob.id,
      name: rawJob.name,
      runner,
      runnerLabel: rawJob.runsOn,
      steps,
      matrix: rawJob.matrix,
      matrixCombinations,
      estimatedSecondsPerMatrix: totalSecondsPerMatrix,
      estimatedSecondsLowPerMatrix: lowSecondsPerMatrix,
      estimatedSecondsHighPerMatrix: highSecondsPerMatrix,
      estimatedTotalSeconds: totalSeconds,
      estimatedCostUsd: costPerRun,
    });
  }

  const totalSeconds = jobEstimates.reduce((sum, j) => sum + j.estimatedTotalSeconds, 0);
  const totalSecondsLow = jobEstimates.reduce(
    (sum, j) => sum + j.estimatedSecondsLowPerMatrix * j.matrixCombinations, 0);
  const totalSecondsHigh = jobEstimates.reduce(
    (sum, j) => sum + j.estimatedSecondsHighPerMatrix * j.matrixCombinations, 0);
  const costPerRun = jobEstimates.reduce((sum, j) => sum + j.estimatedCostUsd, 0);
  // Cost per run is only half the picture. How often the workflow actually
  // fires comes from its own on: block, so a weekly cron is no longer billed as
  // if it ran with every push.
  const triggers = parseTriggers(content);
  const frequency = estimateRunsPerDay(triggers, pushesPerDay);
  const costPerDay = costPerRun * frequency.runsPerDay;
  const costPerMonth = costPerDay * 30.44;

  const hints = generateHints(jobEstimates);

  return {
    file: basename(filePath),
    workflowName: raw.name || basename(filePath),
    jobs: jobEstimates,
    totalEstimatedSeconds: totalSeconds,
    totalEstimatedSecondsLow: totalSecondsLow,
    totalEstimatedSecondsHigh: totalSecondsHigh,
    cachingDetected: cached,
    totalEstimatedCostPerRun: costPerRun,
    totalEstimatedCostPerDay: costPerDay,
    totalEstimatedCostPerMonth: costPerMonth,
    runsPerDay: frequency.runsPerDay,
    frequencyBasis: frequency.basis,
    triggers: triggers.names,
    hints,
  };
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

export { COST_RATES };
export type { WorkflowEstimate, JobEstimate, StepEstimate, MatrixDimension, RunnerType, CostRates };

// Exported for tests: the loose verb matchers are a known false-positive risk.
export const estimateStepDurationForTest = estimateStepDuration;

/** Exported for tests. */
export const detectsCachingForTest = detectsCaching;
