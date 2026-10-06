import assert from "node:assert/strict";
import { test } from "node:test";
import { comparison, completeShards, duration, median, milestones, selectRuns, valueForJobs } from "../public/metrics.js";
import { dailySeries, rollingMedianSeries, weekendRanges } from "../public/chart.js";

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
test("both historical and current shard numbering produce complete measurements", () => {
  for (const offset of [0, 1]) {
    const currentJobs = run().jobs.map((job) => ({ ...job, shard: job.shard + offset }));
    const selected = selectRuns([run({ jobs: currentJobs })], { days: "all", outcome: "success", metric: "validation" });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].ubuntu, 1500);
    assert.equal(selected[0].windows, 1500);
    assert.equal(valueForJobs(currentJobs.filter((job) => job.os === "ubuntu"), "elapsed"), 600);
    assert.equal(valueForJobs(currentJobs.filter((job) => job.os === "ubuntu"), "slowest"), 500);
  }
});
test("mixed, fractional, and out-of-range shard numbering stays incomplete", () => {
  for (const shards of [[0, 1, 3], [0, 2, 3], [1, 1, 3], [1, 2, 4], [-1, 0, 1], [0, 0.5, 2], [1, 1.5, 3]]) {
    const invalid = jobs().map((job, index) => ({ ...job, shard: shards[index] }));
    assert.equal(completeShards(invalid), false, JSON.stringify(shards));
    assert.equal(valueForJobs(invalid, "validation"), null);
  }
  assert.equal(completeShards([]), false);
  assert.equal(completeShards(jobs().map((job, index) => ({ ...job, totalShards: index === 0 ? 3 : 4 }))), false);
});
test("scheduled runs are excluded even when main succeeds", () => {
  const next = [...jobs("next"), ...jobs("next", "windows")].map((job) => ({ ...job, conclusion: "failure" }));
  const scheduled = run({ event: "schedule", conclusion: "failure", jobs: [...run().jobs, ...next] });
  const options = { days: "all", outcome: "success", metric: "elapsed" };
  assert.equal(selectRuns([scheduled], options).length, 0);
  assert.equal(selectRuns([scheduled], { ...options, outcome: "all" }).length, 0);
});
test("default cohort excludes PRs, schedules, other branches, and incomplete runs", () => {
  const runs = [run(), run({ event: "pull_request" }), run({ event: "schedule" }), run({ branch: "typespec-next" }), run({ status: "in_progress" }), run({ jobs: jobs() })];
  assert.equal(selectRuns(runs, { days: "all", outcome: "success", metric: "elapsed" }).length, 1);
});
test("time filter and UTC daily medians are deterministic", () => {
  const selected = selectRuns([run()], { days: "7", outcome: "success", metric: "elapsed" }, Date.parse("2026-10-01"));
  assert.equal(selected.length, 0);
  assert.deepEqual(dailySeries([{ createdAt: "2026-09-22T23:59:00Z", ubuntu: 300 }, { createdAt: "2026-09-22T00:01:00Z", ubuntu: 500 }], "ubuntu"), [{ time: Date.parse("2026-09-22T12:00:00Z"), value: 400 }]);
});
test("weekend shading covers UTC Saturdays and Sundays, including gaps without runs", () => {
  const start = Date.parse("2026-10-02T00:00:00Z");
  assert.deepEqual(weekendRanges(start, Date.parse("2026-10-06T00:00:00Z")), [
    { start: Date.parse("2026-10-03T00:00:00Z"), end: Date.parse("2026-10-05T00:00:00Z") },
  ]);
  assert.deepEqual(weekendRanges(start, Date.parse("2026-10-13T00:00:00Z")), [
    { start: Date.parse("2026-10-03T00:00:00Z"), end: Date.parse("2026-10-05T00:00:00Z") },
    { start: Date.parse("2026-10-10T00:00:00Z"), end: Date.parse("2026-10-12T00:00:00Z") },
  ]);
  assert.deepEqual(weekendRanges(Date.parse("2026-10-05T00:00:00Z"), Date.parse("2026-10-07T00:00:00Z")), []);
  assert.deepEqual(weekendRanges(start, start), []);
  const saturday = Date.parse("2026-10-03T12:00:00Z");
  assert.deepEqual(weekendRanges(saturday, saturday), []);
});
test("weekend shading clips boundary weekends and stays UTC across DST and month changes", () => {
  assert.deepEqual(weekendRanges(Date.parse("2026-10-04T12:00:00Z"), Date.parse("2026-10-05T06:00:00Z")), [
    { start: Date.parse("2026-10-04T12:00:00Z"), end: Date.parse("2026-10-05T00:00:00Z") },
  ]);
  assert.deepEqual(weekendRanges(Date.parse("2026-10-03T00:00:00Z"), Date.parse("2026-10-04T12:00:00Z")), [
    { start: Date.parse("2026-10-03T00:00:00Z"), end: Date.parse("2026-10-04T12:00:00Z") },
  ]);
  assert.deepEqual(weekendRanges(Date.parse("2026-10-30T00:00:00Z"), Date.parse("2026-11-03T00:00:00Z")), [
    { start: Date.parse("2026-10-31T00:00:00Z"), end: Date.parse("2026-11-02T00:00:00Z") },
  ]);
  const dst = weekendRanges(Date.parse("2026-03-06T00:00:00Z"), Date.parse("2026-03-10T00:00:00Z"));
  assert.deepEqual(dst, [{ start: Date.parse("2026-03-07T00:00:00Z"), end: Date.parse("2026-03-09T00:00:00Z") }]);
  assert.equal(dst[0].end - dst[0].start, 48 * 3_600_000);
});
test("rolling medians add one point per measured run at its actual timestamp", () => {
  const runs = [
    { createdAt: "2026-10-05T15:00:00Z", ubuntu: 300, windows: null },
    { createdAt: "2026-10-05T16:00:00Z", ubuntu: 500, windows: 0 },
    { createdAt: "2026-10-05T17:00:00Z", ubuntu: null, windows: 600 },
    { createdAt: "2026-10-05T18:00:00Z", ubuntu: 100, windows: Infinity },
  ];
  assert.deepEqual(rollingMedianSeries(runs, "ubuntu"), [
    { time: Date.parse(runs[0].createdAt), value: 300 },
    { time: Date.parse(runs[1].createdAt), value: 400 },
    { time: Date.parse(runs[3].createdAt), value: 300 },
  ]);
  assert.deepEqual(rollingMedianSeries(runs, "windows"), [
    { time: Date.parse(runs[1].createdAt), value: 0 },
    { time: Date.parse(runs[2].createdAt), value: 300 },
  ]);
  assert.deepEqual(rollingMedianSeries([], "ubuntu"), []);
  assert.deepEqual(rollingMedianSeries([{ createdAt: runs[0].createdAt, ubuntu: null }], "ubuntu"), []);
});
test("rolling medians use only the latest seven valid runs in chronological order", () => {
  const runs = Array.from({ length: 9 }, (_, index) => ({
    createdAt: `2026-10-05T${String(index).padStart(2, "0")}:00:00Z`,
    ubuntu: index < 4 ? 100 : 20,
  })).toReversed();
  const original = structuredClone(runs);
  const points = rollingMedianSeries(runs, "ubuntu");
  assert.deepEqual(points.map((point) => point.value), [100, 100, 100, 100, 100, 100, 100, 20, 20]);
  assert.equal(points[0].time, Date.parse("2026-10-05T00:00:00Z"));
  assert.deepEqual(runs, original);
});
test("rolling medians restart exactly at each merge without inventing a merge-time sample", () => {
  const annotations = [
    { time: "2026-10-05T16:19:35Z" },
    { time: "2026-10-01T18:40:19Z" },
    { time: "2026-10-02T15:55:21Z" },
  ];
  const samples = [
    ["2026-10-01T18:40:18Z", 100],
    ["2026-10-01T18:40:19Z", 200],
    ["2026-10-02T15:55:20Z", 220],
    ["2026-10-02T15:55:21Z", 180],
    ["2026-10-05T16:19:34Z", 200],
    ["2026-10-05T16:19:38Z", 120],
    ["2026-10-05T16:50:41Z", 100],
  ];
  const runs = samples.map(([createdAt, ubuntu]) => ({ createdAt, ubuntu }));
  const points = rollingMedianSeries(runs, "ubuntu", annotations);
  assert.deepEqual(points.map((point) => point.value), [100, 200, 210, 180, 190, 120, 110]);
  assert.deepEqual(points.map((point) => point.time), samples.map(([time]) => Date.parse(time)));
  assert.deepEqual(rollingMedianSeries(runs.slice(0, 5), "ubuntu", annotations), points.slice(0, 5));
});
test("merge boundaries between measurements still restart each OS independently", () => {
  const runs = [
    { createdAt: "2026-10-05T12:00:00Z", ubuntu: 100, windows: 200 },
    { createdAt: "2026-10-05T17:00:00Z", ubuntu: null, windows: null },
    { createdAt: "2026-10-06T12:00:00Z", ubuntu: 80, windows: null },
    { createdAt: "2026-10-06T13:00:00Z", ubuntu: 60, windows: 120 },
  ];
  const annotations = [{ time: "2026-10-05T16:00:00Z" }, { time: "2026-10-05T18:00:00Z" }];
  assert.deepEqual(rollingMedianSeries(runs, "ubuntu", annotations).map((point) => point.value), [100, 80, 70]);
  assert.deepEqual(rollingMedianSeries(runs, "windows", annotations).map((point) => point.value), [200, 120]);
});
test("merge comparison uses nearest before and first after, at most seven each", () => {
  const runs = Array.from({ length: 10 }, (_, index) => ({ createdAt: `2026-09-21T${String(index).padStart(2, "0")}:00:00Z`, ubuntu: 100 }));
  runs.push({ createdAt: "2026-09-22T13:00:00Z", ubuntu: 80 });
  const result = comparison(runs, "ubuntu", milestones[0]);
  assert.equal(result.before, 7);
  assert.equal(result.after, 1);
  assert.ok(Math.abs(result.reduction - 20) < 1e-9);
});
test("selected milestone changes the comparison and includes the exact merge boundary", () => {
  const runs = [
    { createdAt: "2026-09-21T00:00:00Z", ubuntu: 100 },
    { createdAt: "2026-09-23T00:00:00Z", ubuntu: 90 },
    { createdAt: "2026-10-02T15:55:20Z", ubuntu: 80 },
    { createdAt: "2026-10-02T15:55:21Z", ubuntu: 60 },
    { createdAt: "2026-10-03T00:00:00Z", ubuntu: null },
  ];
  const old = comparison(runs, "ubuntu", milestones[0]);
  assert.equal(old.baseline, 100);
  assert.equal(old.current, 80);
  assert.equal(old.before, 1);
  assert.equal(old.after, 3);
  const latest = comparison(runs, "ubuntu", milestones[1]);
  assert.equal(latest.baseline, 90);
  assert.equal(latest.current, 60);
  assert.equal(latest.before, 3);
  assert.equal(latest.after, 1);
  const missing = comparison(runs.slice(0, 3), "ubuntu", milestones[1]);
  assert.equal(missing.current, null);
  assert.equal(missing.reduction, null);
});
test("comparison limits the after sample to the first seven valid runs", () => {
  const runs = [
    { createdAt: "2026-10-02T15:00:00Z", ubuntu: 100 },
    ...Array.from({ length: 10 }, (_, index) => ({
      createdAt: `2026-10-03T${String(index).padStart(2, "0")}:00:00Z`,
      ubuntu: index < 7 ? 80 : 200,
    })),
  ];
  assert.equal(comparison(runs, "ubuntu", milestones[1]).current, 80);
  assert.equal(comparison(runs, "ubuntu", milestones[1]).after, 7);
});
