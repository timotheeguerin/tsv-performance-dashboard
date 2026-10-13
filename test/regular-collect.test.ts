import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import { baseForRun, checkRunToJob, countsFromArchive, needsCountRepair, parseSpecCounts, summarizeRegular } from "../scripts/collect-regular.ts";

const timestamp = "2026-09-22T12:00:00.123Z";
const log = (lines: string[]) => lines.map((line) => `${timestamp} ${line}`).join("\n");
const run = {
  id: 123, run_attempt: 1, display_title: "Test", html_url: "https://github.com/Azure/azure-rest-api-specs/actions/runs/123",
  event: "pull_request", head_branch: "feature", head_sha: "abc", created_at: timestamp, run_started_at: timestamp,
  updated_at: timestamp, status: "completed", conclusion: "success",
};

test("count validated projects, excluding suppressed projects and duplicate output", () => {
  assert.deepEqual(parseSpecCounts(log([
    "Checking 3 TypeSpec folders:",
    "##[group]Validating specification/a",
    "Running TypeSpecValidation on folder:  /repo/specification/a",
    "Running TypeSpecValidation on folder:  /repo/specification/a",
    "##[group]Validating specification/b",
    "Suppressed: temporarily disabled",
    "##[group]Validating specification/c",
    "Running TypeSpecValidation on folder:  /repo/specification/c",
  ])), { validated: 2, selected: 3, status: "available" });
});
test("intermediate Validating groups exclude whole-project suppression, not suppressed rules", () => {
  assert.deepEqual(parseSpecCounts(log([
    "Checking 3 TypeSpec folders:",
    "##[group]Validating specification/a",
    "10 passed | 2 skipped",
    "##[endgroup]",
    "##[group]Validating specification/b",
    "Suppressed: whole project",
    "##[endgroup]",
    "::group::Validating specification/c",
    "  Suppressed: one rule",
    "9 passed | 1 suppressed",
    "::endgroup::",
  ])), { validated: 2, selected: 3, status: "available" });
});
test("zero selected or entirely suppressed workloads are known zeroes", () => {
  assert.equal(parseSpecCounts(log(["Checking 0 TypeSpec folders:"])).validated, 0);
  assert.equal(parseSpecCounts(log(["Checking 2 TypeSpec folders:", "Suppressed: reason a", "Suppressed: reason b"])).validated, 0);
  assert.deepEqual(parseSpecCounts(log(["No impacted TypeSpec projects found"])), {
    validated: 0, selected: 0, status: "available",
  });
});
test("current colored result groups count validated projects, not rules or suppressions", () => {
  assert.deepEqual(parseSpecCounts(log([
    "Checking 3 TypeSpec folders:",
    "##[group]\u001b[32mpass\u001b[39m specification/a",
    "Running TypeSpecValidation on folder: /repo/specification/a",
    "10 passed | 2 skipped",
    "##[group]pass specification/a",
    "::group::fail specification/b",
    "##[group]skip specification/c",
    "Suppressed: disabled",
    "2 passed | 1 suppressed",
  ])), { validated: 2, selected: 3, status: "available" });
  assert.deepEqual(parseSpecCounts(log([
    "Checking 2 TypeSpec folders:", "##[group]skip specification/a", "##[group]skip specification/b",
  ])), { validated: 0, selected: 2, status: "available" });
});
test("missing, contradictory, or changed log formats are not silently counted as zero", () => {
  for (const lines of [
    [], ["Something went wrong"],
    ["Checking 0 TypeSpec folders:", "Running TypeSpecValidation on folder: a"],
    ["Checking 1 TypeSpec folders:", "Checking 1 TypeSpec folders:"],
    ["Checking 2 TypeSpec folders:", "Unexpected new result format"],
    ["Checking 2 TypeSpec folders:", "##[group]skip specification/a"],
    ["Checking 1 TypeSpec folders:", "##[group]pass specification/a", "##[group]skip specification/a"],
    ["Checking 1 TypeSpec folders:", "##[group]pass specification/a", "##[group]fail specification/b"],
  ]) {
    assert.deepEqual(parseSpecCounts(log(lines)), { validated: null, selected: null, status: "unrecognized-log" });
  }
});
test("cached false zeroes and old unrecognized logs are repaired without invalidating valid history", () => {
  const counts = { validated: 0, selected: 8, status: "available" } as const;
  assert.equal(needsCountRepair(counts), true);
  assert.equal(needsCountRepair({ ...counts, parserVersion: 3 }), false);
  assert.equal(needsCountRepair({ ...counts, selected: 0 }), false);
  assert.equal(needsCountRepair({ ...counts, validated: 8 }), false);
  assert.equal(needsCountRepair({ validated: null, selected: null, status: "unrecognized-log" }), true);
});
test("archive uses aggregate job log once, not duplicated per-step logs", () => {
  const text = log(["Checking 1 TypeSpec folders:", "Running TypeSpecValidation on folder: a"]);
  const archive = zipSync({
    "0_TypeSpec Validation.txt": strToU8(text),
    "TypeSpec Validation/4_Validate Impacted Specs.txt": strToU8(text),
  });
  assert.equal(countsFromArchive(archive).validated, 1);
});
test("ANSI escape sequences and BOM do not change the count", () => {
  assert.equal(parseSpecCounts(`\uFEFF${log(["\u001b[32mChecking 1 TypeSpec folders:\u001b[0m", "Running TypeSpecValidation on folder: a"])}`).validated, 1);
});
test("main scope follows the PR base, not the contributor's head branch", () => {
  assert.equal(baseForRun({ ...run, pull_requests: [{ number: 1, base: { ref: "main" } }] }).branch, "main");
  assert.equal(baseForRun({ ...run, head_branch: "main", pull_requests: [{ number: 1, base: { ref: "typespec-next" } }] }).branch, "typespec-next");
  assert.deepEqual(baseForRun(run, [{ number: 1, baseRefName: "main", headRefName: "feature" }]), { branch: "main", numbers: [1] });
});
test("unknown or ambiguous fork PR targets remain excluded", () => {
  assert.equal(baseForRun(run).branch, null);
  assert.equal(baseForRun(run, [{ number: 1, baseRefName: "main", headRefName: "other" }]).branch, null);
  assert.equal(baseForRun(run, [
    { number: 1, baseRefName: "main", headRefName: "feature" },
    { number: 2, baseRefName: "typespec-next", headRefName: "feature" },
  ]).branch, null);
});
test("reused fork branches resolve using PR lifetime, without requiring a still-reachable old commit", () => {
  assert.deepEqual(baseForRun(run, [
    { number: 1, baseRefName: "main", headRefName: "feature", createdAt: "2026-09-01", closedAt: "2026-09-23" },
    { number: 2, baseRefName: "typespec-next", headRefName: "feature", createdAt: "2026-09-24", closedAt: null },
  ]), { branch: "main", numbers: [1] });
});
test("batched check metadata preserves REST timing semantics and large job IDs", () => {
  const step = { name: "Validate Impacted Specs", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-22T12:01:00Z", completedAt: "2026-09-22T12:02:00Z" };
  const job = checkRunToJob({
    ...step, name: "TypeSpec Validation", startedAt: "2026-09-22T12:00:00Z",
    detailsUrl: "https://github.com/Azure/azure-rest-api-specs/actions/runs/123/job/106801059993",
    steps: { nodes: [step], pageInfo: { hasNextPage: false } },
  }, 123);
  const result = summarizeRegular(run, [job], [1], { validated: 2, selected: 2, status: "available" });
  assert.equal(job.id, 106801059993);
  assert.equal(result.jobs[0].elapsed, 120);
  assert.equal(result.jobs[0].validation, 60);
  assert.equal(result.baseBranch, "main");
});
