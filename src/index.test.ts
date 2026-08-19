import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { estimateWorkflow, COST_RATES, estimateStepDurationForTest } from "./index.js";
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
    const seconds = estimateStepDurationForTest(
      "Published content identity scan",
      undefined,
      'if [ -z "$FORBIDDEN" ]; then echo ok; fi'
    );
    assert.ok(seconds <= 15, `expected a generic step, got ${seconds}s`);
  });

  it("still recognises a real deploy step", () => {
    const seconds = estimateStepDurationForTest(
      "Deploy to Cloudflare Pages",
      "cloudflare/wrangler-action@v3",
      undefined
    );
    assert.equal(seconds, 45);
  });

  it("recognises a real publish step", () => {
    assert.equal(
      estimateStepDurationForTest("Publish to npm", undefined, "npm publish"),
      30
    );
  });
});
