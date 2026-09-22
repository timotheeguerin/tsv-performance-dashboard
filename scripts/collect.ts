import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { api, listJobs, repository, runInfo, seconds, stepSeconds, type ApiJob, type ApiRun } from "./github.ts";
import { collectRegular } from "./collect-regular.ts";

export { seconds } from "./github.ts";

const workflow = "typespec-validation-all.yaml";
const output = fileURLToPath(new URL("../public/data/workflow.json", import.meta.url));
const day = 86_400_000;

export function summarizeJob(job: ApiJob) {
  const matrix = /^TSV \((default|next), (ubuntu|windows), (\d+), (\d+)\)$/.exec(job.name);
  if (!matrix) throw new Error(`Unrecognized TSV matrix job: ${job.name} (${job.id})`);
  return {
    id: job.id,
    url: job.html_url,
    ref: matrix[1],
    os: matrix[2],
    shard: Number(matrix[3]),
    totalShards: Number(matrix[4]),
    status: job.status,
    conclusion: job.conclusion,
    startedAt: job.started_at,
    completedAt: job.completed_at,
    elapsed: seconds(job.started_at, job.completed_at),
    validation: stepSeconds(job, "Validate All Specs"),
    setup: stepSeconds(job, "Setup Node and install deps"),
  };
}

type Run = ReturnType<typeof summarizeRun>;
type Dataset = {
  schemaVersion: number;
  repository: string;
  workflow: string;
  generatedAt: string;
  historyStart: string;
  runs: Run[];
};

export function summarizeRun(run: ApiRun, jobs: ApiJob[]) {
  return {
    ...runInfo(run),
    jobs: jobs.map(summarizeJob),
  };
}

export function needsRefresh(previous: Run | undefined, run: ApiRun) {
  return !previous || previous.status !== "completed" ||
    previous.attempt !== run.run_attempt || previous.updatedAt !== run.updated_at;
}

export function parseDays(args: string[]) {
  if (args.length === 0) return null;
  if (args.length !== 2 || args[0] !== "--days" || !/^[1-9]\d*$/.test(args[1])) {
    throw new Error("Usage: node scripts/collect.ts [--days <positive integer>]");
  }
  return Number(args[1]);
}

export function dateWindows(start: Date, end: Date) {
  const windows: { start: string; end: string }[] = [];
  for (let time = start.getTime(); time < end.getTime(); time += day) {
    windows.push({
      start: new Date(time).toISOString().replace(".000Z", "Z"),
      end: new Date(Math.min(time + day - 1000, end.getTime())).toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
  }
  return windows;
}

async function listRuns(start: string, end: string) {
  const runs: ApiRun[] = [];
  for (const event of ["push"]) {
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({
        event, branch: "main", created: `${start}..${end}`, per_page: "100", page: String(page),
      });
      const result = await api<{ total_count: number; workflow_runs: ApiRun[] }>(
        `actions/workflows/${workflow}/runs?${query}`,
      );
      if (result.total_count > 1000) {
        throw new Error(`GitHub's 1,000-run search limit was exceeded for ${event}, ${start}..${end}.`);
      }
      runs.push(...result.workflow_runs);
      if (result.workflow_runs.length < 100) break;
    }
  }
  return runs;
}

async function readPrevious(): Promise<Dataset | null> {
  try {
    const data: Dataset = JSON.parse(await readFile(output, "utf8"));
    if (data.schemaVersion !== 1) throw new Error(`Unsupported data schema: ${data.schemaVersion}`);
    return data;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function main() {
  const days = parseDays(process.argv.slice(2));
  const previous = await readPrevious();
  const now = new Date();
  const since = days !== null || !previous
    ? new Date(now.getTime() - (days ?? 30) * day)
    : new Date(Date.parse(previous.generatedAt) - 2 * day);
  since.setUTCHours(0, 0, 0, 0);
  const saved = new Map(previous?.runs.filter((run) => run.event === "push" && run.branch === "main").map((run) => [run.id, run]));
  const discovered = new Map<number, ApiRun>();
  for (const window of dateWindows(since, now)) {
    const runs = await listRuns(window.start, window.end);
    for (const run of runs) discovered.set(run.id, run);
    console.log(`${window.start.slice(0, 10)}: ${runs.length} TSV-All main pushes`);
  }
  // Pending runs can outlive the discovery lookback.
  for (const run of saved.values()) {
    if (run.status !== "completed" && !discovered.has(run.id)) {
      discovered.set(run.id, await api<ApiRun>(`actions/runs/${run.id}`));
    }
  }
  let refreshed = 0;
  for (const run of discovered.values()) {
    if (!needsRefresh(saved.get(run.id), run)) continue;
    const jobs = run.status === "queued" ? [] : await listJobs(run);
    saved.set(run.id, summarizeRun(run, jobs));
    refreshed++;
    if (refreshed % 25 === 0) console.log(`Fetched job timings for ${refreshed} runs`);
  }
  const dataset: Dataset = {
    schemaVersion: 1,
    repository,
    workflow,
    generatedAt: now.toISOString(),
    historyStart: previous && previous.historyStart < since.toISOString() ? previous.historyStart : since.toISOString(),
    runs: [...saved.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, `${JSON.stringify(dataset)}\n`);
  await rename(`${output}.tmp`, output);
  console.log(`Saved ${dataset.runs.length} runs; refreshed ${refreshed}.`);
  await collectRegular(days, now);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
