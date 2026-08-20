export type RunnerType = "ubuntu" | "macos" | "windows" | "unknown";

export interface StepEstimate {
  name: string;
  uses?: string;
  run?: string;
  /** Midpoint of the estimated range, kept for JSON consumers. */
  estimatedSeconds: number;
  estimatedSecondsLow: number;
  estimatedSecondsHigh: number;
}

export interface MatrixDimension {
  key: string;
  values: string[];
}

export interface JobEstimate {
  id: string;
  name: string;
  runner: RunnerType;
  runnerLabel: string;
  steps: StepEstimate[];
  matrix: MatrixDimension[];
  matrixCombinations: number;
  estimatedSecondsPerMatrix: number;
  estimatedSecondsLowPerMatrix: number;
  estimatedSecondsHighPerMatrix: number;
  estimatedTotalSeconds: number;
  estimatedCostUsd: number;
}

export interface WorkflowEstimate {
  file: string;
  workflowName: string;
  jobs: JobEstimate[];
  totalEstimatedSeconds: number;
  totalEstimatedSecondsLow: number;
  totalEstimatedSecondsHigh: number;
  /** Whether the workflow declares a dependency cache. */
  cachingDetected: boolean;
  totalEstimatedCostPerRun: number;
  totalEstimatedCostPerDay: number;
  totalEstimatedCostPerMonth: number;
  /** Runs per day derived from the workflow's own triggers. */
  runsPerDay: number;
  /** Where runsPerDay came from, e.g. "1/week from schedule". */
  frequencyBasis: string;
  /** Trigger names declared in the on: block. */
  triggers: string[];
  hints: string[];
}

export interface CostRates {
  ubuntu: number;
  macos: number;
  windows: number;
  unknown: number;
}

export interface CliOptions {
  file?: string;
  pushes: number;
  json: boolean;
  selfHostedRate?: number;
  version: boolean;
  help: boolean;
}
