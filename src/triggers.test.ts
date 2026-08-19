import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTriggers, cronRunsPerDay, estimateRunsPerDay } from "./triggers.js";

/**
 * Cost per run was multiplied by a flat pushes-per-day for every workflow, so a
 * weekly cron was billed as if it fired ten times a day. On a real repository
 * that reported $98.40/month against a true figure of about two dollars.
 */

test("cron frequency is right for the common shapes", () => {
  assert.equal(cronRunsPerDay("0 3 * * *"), 1);          // daily
  assert.equal(cronRunsPerDay("0 * * * *"), 24);         // hourly
  assert.equal(cronRunsPerDay("*/15 * * * *"), 96);      // every 15 minutes
  assert.equal(Math.round(cronRunsPerDay("0 8 * * 1") * 1000) / 1000, 0.143); // weekly
  assert.ok(cronRunsPerDay("0 9 1 * *") < 0.04);         // monthly
  assert.equal(Math.round(cronRunsPerDay("30 2 * * 1-5") * 1000) / 1000, 0.714); // weekdays
});

test("a malformed cron contributes nothing rather than guessing", () => {
  assert.equal(cronRunsPerDay("not a cron"), 0);
  assert.equal(cronRunsPerDay("0 3 * *"), 0);
});

test("all three on: forms parse", () => {
  assert.deepEqual(parseTriggers("on: push\njobs:\n  a:\n").names, ["push"]);
  assert.deepEqual(
    parseTriggers("on: [push, pull_request]\njobs:\n  a:\n").names,
    ["push", "pull_request"]
  );
  const block = ["on:", "  push:", "    branches: [main]", "  workflow_dispatch:", "jobs:"].join("\n");
  assert.deepEqual(parseTriggers(block).names, ["push", "workflow_dispatch"]);
});

test("nested keys are not mistaken for triggers", () => {
  const wf = ["on:", "  push:", "    branches:", "      - main", "    paths:", "      - src/**", "jobs:"].join("\n");
  const t = parseTriggers(wf);
  assert.deepEqual(t.names, ["push"]);
  assert.ok(!t.names.includes("branches"));
  assert.ok(!t.names.includes("paths"));
});

test("quoted on: keys parse, since YAML reads bare on as boolean true", () => {
  assert.deepEqual(parseTriggers('"on": push\njobs:\n').names, ["push"]);
  assert.deepEqual(parseTriggers("'on': push\njobs:\n").names, ["push"]);
});

test("schedule crons are collected", () => {
  const wf = ["on:", "  schedule:", "    - cron: '0 8 * * 1'", "    - cron: \"0 20 * * 5\"", "jobs:"].join("\n");
  assert.deepEqual(parseTriggers(wf).crons, ["0 8 * * 1", "0 20 * * 5"]);
});

test("pushes per day applies only to push-like triggers", () => {
  const scheduled = parseTriggers(["on:", "  schedule:", "    - cron: '0 8 * * 1'", "jobs:"].join("\n"));
  const e = estimateRunsPerDay(scheduled, 10);
  assert.ok(e.runsPerDay < 0.2, "a weekly cron must not inherit the push rate");
  assert.match(e.basis, /schedule/);

  const pushed = parseTriggers("on: push\njobs:\n");
  assert.equal(estimateRunsPerDay(pushed, 10).runsPerDay, 10);
});

test("push and schedule together are added", () => {
  const wf = ["on:", "  push:", "  schedule:", "    - cron: '0 3 * * *'", "jobs:"].join("\n");
  assert.equal(estimateRunsPerDay(parseTriggers(wf), 10).runsPerDay, 11);
});

test("a manual-only workflow reports no cadence rather than inventing one", () => {
  const wf = ["on:", "  workflow_dispatch:", "jobs:"].join("\n");
  const t = parseTriggers(wf);
  assert.equal(t.manualOnly, true);
  const e = estimateRunsPerDay(t, 10);
  assert.equal(e.runsPerDay, 0);
  assert.match(e.basis, /manual/);
});

test("parsing one workflow does not affect the next", () => {
  const nested = ["on:", "  push:", "    branches: [main]", "jobs:"].join("\n");
  parseTriggers(nested);
  const simple = ["on:", "  schedule:", "    - cron: '0 3 * * *'", "jobs:"].join("\n");
  assert.deepEqual(parseTriggers(simple).names, ["schedule"]);
});
