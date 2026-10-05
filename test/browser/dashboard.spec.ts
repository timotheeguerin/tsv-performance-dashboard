import { expect, test } from "@playwright/test";

const now = new Date();
const createdAt = new Date(now.getTime() - 3_600_000).toISOString();
const jobs = (ref = "default", conclusion = "success") =>
  ["ubuntu", "windows"].flatMap((os) => [1, 2, 3].map((shard) => ({
    id: shard, url: "https://github.com/Azure/azure-rest-api-specs/actions/runs/1",
    ref, os, shard, totalShards: 3, status: "completed", conclusion,
    startedAt: createdAt, completedAt: new Date(Date.parse(createdAt) + 1_800_000).toISOString(),
    elapsed: 1800, validation: 1600, setup: 100,
  })));
const baseRun = {
  id: 1, attempt: 1, title: "A workflow change", url: "https://github.com/Azure/azure-rest-api-specs/actions/runs/1",
  event: "push", branch: "main", sha: "abcdef123456", createdAt,
  updatedAt: new Date(Date.parse(createdAt) + 1_810_000).toISOString(),
  status: "completed", conclusion: "success", jobs: jobs(),
};
const fixture = {
  schemaVersion: 1, generatedAt: now.toISOString(), historyStart: createdAt,
  runs: [
    baseRun,
    { ...baseRun, id: 2, event: "schedule", conclusion: "failure", jobs: [...jobs(), ...jobs("next", "failure")] },
    { ...baseRun, id: 3, event: "pull_request" },
  ],
};

test("filters, per-shard details, and URL state", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/data/workflow.json", (route) => route.fulfill({ json: fixture }));
  await page.goto("/?cohort=next");
  await expect(page.locator("#cohort")).toHaveCount(0);
  await expect(page).not.toHaveURL(/cohort=/);
  await expect(page.locator("#run-count")).toHaveText("1");
  await expect(page.locator("#linux-median")).toHaveText("80m 00s");
  await expect(page.locator("#metric")).toHaveValue("validation");
  await expect(page.locator("#comparisons section")).toHaveCount(2);
  await expect(page.locator("#chart circle")).toHaveCount(2);
  await page.locator("#runs summary").click();
  await expect(page.locator("#runs tbody tr")).toHaveCount(6);
  await page.selectOption("#metric", "elapsed");
  await expect(page.locator("#linux-median")).toHaveText("30m 00s");
  await page.selectOption("#metric", "validation");
  await expect(page.locator("#linux-median")).toHaveText("80m 00s");
  await expect(page).toHaveURL(/metric=validation/);
  await page.selectOption("#outcome", "all");
  await expect(page.locator("#run-count")).toHaveText("1");
  await page.reload();
  await expect(page.locator("#metric")).toHaveValue("validation");
  await expect(page.locator("#run-count")).toHaveText("1");
  expect(errors).toEqual([]);
});

test("chart points show their time on hover and keyboard focus without blocking run links", async ({ page }) => {
  await page.context().route(baseRun.url, (route) => route.fulfill({ body: "Workflow run" }));
  await page.route("**/data/workflow.json", (route) => route.fulfill({
    json: { ...fixture, runs: [{ ...baseRun, jobs: jobs().map((job) => job.os === "windows"
      ? { ...job, validation: 1900, completedAt: new Date(Date.parse(createdAt) + 2_100_000).toISOString() }
      : job) }] },
  }));
  await page.goto("/?metric=elapsed");
  const tooltip = page.getByRole("tooltip", { includeHidden: true });
  const linux = page.locator("#chart").getByRole("link", { name: /Linux: 30m 00s/ });
  const windows = page.locator("#chart").getByRole("link", { name: /Windows: 35m 00s/ });
  await expect(tooltip).toBeHidden();
  await linux.hover();
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveText(`Linux: 30m 00s (success)\n${createdAt.slice(0, 16).replace("T", " ")} UTC\nA workflow change`);
  await windows.hover();
  await expect(tooltip).toContainText("Windows: 35m 00s");
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();
  await linux.focus();
  await expect(tooltip).toContainText("Linux: 30m 00s");
  await page.keyboard.press("Escape");
  await expect(tooltip).toBeHidden();
  await windows.focus();
  await expect(tooltip).toContainText("Windows: 35m 00s");
  await windows.evaluate((node: SVGAElement) => node.blur());
  await expect(tooltip).toBeHidden();
  await linux.hover();
  const popup = page.waitForEvent("popup");
  await linux.click();
  await expect(await popup).toHaveURL(baseRun.url);
  await page.selectOption("#metric", "validation");
  await expect(page.getByRole("tooltip", { includeHidden: true })).toBeHidden();
  await page.locator("#chart").getByRole("link", { name: /Linux: 80m 00s/ }).hover();
  await expect(page.getByRole("tooltip")).toContainText("Linux: 80m 00s");
});

