import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { api, graphql, listJobs, repository, request, runInfo, seconds, stepSeconds, type ApiJob, type ApiRun } from "./github.ts";

const workflow = "typespec-validation.yaml";
const output = fileURLToPath(new URL("../public/data/regular.json", import.meta.url));
const day = 86_400_000;
type PullRequest = { number: number; baseRefName: string; headRefName: string; createdAt?: string; closedAt?: string | null };
type Counts = {
  validated: number | null;
  selected: number | null;
  status: "available" | "pending" | "validation-not-run" | "logs-unavailable" | "unrecognized-log";
};

export function parseSpecCounts(text: string): Counts {
  const log = stripVTControlCharacters(text).replace(/^\uFEFF/, "");
  const selected = [...log.matchAll(/^\d{4}-[^\n]+Z Checking (\d+) TypeSpec folders:\s*$/gm)];
  const projects = new Set([...log.matchAll(/^\d{4}-[^\n]+Z Running TypeSpecValidation on folder:\s+([^\n]+)$/gm)].map((match) => match[1].trim().replaceAll("\\", "/")));
  if (selected.length !== 1 || projects.size > Number(selected[0][1])) {
    return { validated: null, selected: null, status: "unrecognized-log" };
  }
  return { validated: projects.size, selected: Number(selected[0][1]), status: "available" };
}

export function countsFromArchive(archive: Uint8Array): Counts {
  const files = unzipSync(archive, { filter: (file) => /^\d+_TypeSpec Validation\.txt$/.test(file.name) });
  const logs = Object.values(files);
  if (logs.length !== 1) return { validated: null, selected: null, status: "unrecognized-log" };
  return parseSpecCounts(strFromU8(logs[0]));
}

export function baseForRun(run: ApiRun, associated: PullRequest[] = []) {
  let candidates = associated.filter((pull) => pull.headRefName === run.head_branch);
  const atRunTime = candidates.filter((pull) =>
    (!pull.createdAt || pull.createdAt <= run.created_at) && (!pull.closedAt || pull.closedAt >= run.created_at));
  if (atRunTime.length) candidates = atRunTime;
  const pulls = run.pull_requests?.length
    ? run.pull_requests.map((pull) => ({ number: pull.number, baseRefName: pull.base.ref }))
    : candidates;
  const branches = new Set(pulls.map((pull) => pull.baseRefName));
  return { branch: branches.size === 1 ? [...branches][0] : null, numbers: pulls.map((pull) => pull.number) };
}

export function summarizeRegular(run: ApiRun, jobs: ApiJob[], pulls: number[], specs: Counts) {
  const relevant = jobs.filter((job) => job.name === "TypeSpec Validation");
  if (relevant.length > 1) throw new Error(`Multiple regular TSV jobs for run ${run.id}`);
  return {
    ...runInfo(run),
    baseBranch: "main",
    pullRequests: pulls,
    specs,
    jobs: relevant.map((job) => ({
      id: job.id, url: job.html_url, status: job.status, conclusion: job.conclusion,
      startedAt: job.started_at, completedAt: job.completed_at,
      elapsed: seconds(job.started_at, job.completed_at),
      validation: stepSeconds(job, "Validate Impacted Specs"),
      setup: stepSeconds(job, "Setup Node and install deps"),
    })),
  };
}

type Run = ReturnType<typeof summarizeRegular>;
type Exclusion = { id: number; createdAt: string; reason: string };
type Dataset = {
  schemaVersion: number; repository: string; workflow: string;
  generatedAt: string; historyStart: string; runs: Run[]; exclusions: Exclusion[];
};
type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean } };
type CheckStep = { name: string; status: string; conclusion: string | null; startedAt: string | null; completedAt: string | null };
type CheckRun = CheckStep & { detailsUrl: string; steps: Connection<CheckStep> };

export function checkRunToJob(check: CheckRun, runId: number): ApiJob {
  const match = new RegExp(`/actions/runs/${runId}/job/(\\d+)$`).exec(check.detailsUrl);
  if (!match || check.steps.pageInfo.hasNextPage) throw new Error(`Unexpected check metadata for run ${runId}`);
  const step = (value: CheckStep) => ({
    name: value.name, status: value.status.toLowerCase(), conclusion: value.conclusion?.toLowerCase() ?? null,
    started_at: value.startedAt, completed_at: value.completedAt,
  });
  return { ...step(check), id: Number(match[1]), html_url: check.detailsUrl, steps: check.steps.nodes.map(step) };
}

