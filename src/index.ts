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
  unknown: 0.008,
};

// Minimum billing increment is 1 minute per job
const BILLING_INCREMENT_SECONDS = 60;

// Step duration heuristics based on action name / run command content
const STEP_DURATION_HEURISTICS: Array<{
  pattern: RegExp;
  seconds: number;
  label: string;
}> = [
  { pattern: /actions\/checkout/i, seconds: 30, label: "checkout" },
  { pattern: /actions\/setup-node/i, seconds: 45, label: "setup-node" },
  { pattern: /actions\/setup-python/i, seconds: 40, label: "setup-python" },
  { pattern: /actions\/setup-java/i, seconds: 60, label: "setup-java" },
  { pattern: /actions\/setup-go/i, seconds: 40, label: "setup-go" },
  { pattern: /actions\/cache/i, seconds: 20, label: "cache" },
  { pattern: /actions\/upload-artifact/i, seconds: 30, label: "upload-artifact" },
  { pattern: /actions\/download-artifact/i, seconds: 20, label: "download-artifact" },
  { pattern: /docker\/build-push-action/i, seconds: 300, label: "docker-build-push" },
  { pattern: /docker\/login-action/i, seconds: 10, label: "docker-login" },
  { pattern: /aws-actions\//i, seconds: 30, label: "aws-action" },
  { pattern: /google-github-actions\//i, seconds: 30, label: "gcp-action" },
  { pattern: /azure\//i, seconds: 30, label: "azure-action" },
  { pattern: /npm\s+(ci|install)/i, seconds: 120, label: "npm-install" },
  { pattern: /npm\s+(run\s+)?test/i, seconds: 300, label: "npm-test" },
  { pattern: /npm\s+(run\s+)?build/i, seconds: 180, label: "npm-build" },
  { pattern: /npm\s+(run\s+)?lint/i, seconds: 60, label: "npm-lint" },
  { pattern: /yarn\s+(install|ci)/i, seconds: 120, label: "yarn-install" },
  { pattern: /yarn\s+(test|jest)/i, seconds: 300, label: "yarn-test" },
  { pattern: /yarn\s+build/i, seconds: 180, label: "yarn-build" },
  { pattern: /pnpm\s+(install|ci)/i, seconds: 100, label: "pnpm-install" },
  { pattern: /pnpm\s+test/i, seconds: 300, label: "pnpm-test" },
  { pattern: /pnpm\s+build/i, seconds: 180, label: "pnpm-build" },
  { pattern: /pytest/i, seconds: 300, label: "pytest" },
  { pattern: /go\s+test/i, seconds: 180, label: "go-test" },
  { pattern: /go\s+build/i, seconds: 120, label: "go-build" },
  { pattern: /cargo\s+test/i, seconds: 300, label: "cargo-test" },
  { pattern: /cargo\s+build/i, seconds: 240, label: "cargo-build" },
  { pattern: /mvn\s+(test|verify)/i, seconds: 300, label: "maven-test" },
  { pattern: /gradle\s+(test|build)/i, seconds: 300, label: "gradle-build" },
  { pattern: /terraform\s+(plan|apply)/i, seconds: 120, label: "terraform" },
  { pattern: /deploy/i, seconds: 120, label: "deploy" },
  { pattern: /publish/i, seconds: 60, label: "publish" },
  { pattern: /push/i, seconds: 60, label: "push" },
];

function detectRunnerType(runsOn: string): RunnerType {
  const label = runsOn.toLowerCase();
  if (label.includes("ubuntu") || label.includes("linux")) return "ubuntu";
  if (label.includes("macos") || label.includes("mac-os") || label.includes("osx")) return "macos";
  if (label.includes("windows")) return "windows";
  return "unknown";
}

function estimateStepDuration(stepName: string, uses?: string, run?: string): number {
  const haystack = [stepName, uses ?? "", run ?? ""].join(" ").toLowerCase();

  for (const heuristic of STEP_DURATION_HEURISTICS) {
    if (heuristic.pattern.test(haystack)) {
      return heuristic.seconds;
    }
  }

  // Generic step fallback
  return 60;
}

function roundUpToMinute(seconds: number): number {
  return Math.ceil(seconds / BILLING_INCREMENT_SECONDS) * BILLING_INCREMENT_SECONDS;
}

function calculateJobCost(seconds: number, runner: RunnerType): number {
  const billedSeconds = roundUpToMinute(seconds);
  const minutes = billedSeconds / 60;
  return minutes * COST_RATES[runner];
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
  return line.length - line.trimStart().length;
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
    const line = lines[i];
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

function parseWorkflowYaml(content: string): RawWorkflow {
  const lines = content.split("\n");
  const workflow: RawWorkflow = { name: "", jobs: [] };

  let i = 0;

  // Extract top-level name
  for (let j = 0; j < lines.length; j++) {
    const line = lines[j];
    if (line.match(/^name:\s*/)) {
      workflow.name = stripInlineComment(line.replace(/^name:\s*/, "").replace(/^['"]|['"]$/g, ""));
      break;
    }
  }

  // Find jobs: block
  let jobsStart = -1;
  for (let j = 0; j < lines.length; j++) {
    if (lines[j].match(/^jobs:\s*$/)) {
      jobsStart = j + 1;
      break;
    }
  }

  if (jobsStart === -1) return workflow;

  i = jobsStart;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    const indent = getIndent(line);

    // Job-level keys are at indent=2 (standard) and look like "  job-id:"
    if (indent === 2 && line.match(/^\s{2}[\w-]+:\s*$/)) {
      const jobId = line.trim().replace(/:$/, "");
      const job: RawJob = {
        id: jobId,
        name: jobId,
        runsOn: "ubuntu-latest",
        steps: [],
        matrix: [],
      };

      i++;

      // Parse job body
      while (i < lines.length) {
        const jobLine = lines[i];

        if (jobLine.trim() === "" || jobLine.trim().startsWith("#")) {
          i++;
          continue;
        }

        const jobIndent = getIndent(jobLine);

        // End of this job (next job or top-level key)
        if (jobIndent <= 2 && !jobLine.match(/^\s{4}/)) {
          break;
        }

        // Job name override
        if (jobLine.match(/^\s{4}name:\s*/)) {
          job.name = stripInlineComment(
            jobLine.replace(/^\s{4}name:\s*/, "").replace(/^['"]|['"]$/g, "")
          );
          i++;
          continue;
        }

        // runs-on
        if (jobLine.match(/^\s{4}runs-on:\s*/)) {
          job.runsOn = stripInlineComment(
            jobLine.replace(/^\s{4}runs-on:\s*/, "").replace(/^['"]|['"]$/g, "")
          );
          i++;
          continue;
        }

        // strategy.matrix
        if (jobLine.match(/^\s{4}strategy:\s*$/)) {
          i++;
          while (i < lines.length) {
            const stratLine = lines[i];
            if (stratLine.trim() === "" || stratLine.trim().startsWith("#")) {
              i++;
              continue;
            }
            if (getIndent(stratLine) <= 4) break;

            if (stratLine.match(/^\s{6}matrix:\s*$/)) {
              i++;
              while (i < lines.length) {
                const matLine = lines[i];
                if (matLine.trim() === "" || matLine.trim().startsWith("#")) {
                  i++;
                  continue;
                }
                if (getIndent(matLine) <= 6) break;

                // Matrix key: [values] (inline)
                const inlineMatch = matLine.match(/^\s{8}([\w-]+):\s*(\[.+\])/);
                if (inlineMatch) {
                  const values = parseInlineArray(inlineMatch[2]);
                  if (values.length > 0) {
                    job.matrix.push({ key: inlineMatch[1], values });
                  }
                  i++;
                  continue;
                }

                // Matrix key: (block list)
                const blockMatch = matLine.match(/^\s{8}([\w-]+):\s*$/);
                if (blockMatch) {
                  i++;
                  const values = parseMatrixValues(lines, i, 10);
                  // advance i past the list items
                  while (i < lines.length) {
                    const vl = lines[i];
                    if (vl.trim() === "" || vl.trim().startsWith("#")) {
                      i++;
                      continue;
                    }
                    if (getIndent(vl) < 10 || !vl.trimStart().startsWith("- ")) break;
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

        // steps:
        if (jobLine.match(/^\s{4}steps:\s*$/)) {
          i++;
          let currentStep: Partial<RawStep> | null = null;

          while (i < lines.length) {
            const stepLine = lines[i];

            if (stepLine.trim() === "" || stepLine.trim().startsWith("#")) {
              i++;
              continue;
            }

            const stepIndent = getIndent(stepLine);

            if (stepIndent < 4) break;

            // New step item
            if (stepIndent === 6 && stepLine.match(/^\s{6}-\s/)) {
              if (currentStep) {
                job.steps.push({
                  name: currentStep.name ?? "unnamed step",
                  uses: currentStep.uses,
                  run: currentStep.run,
                });
              }
              currentStep = {};

              // Check for inline key on same line as dash: "- uses: actions/checkout@v4"
              const inlineKey = stepLine.replace(/^\s{6}-\s+/, "");
              const keyMatch = inlineKey.match(/^(name|uses|run):\s*(.*)/);
              if (keyMatch) {
                const key = keyMatch[1] as "name" | "uses" | "run";
                currentStep[key] = stripInlineComment(keyMatch[2]);
              }

              i++;
              continue;
            }

            // Step properties at indent 8
            if (stepIndent === 8 && currentStep !== null) {
              const propMatch = stepLine.match(/^\s{8}(name|uses|run):\s*(.*)/);
              if (propMatch) {
                const key = propMatch[1] as "name" | "uses" | "run";
                let val = stripInlineComment(propMatch[2]).replace(/^['"]|['"]$/g, "");
                // Handle multi-line run blocks (pipe |)
                if (val === "|" || val === ">") {
                  val = "";
                  i++;
                  while (i < lines.length) {
                    const runLine = lines[i];
                    if (runLine.trim() === "") {
                      i++;
                      continue;
                    }
                    if (getIndent(runLine) <= 8) break;
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

export function estimateWorkflow(filePath: string, pushesPerDay: number): WorkflowEstimate {
  const content = readFileSync(filePath, "utf-8");
  const raw = parseWorkflowYaml(content);

  const jobEstimates: JobEstimate[] = [];

  for (const rawJob of raw.jobs) {
    const runner = detectRunnerType(rawJob.runsOn);

    const steps: StepEstimate[] = rawJob.steps.map((s) => ({
      name: s.name,
      uses: s.uses,
      run: s.run,
      estimatedSeconds: estimateStepDuration(s.name, s.uses, s.run),
    }));

    // If no steps were detected, assume a minimal job time
    const totalSecondsPerMatrix =
      steps.length > 0 ? steps.reduce((sum, s) => sum + s.estimatedSeconds, 0) : 60;

    const matrixCombinations = computeMatrixCombinations(rawJob.matrix);
    const totalSeconds = totalSecondsPerMatrix * matrixCombinations;
    const costPerRun = calculateJobCost(totalSecondsPerMatrix, runner) * matrixCombinations;

    jobEstimates.push({
      id: rawJob.id,
      name: rawJob.name,
      runner,
      runnerLabel: rawJob.runsOn,
      steps,
      matrix: rawJob.matrix,
      matrixCombinations,
      estimatedSecondsPerMatrix: totalSecondsPerMatrix,
      estimatedTotalSeconds: totalSeconds,
      estimatedCostUsd: costPerRun,
    });
  }

  const totalSeconds = jobEstimates.reduce((sum, j) => sum + j.estimatedTotalSeconds, 0);
  const costPerRun = jobEstimates.reduce((sum, j) => sum + j.estimatedCostUsd, 0);
  const costPerDay = costPerRun * pushesPerDay;
  const costPerMonth = costPerDay * 30;

  const hints = generateHints(jobEstimates);

  return {
    file: basename(filePath),
    workflowName: raw.name || basename(filePath),
    jobs: jobEstimates,
    totalEstimatedSeconds: totalSeconds,
    totalEstimatedCostPerRun: costPerRun,
    totalEstimatedCostPerDay: costPerDay,
    totalEstimatedCostPerMonth: costPerMonth,
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
