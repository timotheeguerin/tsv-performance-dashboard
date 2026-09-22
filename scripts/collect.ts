import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repository = "Azure/azure-rest-api-specs";
const workflow = "typespec-validation-all.yaml";
const output = fileURLToPath(new URL("../public/data/workflow.json", import.meta.url));
const day = 86_400_000;

type ApiStep = {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};
type ApiJob = ApiStep & { id: number; html_url: string; steps: ApiStep[] };
type ApiRun = {
  id: number;
  run_attempt: number;
  display_title: string;
  html_url: string;
  event: string;
  head_branch: string;
  head_sha: string;
  created_at: string;
  run_started_at: string;
  updated_at: string;
  status: string;
  conclusion: string | null;
};

export function seconds(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const duration = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function summarizeJob(job: ApiJob) {
  const matrix = /^TSV \((default|next), (ubuntu|windows), (\d+), (\d+)\)$/.exec(job.name);
  if (!matrix) throw new Error(`Unrecognized TSV matrix job: ${job.name} (${job.id})`);
  const stepDuration = (name: string) => {
    const step = job.steps.find((step) => step.name === name);
    return step?.status === "completed" && step.conclusion !== "skipped"
      ? seconds(step.started_at, step.completed_at)
      : null;
  };
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
    validation: stepDuration("Validate All Specs"),
    setup: stepDuration("Setup Node and install deps"),
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
    id: run.id,
    attempt: run.run_attempt,
    title: run.display_title,
    url: run.html_url,
    event: run.event,
    branch: run.head_branch,
    sha: run.head_sha,
    createdAt: run.created_at,
    startedAt: run.run_started_at,
    updatedAt: run.updated_at,
    status: run.status,
    conclusion: run.conclusion,
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

async function api<T>(path: string, attempt = 0): Promise<T> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required. Use a GitHub Actions token or `gh auth token`.");
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const delay = Math.min(Number(response.headers.get("retry-after") ?? 2 ** (attempt + 1)), 60);
      console.warn(`GitHub returned ${response.status}; retrying in ${delay}s: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, delay * 1000));
      return api<T>(path, attempt + 1);
    }
    throw new Error(`GitHub ${response.status} for ${path}: ${await response.text()}`);
  }
  return await response.json() as T;
}

async function listRuns(start: string, end: string) {
  const runs: ApiRun[] = [];
  for (const event of ["push", "schedule"]) {
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

async function listJobs(run: ApiRun) {
  const jobs: ApiJob[] = [];
  for (let page = 1; ; page++) {
    const result = await api<{ jobs: ApiJob[] }>(
      `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
    );
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) return jobs;
  }
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
  const saved = new Map(previous?.runs.map((run) => [run.id, run]));
  const discovered = new Map<number, ApiRun>();
  for (const window of dateWindows(since, now)) {
    const runs = await listRuns(window.start, window.end);
    for (const run of runs) discovered.set(run.id, run);
    console.log(`${window.start.slice(0, 10)}: ${runs.length} main push / scheduled runs`);
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
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