test("both milestones and their independent comparisons stay visible together", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-03T12:00:00Z"));
  const samples = [
    ["2026-09-21T00:00:00Z", 100],
    ["2026-09-23T00:00:00Z", 90],
    ["2026-10-02T15:55:20Z", 80],
    ["2026-10-02T15:55:21Z", 60],
  ] as const;
  const runs = samples.map(([time, validation], index) => ({
    ...baseRun, id: index + 1, createdAt: time,
    jobs: jobs().map((job) => ({ ...job, validation, shard: index < 2 ? job.shard - 1 : job.shard })),
  }));
  await page.route("**/data/workflow.json", (route) => route.fulfill({
    json: { ...fixture, runs: [
      ...runs,
      { ...baseRun, id: 5, createdAt: "2026-10-02T16:00:00Z", jobs: jobs("default", "failure") },
    ] },
  }));
  await page.goto("/?days=all");
  const latest = page.locator("#comparison-single-entrypoint");
  const previous = page.locator("#comparison-direct-launch");
  await expect(page.locator("#run-count")).toHaveText("4");
  await expect(page.locator("#comparisons h2")).toHaveText(["Skip redundant client compilation", "Direct CLI launches"]);
  await expect(latest.locator(".panel-heading p")).toContainText("2026-10-02 15:55 UTC");
  await expect(latest.locator(".panel-heading a")).toHaveAttribute("href", /\/pull\/46970$/);
  await expect(latest.locator(".comparison-row strong").first()).toHaveText("4m 30s \u2192 3m 00s");
  await expect(latest.locator(".comparison-row .change").first()).toHaveText("33.3% faster");
  await expect(latest.locator(".comparison-row").first()).toContainText("3 before / 1 after");
  await expect(previous.locator(".panel-heading a")).toHaveAttribute("href", /\/pull\/46521$/);
  await expect(previous.locator(".comparison-row strong").first()).toHaveText("5m 00s \u2192 4m 00s");
  await expect(page.locator("#chart .milestone-label")).toHaveText(["Direct CLI launches merged", "Skip redundant client compilation merged"]);
  await expect(page.locator("#chart line.milestone")).toHaveCount(2);
  const labels = await page.locator("#chart .milestone-label").evaluateAll((nodes) => nodes.map((node) => {
    const { top, bottom } = node.getBoundingClientRect();
    return { top, bottom };
  }));
  expect(labels[0].bottom).toBeLessThan(labels[1].top);

  await page.selectOption("#outcome", "all");
  await expect(page.locator("#run-count")).toHaveText("5");
  await expect(latest.locator(".comparison-row strong").first()).toHaveText("4m 30s \u2192 3m 00s");
  await expect(previous.locator(".comparison-row strong").first()).toHaveText("5m 00s \u2192 4m 00s");
  await page.reload();
  await expect(page.locator("#chart .milestone-label")).toHaveCount(2);
  await expect(page.locator("#comparisons section")).toHaveCount(2);
  await page.selectOption("#metric", "elapsed");
  await expect(latest.locator(".comparison-row strong").first()).toHaveText("30m 00s \u2192 30m 00s");
  await expect(previous.locator(".comparison-row strong").first()).toHaveText("30m 00s \u2192 30m 00s");
  await page.selectOption("#days", "7");
  await expect(page.locator("#chart .milestone-label")).toHaveText("Skip redundant client compilation merged");
  await expect(previous).toContainText("No runs on both sides of the merge");
  await expect(page.locator("#comparisons section")).toHaveCount(2);
});

test("existing milestone links preserve the metric without hiding either comparison", async ({ page }) => {
  await page.route("**/data/workflow.json", (route) => route.fulfill({ json: fixture }));
  await page.goto("/?metric=elapsed&milestone=single-entrypoint");
  await expect(page.locator("#metric")).toHaveValue("elapsed");
  await expect(page.locator("#linux-median")).toHaveText("30m 00s");
  await expect(page.locator("#milestone")).toHaveCount(0);
  await expect(page).not.toHaveURL(/milestone=/);
  await expect(page.locator("#comparisons section")).toHaveCount(2);
  await expect(page.locator("#comparison-direct-launch")).toContainText("No runs on both sides of the merge");
});

test("API titles render as text and mobile layout fits the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = '<img src=x onerror="alert(1)">';
  await page.route("**/data/workflow.json", (route) => route.fulfill({
    json: { ...fixture, runs: [{ ...baseRun, title }] },
  }));
  await page.goto("/");
  await expect(page.locator(".run-title")).toHaveText(title);
  await expect(page.locator(".run-title img")).toHaveCount(0);
  await page.locator("#chart a").last().hover();
  const tooltip = page.getByRole("tooltip");
  await expect(tooltip).toContainText(title);
  await expect(tooltip.locator("img")).toHaveCount(0);
  const bounds = await tooltip.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator("#runs summary").click();
  await expect(page.locator("#runs table")).toBeVisible();
});

test("data errors are visible, not an empty successful dashboard", async ({ page }) => {
  await page.route("**/data/workflow.json", (route) => route.fulfill({ status: 503, body: "Unavailable" }));
  await page.goto("/");
  await expect(page.getByRole("alert")).toContainText("HTTP 503");
});

test("archived data renders without console errors", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#chart svg")).toBeVisible();
  await expect(page.locator("#run-count")).not.toHaveText("0");
  await expect(page.locator("#linux-median")).not.toHaveText("--");
  await page.locator("#runs summary").first().click();
  await expect(page.locator("#runs details").first().locator("tbody tr")).toHaveCount(6);
  await page.locator("#runs summary").first().click();
  await page.screenshot({ path: testInfo.outputPath("desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});
