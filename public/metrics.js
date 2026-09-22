export const milestone = {
  time: "2026-09-22T12:01:03Z",
  label: "Direct CLI launches",
  url: "https://github.com/Azure/azure-rest-api-specs/pull/46521",
};

export const metrics = {
  elapsed: {
    label: "Completion time",
    description: "First job start to last job finish for each OS and selected checkout. Includes setup and cleanup; excludes queue time.",
  },
  validation: {
    label: "Total validation work",
    description: "Sum of all Validate All Specs steps for each OS. These are aggregate execution minutes, not elapsed time or CPU time.",
  },
  slowest: {
    label: "Slowest validation shard",
    description: "Longest Validate All Specs step for each OS. Excludes setup, post-job cleanup, and queue time.",
  },
};

export function duration(seconds) {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "\u2014";
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}m ${String(rounded % 60).padStart(2, "0")}s`;
}

export function median(values) {
  if (!values.length) return null;
  const sorted = values.toSorted((a, b) => a - b);
  return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;
}

export function cohortJobs(run, cohort) {
  const event = cohort === "push" ? "push" : "schedule";
  const ref = cohort === "next" ? "next" : "default";
  return run.event === event && run.branch === "main" ? run.jobs.filter((job) => job.ref === ref) : [];
}

export function completeShards(jobs) {
  const total = jobs[0]?.totalShards;
  return Number.isInteger(total) && total > 0 && jobs.length === total &&
    jobs.every((job) => job.totalShards === total && job.status === "completed") &&
    new Set(jobs.map((job) => job.shard)).size === total &&
    jobs.every((job) => job.shard >= 0 && job.shard < total);
}

export function valueForJobs(jobs, metric) {
  if (!completeShards(jobs)) return null;
  if (metric === "elapsed") {
    if (jobs.some((job) => !job.startedAt || !job.completedAt)) return null;
    const start = Math.min(...jobs.map((job) => Date.parse(job.startedAt)));
    const end = Math.max(...jobs.map((job) => Date.parse(job.completedAt)));
    return Number.isFinite(end - start) && end >= start ? (end - start) / 1000 : null;
  }
  if (jobs.some((job) => !Number.isFinite(job.validation))) return null;
  return metric === "validation"
    ? jobs.reduce((sum, job) => sum + job.validation, 0)
    : Math.max(...jobs.map((job) => job.validation));
}

export function selectRuns(runs, { cohort, days, outcome, metric }, now = Date.now()) {
  const cutoff = days === "all" ? -Infinity : now - Number(days) * 86_400_000;
  return runs.filter((run) => Date.parse(run.createdAt) >= cutoff && run.status === "completed")
    .map((run) => {
      const jobs = cohortJobs(run, cohort);
      const complete = ["ubuntu", "windows"].every((os) => completeShards(jobs.filter((job) => job.os === os)));
      return {
        ...run,
        selectedJobs: jobs,
        selectedConclusion: !complete ? "incomplete" : jobs.every((job) => job.conclusion === "success") ? "success" : "failure",
        ubuntu: valueForJobs(jobs.filter((job) => job.os === "ubuntu"), metric),
        windows: valueForJobs(jobs.filter((job) => job.os === "windows"), metric),
      };
    })
    .filter((run) => run.selectedJobs.length && (outcome === "all" || run.selectedConclusion === "success"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function dailyMedians(runs, os) {
  const days = new Map();
  for (const run of runs) {
    if (run[os] === null) continue;
    const day = run.createdAt.slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(run[os]);
  }
  return [...days].map(([day, values]) => ({ time: Date.parse(`${day}T12:00:00Z`), value: median(values) }));
}

export function comparison(runs, os) {
  const valid = runs.filter((run) => run[os] !== null);
  const before = valid.filter((run) => run.createdAt < milestone.time).slice(-7);
  const after = valid.filter((run) => run.createdAt >= milestone.time).slice(0, 7);
  const baseline = median(before.map((run) => run[os]));
  const current = median(after.map((run) => run[os]));
  return {
    baseline, current, before: before.length, after: after.length,
    reduction: baseline > 0 && current !== null ? (1 - current / baseline) * 100 : null,
  };
}
