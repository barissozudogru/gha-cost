export type RunnerType = "ubuntu" | "macos" | "windows" | "unknown";

export interface StepEstimate {
  name: string;
  uses?: string;
  run?: string;
  estimatedSeconds: number;
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
  estimatedTotalSeconds: number;
  estimatedCostUsd: number;
}

export interface WorkflowEstimate {
  file: string;
  workflowName: string;
  jobs: JobEstimate[];
  totalEstimatedSeconds: number;
  totalEstimatedCostPerRun: number;
  totalEstimatedCostPerDay: number;
  totalEstimatedCostPerMonth: number;
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
