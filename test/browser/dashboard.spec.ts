import { expect, test } from "@playwright/test";

const now = new Date();
const createdAt = new Date(now.getTime() - 3_600_000).toISOString();
const jobs = (ref = "default", conclusion = "success") =>
  ["ubuntu", "windows"].flatMap((os) => [0, 1, 2].map((shard) => ({
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
  await page.goto("/");
  await expect(page.locator("#run-count")).toHaveText("1");
  await expect(page.locator("#linux-median")).toHaveText("30m 00s");
  await expect(page.locator("#chart circle")).toHaveCount(2);
  await page.locator("#runs summary").click();
  await expect(page.locator("#runs tbody tr")).toHaveCount(6);
  await page.selectOption("#metric", "validation");
  await expect(page.locator("#linux-median")).toHaveText("80m 00s");
  await expect(page).toHaveURL(/metric=validation/);
  await page.selectOption("#cohort", "schedule");
  await expect(page.locator("#run-count")).toHaveText("1");
  await page.selectOption("#cohort", "next");
  await expect(page.locator("#run-count")).toHaveText("0");
  await expect(page.locator("#comparison-panel")).toBeHidden();
  await page.selectOption("#outcome", "all");
  await expect(page.locator("#run-count")).toHaveText("1");
  await page.reload();
  await expect(page.locator("#cohort")).toHaveValue("next");
  await expect(page.locator("#run-count")).toHaveText("1");
  expect(errors).toEqual([]);
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
