export const repository = "Azure/azure-rest-api-specs";

export type ApiStep = {
  name: string;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
};
export type ApiJob = ApiStep & { id: number; html_url: string; steps: ApiStep[] };
export type ApiRun = {
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
  check_suite_node_id?: string;
  pull_requests?: { number: number; base: { ref: string } }[];
  head_repository?: { full_name: string } | null;
};

export async function request(path: string, body?: object, attempt = 0): Promise<Response> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required. Use a GitHub Actions token or `gh auth token`.");
  const response = await fetch(`https://api.github.com/${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  if ((response.status === 429 || response.status >= 500) && attempt < 3) {
    const delay = Math.min(Number(response.headers.get("retry-after") ?? 2 ** (attempt + 1)), 60);
    await response.body?.cancel();
    console.warn(`GitHub returned ${response.status}; retrying in ${delay}s: ${path}`);
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));
    return request(path, body, attempt + 1);
  }
  return response;
}

export async function api<T>(path: string): Promise<T> {
  const response = await request(`repos/${repository}/${path}`);
  if (!response.ok) throw new Error(`GitHub ${response.status} for ${path}: ${await response.text()}`);
  return await response.json() as T;
}

export async function graphql<T>(query: string, variables: object = {}): Promise<T> {
  const response = await request("graphql", { query, variables });
  if (!response.ok) throw new Error(`GitHub GraphQL ${response.status}: ${await response.text()}`);
  const result = await response.json() as { data: T; errors?: { message: string }[] };
  if (result.errors?.length) throw new Error(`GitHub GraphQL: ${result.errors.map((error) => error.message).join("; ")}`);
  return result.data;
}

export function seconds(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const duration = (Date.parse(end) - Date.parse(start)) / 1000;
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

export function stepSeconds(job: ApiJob, name: string) {
  const step = job.steps.find((step) => step.name === name);
  return step?.status === "completed" && step.conclusion !== "skipped"
    ? seconds(step.started_at, step.completed_at)
    : null;
}

export function runInfo(run: ApiRun) {
  return {
    id: run.id, attempt: run.run_attempt, title: run.display_title, url: run.html_url,
    event: run.event, branch: run.head_branch, sha: run.head_sha,
    createdAt: run.created_at, startedAt: run.run_started_at, updatedAt: run.updated_at,
    status: run.status, conclusion: run.conclusion,
  };
}

export async function listJobs(run: ApiRun) {
  const jobs: ApiJob[] = [];
  for (let page = 1; ; page++) {
    const result = await api<{ jobs: ApiJob[] }>(
      `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
    );
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) return jobs;
  }
}