async function resolveBases(runs: ApiRun[]) {
  const resolved = new Map(runs.filter((run) => run.pull_requests?.length).map((run) => [run.id, baseForRun(run)]));
  const heads = new Map<string, ApiRun[]>();
  for (const run of runs) {
    if (resolved.has(run.id) || !run.head_repository) continue;
    const key = `${run.head_repository.full_name}:${run.head_branch}`;
    if (!heads.has(key)) heads.set(key, []);
    heads.get(key)!.push(run);
  }
  const groups = [...heads.values()];
  for (let offset = 0; offset < groups.length; offset += 4) {
    await Promise.all(groups.slice(offset, offset + 4).map(async (group) => {
      const first = group[0];
      const repo = first.head_repository!.full_name;
      const candidates: PullRequest[] = [];
      for (let page = 1; ; page++) {
        const query = new URLSearchParams({ state: "all", head: `${repo.split("/")[0]}:${first.head_branch}`, per_page: "100", page: String(page) });
        const pulls = await api<{ number: number; base: { ref: string }; head: { ref: string; repo: { full_name: string } | null }; created_at: string; closed_at: string | null }[]>(`pulls?${query}`);
        for (const pull of pulls) {
          if (pull.head.repo && pull.head.repo.full_name.toLowerCase() !== repo.toLowerCase()) continue;
          candidates.push({ number: pull.number, baseRefName: pull.base.ref, headRefName: pull.head.ref, createdAt: pull.created_at, closedAt: pull.closed_at });
        }
        if (pulls.length < 100) break;
      }
      for (const run of group) {
        const base = baseForRun(run, candidates);
        if (base.branch) resolved.set(run.id, base);
      }
    }));
    if (offset % 40 === 0) console.log(`Regular TSV: looked up ${Math.min(offset + 4, groups.length)}/${groups.length} fork branches.`);
  }
  const bySha = new Map<string, PullRequest[]>();
  const shas = [...new Set(runs.filter((run) => !resolved.has(run.id)).map((run) => run.head_sha))];
  for (let offset = 0; offset < shas.length; offset += 40) {
    const chunk = shas.slice(offset, offset + 40);
    const variables = Object.fromEntries(chunk.map((sha, index) => [`s${index}`, sha]));
    const fields = chunk.map((_, index) => `r${index}: object(expression: $s${index}) { ...on Commit { associatedPullRequests(first: 30) { nodes { number baseRefName headRefName } pageInfo { hasNextPage } } } }`).join("\n");
    const data = await graphql<{ repository: Record<string, { associatedPullRequests: Connection<PullRequest> } | null> }>(
      `query(${chunk.map((_, index) => `$s${index}: String!`).join(",")}) { repository(owner: "Azure", name: "azure-rest-api-specs") { ${fields} } }`, variables,
    );
    chunk.forEach((sha, index) => {
      const result = data.repository[`r${index}`]?.associatedPullRequests;
      if (result?.pageInfo.hasNextPage) throw new Error(`Too many associated PRs for ${sha}; cannot safely determine the target branch.`);
      bySha.set(sha, result?.nodes ?? []);
    });
    console.log(`Regular TSV: resolved PR associations for ${Math.min(offset + 40, shas.length)}/${shas.length} commits.`);
  }
  return new Map(runs.map((run) => [run.id, resolved.get(run.id) ?? baseForRun(run, bySha.get(run.head_sha))]));
}

async function batchJobs(runs: ApiRun[]) {
  const result = new Map<number, ApiJob[]>();
  const batchable = runs.filter((run) => run.run_attempt === 1 && run.check_suite_node_id);
  for (let offset = 0; offset < batchable.length; offset += 60) {
    await Promise.all([0, 20, 40].map(async (index) => {
      const chunk = batchable.slice(offset + index, offset + index + 20);
      if (!chunk.length) return;
      const data = await graphql<{ nodes: ({ id: string; checkRuns: Connection<CheckRun> } | null)[] }>(
        `query($ids: [ID!]!) { nodes(ids: $ids) { ...on CheckSuite { id checkRuns(first: 1) { nodes { name detailsUrl startedAt completedAt status conclusion steps(first: 15) { nodes { name status conclusion startedAt completedAt } pageInfo { hasNextPage } } } pageInfo { hasNextPage } } } } }`,
        { ids: chunk.map((run) => run.check_suite_node_id) },
      );
      data.nodes.forEach((suite, index) => {
        if (suite && !suite.checkRuns.pageInfo.hasNextPage && suite.checkRuns.nodes.every((check) => !check.steps.pageInfo.hasNextPage)) {
          result.set(chunk[index].id, suite.checkRuns.nodes.filter((check) => check.name === "TypeSpec Validation").map((check) => checkRunToJob(check, chunk[index].id)));
        }
      });
    }));
    console.log(`Regular TSV: fetched batched job metadata for ${Math.min(offset + 60, batchable.length)}/${batchable.length} runs.`);
  }
  for (const run of runs) {
    if (!result.has(run.id)) result.set(run.id, await listJobs(run));
  }
  return result;
}

