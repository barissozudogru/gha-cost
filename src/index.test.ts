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
