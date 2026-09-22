import assert from "node:assert/strict";
import { test } from "node:test";
import { dateWindows, needsRefresh, parseDays, seconds, summarizeJob, summarizeRun } from "../scripts/collect.ts";

const step = {
  name: "Validate All Specs", status: "completed", conclusion: "success",
  started_at: "2026-09-22T12:01:00Z", completed_at: "2026-09-22T12:11:00Z",
};
const job = {
  ...step, id: 1, name: "TSV (default, windows, 1, 3)", html_url: "https://github.com/example/job/1",
  steps: [step],
};
const run = {
  id: 1, run_attempt: 1, display_title: "Test run", html_url: "https://github.com/example/run/1",
  event: "push", head_branch: "main", head_sha: "abc", created_at: step.started_at,
  run_started_at: step.started_at, updated_at: step.completed_at, status: "completed", conclusion: "success",
};
test("collector extracts matrix, step durations, and explicit missing setup", () => {
  const result = summarizeJob(job);
  assert.equal(result.os, "windows");
  assert.equal(result.shard, 1);
  assert.equal(result.validation, 600);
  assert.equal(result.setup, null);
  assert.throws(() => summarizeJob({ ...job, name: "Unexpected job" }), /Unrecognized/);
});
test("lost-runner step timestamps and skipped steps do not become zero-duration success", () => {
  assert.equal(summarizeJob({ ...job, steps: [{ ...step, completed_at: null }] }).validation, null);
  assert.equal(summarizeJob({ ...job, steps: [{ ...step, conclusion: "skipped" }] }).validation, null);
  assert.equal(seconds(step.completed_at, step.started_at), null);
  assert.equal(seconds("bad", step.completed_at), null);
});
test("completed unchanged runs are cached; reruns and in-progress runs refresh", () => {
  const saved = summarizeRun(run, [job]);
  assert.equal(needsRefresh(saved, run), false);
  assert.equal(needsRefresh(saved, { ...run, run_attempt: 2 }), true);
  assert.equal(needsRefresh({ ...saved, status: "in_progress" }, run), true);
  assert.equal(needsRefresh(undefined, run), true);
});
test("backfill day windows have no overlap or missing whole seconds", () => {
  assert.deepEqual(dateWindows(new Date("2026-09-21T00:00:00Z"), new Date("2026-09-22T12:00:00Z")), [
    { start: "2026-09-21T00:00:00Z", end: "2026-09-21T23:59:59Z" },
    { start: "2026-09-22T00:00:00Z", end: "2026-09-22T12:00:00Z" },
  ]);
});
test("collector arguments reject typos and invalid history lengths", () => {
  assert.equal(parseDays([]), null);
  assert.equal(parseDays(["--days", "30"]), 30);
  for (const args of [["--days", "0"], ["--days", "no"], ["--day", "30"], ["--days"]]) {
    assert.throws(() => parseDays(args), /Usage/);
  }
});
