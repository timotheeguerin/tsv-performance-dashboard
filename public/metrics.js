export const milestone = {
  time: "2026-09-22T12:01:03Z",
  label: "Direct CLI launches",
  url: "https://github.com/Azure/azure-rest-api-specs/pull/46521",
};

export const metrics = {
  elapsed: {
    label: "Completion time",
    description: "First job start to last job finish for each OS on main. Includes setup and cleanup; excludes queue time.",
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

export function mainJobs(run) {
  return run.event === "push" && run.branch === "main" ? run.jobs.filter((job) => job.ref === "default") : [];
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

export function selectRuns(runs, { days, outcome, metric }, now = Date.now()) {
  const cutoff = days === "all" ? -Infinity : now - Number(days) * 86_400_000;
  return runs.filter((run) => Date.parse(run.createdAt) >= cutoff && run.status === "completed")
    .map((run) => {
      const jobs = mainJobs(run);
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

export function perSpec(seconds, count) {
  return Number.isFinite(seconds) && Number.isInteger(count) && count > 0 ? seconds / count : null;
}

export function specDuration(value) {
  if (!Number.isFinite(value)) return "\u2014";
  return value < 60 ? `${value.toFixed(1)}s` : duration(value);
}

export function selectRegularRuns(runs, { days, outcome, workload }, now = Date.now()) {
  const cutoff = days === "all" ? -Infinity : now - Number(days) * 86_400_000;
  return runs.filter((run) => run.event === "pull_request" && run.baseBranch === "main" &&
    Date.parse(run.createdAt) >= cutoff && run.status === "completed" &&
    run.jobs.length === 1 && run.jobs[0].status === "completed")
    .map((run) => {
      const job = run.jobs[0];
      const specCount = run.specs.status === "available" ? run.specs.validated : null;
      return {
        ...run, selectedConclusion: job.conclusion,
        validation: job.validation, specCount,
        validationPerSpec: perSpec(job.validation, specCount),
      };
    })
    .filter((run) => (outcome === "all" || run.selectedConclusion === "success") &&
      (workload === "all" || (workload === "with-specs" ? run.specCount > 0 : run.specCount === 0)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function averagePerSpec(runs, key) {
  const valid = runs.filter((run) => run.specCount > 0 && Number.isFinite(run[key]));
  const specs = valid.reduce((sum, run) => sum + run.specCount, 0);
  return specs > 0 ? valid.reduce((sum, run) => sum + run[key], 0) / specs : null;
}