async function specCounts(run: ApiRun, jobs: ApiJob[]): Promise<Counts> {
  const empty = { validated: null, selected: null };
  if (run.status !== "completed") return { ...empty, status: "pending" };
  const step = jobs.find((job) => job.name === "TypeSpec Validation")?.steps.find((step) => step.name === "Validate Impacted Specs");
  if (!step || step.conclusion === "skipped" || !step.started_at) return { ...empty, status: "validation-not-run" };
  const response = await request(`repos/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/logs`);
  if (response.status === 404 || response.status === 410) {
    console.warn(`Log archive unavailable (${response.status}) for regular TSV run ${run.id}.`);
    await response.body?.cancel();
    return { ...empty, status: "logs-unavailable" };
  }
  if (!response.ok) throw new Error(`Log download for ${run.id}: HTTP ${response.status}: ${await response.text()}`);
  const counts = countsFromArchive(new Uint8Array(await response.arrayBuffer()));
  if (counts.status !== "available") console.warn(`Project count unavailable for regular TSV run ${run.id}: ${counts.status}`);
  return counts;
}

async function readPrevious(): Promise<Dataset | null> {
  try {
    const data: Dataset = JSON.parse(await readFile(output, "utf8"));
    if (data.schemaVersion !== 1 || data.workflow !== workflow) throw new Error("Unsupported regular TSV dataset.");
    return data;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export async function collectRegular(days: number | null, now: Date) {
  const previous = await readPrevious();
  const since = days !== null || !previous
    ? new Date(now.getTime() - (days ?? 30) * day)
    : new Date(Date.parse(previous.generatedAt) - 2 * day);
  since.setUTCHours(0, 0, 0, 0);
  const saved = new Map(previous?.runs.map((run) => [run.id, run]));
  const exclusions = new Map(previous?.exclusions.map((run) => [run.id, run]));
  const discovered = new Map<number, ApiRun>();
  for (let start = since.getTime(); start < now.getTime(); start += day) {
    const end = Math.min(start + day - 1000, now.getTime());
    const range = `${new Date(start).toISOString().replace(".000Z", "Z")}..${new Date(end).toISOString().replace(/\.\d{3}Z$/, "Z")}`;
    for (let page = 1; ; page++) {
      const query = new URLSearchParams({ event: "pull_request", created: range, per_page: "100", page: String(page) });
      const response = await api<{ total_count: number; workflow_runs: ApiRun[] }>(`actions/workflows/${workflow}/runs?${query}`);
      if (response.total_count > 1000) throw new Error(`Regular TSV daily search exceeds GitHub's 1,000-run limit: ${range}`);
      for (const run of response.workflow_runs) discovered.set(run.id, run);
      if (response.workflow_runs.length < 100) break;
    }
  }
  for (const run of saved.values()) {
    if (run.status !== "completed" && !discovered.has(run.id)) discovered.set(run.id, await api<ApiRun>(`actions/runs/${run.id}`));
  }
  const changed = [...discovered.values()].filter((run) => {
    const old = saved.get(run.id);
    return !old || old.status !== "completed" || old.attempt !== run.run_attempt || old.updatedAt !== run.updated_at ||
      ["pending", "logs-unavailable", "unrecognized-log"].includes(old.specs.status);
  });
  console.log(`Regular TSV: ${discovered.size} discovered; resolving ${changed.length} new/updated runs.`);
  const bases = await resolveBases(changed);
  const main = changed.filter((run) => {
    const base = bases.get(run.id)!;
    if (base.branch === "main") { exclusions.delete(run.id); return true; }
    const reason = base.branch ? `base:${base.branch}` : "base-unresolved";
    if (!base.branch) console.warn(`Excluding run ${run.id}: PR target branch could not be confirmed.`);
    exclusions.set(run.id, { id: run.id, createdAt: run.created_at, reason });
    saved.delete(run.id);
    return false;
  });
  console.log(`Regular TSV: fetching timings for ${main.length} confirmed main-targeted runs.`);
  const jobs = await batchJobs(main);
  let completed = 0;
  // Bound concurrent archive downloads; large core-change PRs validate the entire repository.
  for (let offset = 0; offset < main.length; offset += 8) {
    await Promise.all(main.slice(offset, offset + 8).map(async (run) => {
      const runJobs = jobs.get(run.id)!;
      const counts = await specCounts(run, runJobs);
      saved.set(run.id, summarizeRegular(run, runJobs, bases.get(run.id)!.numbers, counts));
      completed++;
      if (completed % 100 === 0) console.log(`Regular TSV: collected ${completed}/${main.length} runs.`);
    }));
  }
  const dataset: Dataset = {
    schemaVersion: 1, repository, workflow, generatedAt: now.toISOString(),
    historyStart: previous && previous.historyStart < since.toISOString() ? previous.historyStart : since.toISOString(),
    runs: [...saved.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    exclusions: [...exclusions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(`${output}.tmp`, `${JSON.stringify(dataset)}\n`);
  await rename(`${output}.tmp`, output);
  console.log(`Saved ${dataset.runs.length} regular TSV runs.`);
}
