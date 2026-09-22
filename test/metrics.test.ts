import assert from "node:assert/strict";
import { test } from "node:test";
import { comparison, completeShards, dailyMedians, duration, median, selectRuns, valueForJobs } from "../public/metrics.js";

const jobs = (ref = "default", os = "ubuntu") => [0, 1, 2].map((shard) => ({
  ref, os, shard, totalShards: 3, status: "completed", conclusion: "success",
  startedAt: "2026-09-22T12:00:00Z", completedAt: "2026-09-22T12:10:00Z",
  validation: 500,
}));
const run = (overrides = {}) => ({
  id: 1, event: "push", branch: "main", status: "completed", conclusion: "success",
  createdAt: "2026-09-22T12:02:00Z",
  jobs: [...jobs(), ...jobs("default", "windows")],
  ...overrides,
});

test("duration rounds cleanly and missing values remain missing", () => {
  assert.equal(duration(119.8), "2m 00s");
  assert.equal(duration(null), "\u2014");
  assert.equal(duration(0), "0m 00s");
});
test("median does not mutate its inputs", () => {
  const values = [8, 1, 2, 4];
  assert.equal(median(values), 3);
  assert.deepEqual(values, [8, 1, 2, 4]);
  assert.equal(median([]), null);
});
test("elapsed, aggregate validation, and slowest shard stay distinct", () => {
  assert.equal(valueForJobs(jobs(), "elapsed"), 600);
  assert.equal(valueForJobs(jobs(), "validation"), 1500);
  assert.equal(valueForJobs(jobs(), "slowest"), 500);
});
test("missing, duplicate, skipped, or incomplete shards cannot produce a partial total", () => {
  assert.equal(completeShards(jobs().slice(1)), false);
  assert.equal(completeShards([jobs()[0], jobs()[0], jobs()[2]]), false);
  assert.equal(valueForJobs(jobs().map((job) => ({ ...job, validation: null })), "validation"), null);
  assert.equal(valueForJobs(jobs().map((job) => ({ ...job, status: "in_progress" })), "elapsed"), null);
});
test("scheduled main success is independent of failing typespec-next jobs", () => {
  const next = [...jobs("next"), ...jobs("next", "windows")].map((job) => ({ ...job, conclusion: "failure" }));
  const scheduled = run({ event: "schedule", conclusion: "failure", jobs: [...run().jobs, ...next] });
  const options = { cohort: "schedule", days: "all", outcome: "success", metric: "elapsed" };
  assert.equal(selectRuns([scheduled], options).length, 1);
  assert.equal(selectRuns([scheduled], { ...options, cohort: "next" }).length, 0);
  assert.equal(selectRuns([scheduled], { ...options, cohort: "next", outcome: "all" }).length, 1);
});
test("default cohort excludes PRs, schedules, other branches, and incomplete runs", () => {
  const runs = [run(), run({ event: "pull_request" }), run({ event: "schedule" }), run({ branch: "typespec-next" }), run({ status: "in_progress" }), run({ jobs: jobs() })];
  assert.equal(selectRuns(runs, { cohort: "push", days: "all", outcome: "success", metric: "elapsed" }).length, 1);
});
test("time filter and UTC daily medians are deterministic", () => {
  const selected = selectRuns([run()], { cohort: "push", days: "7", outcome: "success", metric: "elapsed" }, Date.parse("2026-10-01"));
  assert.equal(selected.length, 0);
  assert.deepEqual(dailyMedians([{ createdAt: "2026-09-22T23:59:00Z", ubuntu: 300 }, { createdAt: "2026-09-22T00:01:00Z", ubuntu: 500 }], "ubuntu"), [{ time: Date.parse("2026-09-22T12:00:00Z"), value: 400 }]);
});
test("merge comparison uses nearest before and first after, at most seven each", () => {
  const runs = Array.from({ length: 10 }, (_, index) => ({ createdAt: `2026-09-21T${String(index).padStart(2, "0")}:00:00Z`, ubuntu: 100 }));
  runs.push({ createdAt: "2026-09-22T13:00:00Z", ubuntu: 80 });
  const result = comparison(runs, "ubuntu");
  assert.equal(result.before, 7);
  assert.equal(result.after, 1);
  assert.ok(Math.abs(result.reduction - 20) < 1e-9);
});
