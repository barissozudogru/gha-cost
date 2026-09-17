import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateWorkflow,
  COST_RATES,
  estimateStepDurationForTest,
  detectsCachingForTest,
} from "./index.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("COST_RATES", () => {
  it("defaults unknown runner rate to 0", () => {
    assert.equal(COST_RATES.unknown, 0);
  });
});

describe("estimateWorkflow self-hosted rate handling", () => {
  it("defaults self-hosted runners to 0 cost when selfHostedRate is omitted", () => {
    const tmpFile = join(tmpdir(), `test-workflow-${Date.now()}.yml`);
    const yaml = `
name: Self Hosted Test
jobs:
  build:
    runs-on: self-hosted
    steps:
      - name: Build
        run: echo "hello"
`;
    writeFileSync(tmpFile, yaml, "utf-8");

    try {
      const estimate = estimateWorkflow(tmpFile, 10);
      assert.equal(estimate.jobs[0].runner, "unknown");
      assert.equal(estimate.jobs[0].estimatedCostUsd, 0);
      assert.equal(estimate.totalEstimatedCostPerRun, 0);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("applies custom selfHostedRate when provided", () => {
    const tmpFile = join(tmpdir(), `test-workflow-custom-${Date.now()}.yml`);
    const yaml = `
name: Self Hosted Custom Test
jobs:
  build:
    runs-on: self-hosted
    steps:
      - name: Build
        run: echo "hello"
`;
    writeFileSync(tmpFile, yaml, "utf-8");

    try {
      const estimate = estimateWorkflow(tmpFile, 10, 0.005);
      assert.equal(estimate.jobs[0].runner, "unknown");
      // 60s -> 1 minute * 0.005 = 0.005
      assert.equal(estimate.jobs[0].estimatedCostUsd, 0.005);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("detects self-hosted runner even if linux is in the label array", () => {
    const tmpFile = join(tmpdir(), `test-workflow-sh-linux-${Date.now()}.yml`);
    const yaml = `
name: Self Hosted Linux Test
jobs:
  build:
    runs-on: [self-hosted, linux, x64]
    steps:
      - name: Build
        run: echo "hello"
`;
    writeFileSync(tmpFile, yaml, "utf-8");

    try {
      const estimate = estimateWorkflow(tmpFile, 10);
      assert.equal(estimate.jobs[0].runner, "unknown");
      assert.equal(estimate.jobs[0].estimatedCostUsd, 0);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

describe("summary cost bounds", () => {
  it("bills the macOS bound at the macOS rate, matching the job row", () => {
    const tmpFile = join(tmpdir(), `test-workflow-bounds-mac-${Date.now()}.yml`);
    const yaml = `
name: Mac Bounds Test
jobs:
  build:
    runs-on: macos-latest
    steps:
      - name: Do thing
        run: ./script.sh
`;
    writeFileSync(tmpFile, yaml, "utf-8");

    try {
      const estimate = estimateWorkflow(tmpFile, 10);
      // A generic step spans 0s to 60s. The high bound is one rounded minute
      // at $0.08, not 60/60 minutes at the ubuntu rate the summary once
      // applied to raw seconds.
      assert.equal(estimate.jobs[0].estimatedCostUsdHigh, 0.08);
      assert.equal(estimate.totalEstimatedCostPerRunLow, 0);
      assert.equal(estimate.totalEstimatedCostPerRunHigh, 0.08);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("rounds each job's bounds up to whole minutes on that job's runner rate", () => {
    const tmpFile = join(tmpdir(), `test-workflow-bounds-mixed-${Date.now()}.yml`);
    const yaml = `
name: Mixed Bounds Test
jobs:
  linux:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: npm ci
  windows:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
`;
    writeFileSync(tmpFile, yaml, "utf-8");

    try {
      const estimate = estimateWorkflow(tmpFile, 10);
      // Checkout spans 1-25s and npm ci 15-120s, so the ubuntu job spans 16s
      // to 145s: one and three rounded minutes. The windows job spans 1-25s,
      // one rounded minute at twice the ubuntu rate. Summing the job rows has
      // to land inside the workflow bounds.
      const linux = estimate.jobs.find((j) => j.id === "linux");
      const windows = estimate.jobs.find((j) => j.id === "windows");
      assert.ok(linux && windows);
      assert.equal(linux.estimatedCostUsdLow, 1 * 0.008);
      assert.equal(linux.estimatedCostUsdHigh, 3 * 0.008);
      assert.equal(windows.estimatedCostUsdLow, 1 * 0.016);
      assert.equal(windows.estimatedCostUsdHigh, 1 * 0.016);
      assert.equal(estimate.totalEstimatedCostPerRunLow, 1 * 0.008 + 1 * 0.016);
      assert.equal(estimate.totalEstimatedCostPerRunHigh, 3 * 0.008 + 1 * 0.016);
      assert.ok(
        estimate.totalEstimatedCostPerRunLow <= estimate.totalEstimatedCostPerRun &&
          estimate.totalEstimatedCostPerRun <= estimate.totalEstimatedCostPerRunHigh,
        "the midpoint cost must sit inside the bounds"
      );
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

describe("matrix runner resolution", () => {
  const MATRIX_STEPS_YAML = `
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: npm ci
`;

  function writeTempYaml(name: string, yaml: string): string {
    const tmpFile = join(tmpdir(), `test-workflow-${name}-${Date.now()}.yml`);
    writeFileSync(tmpFile, yaml, "utf-8");
    return tmpFile;
  }

  it("bills each matrix combination on the runner it resolves to", () => {
    // checkout spans 1-25s (midpoint 13s) and npm ci 15-120s (midpoint 68s),
    // so every combination bills 2 rounded minutes. Before the fix the literal
    // \${{ matrix.os }} label was classified as unknown and all three
    // combinations cost $0, ignoring the macOS and Windows runners entirely.
    const tmpFile = writeTempYaml(
      "matrix-os",
      `
name: Matrix OS Test
jobs:
  job1:
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: \${{ matrix.os }}
${MATRIX_STEPS_YAML}
`
    );

    try {
      const estimate = estimateWorkflow(tmpFile, 10);
      const job = estimate.jobs[0];
      assert.equal(job.matrixCombinations, 3);
      assert.equal(job.runner, "macos");
      assert.equal(job.runnerLabel, "${{ matrix.os }}");
      // 2 minutes each at $0.008, $0.08 and $0.016. Bounds: 16s is one
      // rounded minute, 145s is three.
      assert.equal(job.estimatedCostUsd, 2 * (0.008 + 0.08 + 0.016));
      assert.equal(job.estimatedCostUsdLow, 1 * (0.008 + 0.08 + 0.016));
      assert.equal(job.estimatedCostUsdHigh, 3 * (0.008 + 0.08 + 0.016));
      assert.equal(estimate.totalEstimatedCostPerRun, 2 * (0.008 + 0.08 + 0.016));
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("resolves a matrix of one platform to that platform's rate", () => {
    const tmpFile = writeTempYaml(
      "matrix-ubuntu",
      `
name: Matrix Ubuntu Test
jobs:
  build:
    strategy:
      matrix:
        os: [ubuntu-22.04, ubuntu-24.04]
    runs-on: \${{ matrix.os }}
${MATRIX_STEPS_YAML}
`
    );

    try {
      const estimate = estimateWorkflow(tmpFile, 10);
      const job = estimate.jobs[0];
      assert.equal(job.runner, "ubuntu");
      // Two combinations, each 2 rounded minutes on ubuntu.
      assert.equal(job.estimatedCostUsd, 2 * 2 * 0.008);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("resolves every dimension of a multi-dimensional matrix", () => {
    // os is written as a block list and node as an inline one, so both parser
    // paths feed the resolution. Four combinations: ubuntu and macos, twice
    // each, each billing 2 rounded minutes.
    const tmpFile = writeTempYaml(
      "matrix-multi",
      `
name: Matrix Multi Test
jobs:
  build:
    strategy:
      matrix:
        os:
          - ubuntu-latest
          - macos-latest
        node: [18, 20]
    runs-on: \${{ matrix.os }}
${MATRIX_STEPS_YAML}
`
    );

    try {
      const estimate = estimateWorkflow(tmpFile, 10);
      const job = estimate.jobs[0];
      assert.equal(job.matrixCombinations, 4);
      assert.equal(job.runner, "macos");
      assert.equal(job.estimatedCostUsd, 2 * 2 * 0.008 + 2 * 2 * 0.08);
    } finally {
      unlinkSync(tmpFile);
    }
  });

  it("keeps the self-hosted rate for expressions it cannot resolve", () => {
    // The matrix has no runner dimension, so the label cannot be substituted
    // and stays on the unknown rate rather than guessing a platform.
    const tmpFile = writeTempYaml(
      "matrix-unresolved",
      `
name: Matrix Unresolved Test
jobs:
  build:
    strategy:
      matrix:
        node: [18, 20]
    runs-on: \${{ matrix.runner }}
${MATRIX_STEPS_YAML}
`
    );

    try {
      const estimate = estimateWorkflow(tmpFile, 10, 0.005);
      const job = estimate.jobs[0];
      assert.equal(job.runner, "unknown");
      // Two combinations, each 2 rounded minutes at the custom rate.
      assert.equal(job.estimatedCostUsd, 2 * 2 * 0.005);
    } finally {
      unlinkSync(tmpFile);
    }
  });
});

describe("step duration heuristics", () => {
  it("does not bill a step named 'Published ...' as a publish action", () => {
    // /publish/i matched "Published content identity scan", a shell one-liner
    // that measured 0.1s, and estimated it at a minute.
    const r = estimateStepDurationForTest(
      "Published content identity scan",
      undefined,
      'if [ -z "$FORBIDDEN" ]; then echo ok; fi'
    );
    // It must fall through to generic rather than match the publish heuristic,
    // which starts at 5s. A tenth-of-a-second shell step has to be reachable.
    const publish = estimateStepDurationForTest("Publish to npm", undefined, "npm publish");
    assert.notDeepEqual(r, publish, "matched the publish heuristic");
    assert.equal(r.low, 0, `a trivial shell step must be reachable, got ${r.low}s`);
  });

  it("still recognises a real deploy step", () => {
    const r = estimateStepDurationForTest(
      "Deploy to Cloudflare Pages",
      "cloudflare/wrangler-action@v3",
      undefined
    );
    assert.deepEqual(r, { low: 8, high: 90 });
  });

  it("recognises a real publish step", () => {
    assert.deepEqual(
      estimateStepDurationForTest("Publish to npm", undefined, "npm publish"),
      { low: 5, high: 45 }
    );
  });
});

describe("estimated ranges against measured runs", () => {
  // Every figure below was measured from real workflow runs via the Actions
  // API, not chosen to make the test pass. A range that excludes the truth is
  // worse than no range, so this is the acceptance criterion for the estimator.
  const MEASURED: Array<[string, string | undefined, string | undefined, number, boolean]> = [
    ["Checkout", "actions/checkout@v4", undefined, 13.7, true],
    ["Checkout", "actions/checkout@v4", undefined, 1.0, false],
    ["Setup Node", "actions/setup-node@v4", undefined, 8.9, true],
    ["Install dependencies", undefined, "npm ci", 24.0, true],
    ["Build site", undefined, "npm run build", 21.7, true],
    ["Deploy to Cloudflare Pages", "cloudflare/wrangler-action@v3", undefined, 21.6, true],
    ["Venue data guard", undefined, "npm run guard:venues", 2.2, true],
    ["Purge Cloudflare edge cache", undefined, "curl -sS -X POST", 0.1, true],
    ["Long shell step", undefined, "bash ./do-a-lot.sh", 49.0, false],
  ];

  for (const [name, uses, run, measured, cached] of MEASURED) {
    it(`brackets ${measured}s for "${name}"`, () => {
      const r = estimateStepDurationForTest(name, uses, run, cached);
      assert.ok(
        measured >= r.low && measured <= r.high,
        `measured ${measured}s outside predicted ${r.low}-${r.high}s`
      );
    });
  }

  it("keeps every range ordered and non-negative", () => {
    for (const [name, uses, run] of MEASURED) {
      for (const cached of [true, false]) {
        const r = estimateStepDurationForTest(name, uses, run, cached);
        assert.ok(r.low >= 0, `${name}: negative low bound`);
        assert.ok(r.high >= r.low, `${name}: high bound below low bound`);
      }
    }
  });

  it("a declared cache narrows the range without moving the floor", () => {
    const cold = estimateStepDurationForTest("Install", undefined, "npm ci", false);
    const warm = estimateStepDurationForTest("Install", undefined, "npm ci", true);
    assert.equal(warm.low, cold.low, "the fast case is unchanged by caching");
    assert.ok(warm.high < cold.high, "caching should lower the slow case");
  });
});

describe("cache detection", () => {
  it("finds cache: nested under a setup action", () => {
    const wf = [
      "jobs:", "  a:", "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:", "          node-version: 20", "          cache: npm",
    ].join("\n");
    assert.equal(detectsCachingForTest(wf), true);
  });

  it("finds an explicit actions/cache step", () => {
    assert.equal(detectsCachingForTest("      - uses: actions/cache@v4\n"), true);
  });

  it("reports none when the workflow declares no cache", () => {
    const wf = [
      "jobs:", "  a:", "    steps:",
      "      - uses: actions/setup-node@v4",
      "        with:", "          node-version: 20",
    ].join("\n");
    assert.equal(detectsCachingForTest(wf), false);
  });
});
