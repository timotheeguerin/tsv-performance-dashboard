import assert from "node:assert/strict";
import { test } from "node:test";
import { averagePerSpec, perSpec, selectRegularRuns, specDuration } from "../public/metrics.js";
import { dailySeries } from "../public/chart.js";

const run = (overrides = {}) => ({
  event: "pull_request", branch: "contributor-feature", baseBranch: "main", status: "completed",
  createdAt: "2026-09-22T12:00:00Z",
  specs: { status: "available", validated: 2, selected: 3 },
  jobs: [{ status: "completed", conclusion: "success", elapsed: 180, validation: 60 }],
  ...overrides,
});
const options = { days: "all", outcome: "success", workload: "all" };

test("regular totals and both per-spec averages use the measured validated count", () => {
  const selected = selectRegularRuns([run()], options)[0];
  assert.equal(selected.total, 180);
  assert.equal(selected.specCount, 2);
  assert.equal(selected.totalPerSpec, 90);
  assert.equal(selected.validationPerSpec, 30);
});
test("zero or unknown specs never turn into a zero or infinite per-spec runtime", () => {
  for (const count of [0, null, undefined, -1]) assert.equal(perSpec(60, count), null);
  assert.equal(perSpec(null, 2), null);
  assert.equal(perSpec(0, 2), 0);
  const selected = selectRegularRuns([run({ specs: { status: "logs-unavailable", validated: null } })], options)[0];
  assert.equal(selected.total, 180);
  assert.equal(selected.specCount, null);
  assert.equal(selected.totalPerSpec, null);
});
test("base branch, not PR head branch, determines the main-only scope", () => {
  const runs = [run(), run({ branch: "main", baseBranch: "typespec-next" }), run({ baseBranch: null }), run({ event: "push" }), run({ jobs: [] })];
  assert.equal(selectRegularRuns(runs, options).length, 1);
});
test("workload and outcome filters distinguish zero, unknown, and failed runs", () => {
  const runs = [run(), run({ specs: { status: "available", validated: 0 } }), run({ specs: { status: "unrecognized-log", validated: null } })];
  assert.equal(selectRegularRuns(runs, { ...options, workload: "zero" }).length, 1);
  assert.equal(selectRegularRuns(runs, { ...options, workload: "with-specs" }).length, 1);
  const failed = run({ jobs: [{ status: "completed", conclusion: "failure", elapsed: 50, validation: 30 }] });
  assert.equal(selectRegularRuns([failed], options).length, 0);
  assert.equal(selectRegularRuns([failed], { ...options, outcome: "all" }).length, 1);
});
test("aggregate averages divide sums; zero-spec overhead and missing counts are excluded", () => {
  const runs = [
    { specCount: 1, validation: 10 },
    { specCount: 9, validation: 180 },
    { specCount: 0, validation: 999 },
    { specCount: null, validation: 999 },
    { specCount: 2, validation: null },
  ];
  assert.equal(averagePerSpec(runs, "validation"), 19);
  assert.equal(averagePerSpec([], "validation"), null);
});
test("daily per-spec trend uses weighted averages, not medians or averages of averages", () => {
  const points = [
    { createdAt: "2026-09-22T01:00:00Z", avg: 10, specs: 1 },
    { createdAt: "2026-09-22T02:00:00Z", avg: 20, specs: 9 },
    { createdAt: "2026-09-22T03:00:00Z", avg: null, specs: 0 },
  ];
  assert.equal(dailySeries(points, "avg", "specs")[0].value, 19);
  assert.equal(specDuration(0.45), "0.5s");
  assert.equal(specDuration(null), "\u2014");
});
