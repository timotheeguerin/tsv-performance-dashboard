import { expect, test } from "@playwright/test";

const now = new Date().toISOString();
const base = {
  id: 1, attempt: 1, title: "A spec change", url: "https://github.com/Azure/azure-rest-api-specs/actions/runs/1",
  event: "pull_request", branch: "feature", baseBranch: "main", pullRequests: [1], sha: "abc123456", createdAt: now,
  status: "completed", conclusion: "success",
  jobs: [{ status: "completed", conclusion: "success", elapsed: 180, validation: 60, setup: 90 }],
  specs: { status: "available", selected: 2, validated: 2 },
};
const fixture = {
  schemaVersion: 1, generatedAt: now, historyStart: now,
  runs: [
    base,
    { ...base, id: 2, jobs: [{ ...base.jobs[0], elapsed: 600, validation: 180 }], specs: { ...base.specs, selected: 4, validated: 4 } },
    { ...base, id: 3, jobs: [{ ...base.jobs[0], elapsed: 120, validation: 5 }], specs: { ...base.specs, selected: 0, validated: 0 } },
    { ...base, id: 4, jobs: [{ ...base.jobs[0], elapsed: 300 }], specs: { status: "logs-unavailable", selected: null, validated: null } },
    { ...base, id: 5, baseBranch: "typespec-next" },
  ],
};

test("regular dashboard shows total, both averages, and actual validated specs", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/data/regular.json", (route) => route.fulfill({ json: fixture }));
  await page.goto("/regular.html");
  await expect(page.locator("#run-count")).toHaveText("4 runs in view");
  await expect(page.locator("#total-median")).toHaveText("4m 00s");
  await expect(page.locator("#validation-average")).toHaveText("40.0s");
  await expect(page.locator("#total-average")).toHaveText("2m 10s");
  await expect(page.locator("#spec-count")).toHaveText("6");
  await expect(page.locator("#count-notice")).toContainText("1 run has unavailable");
  await expect(page.locator("#total-chart circle")).toHaveCount(8);
  await expect(page.locator("#average-chart circle")).toHaveCount(4);
  await expect(page.locator("#count-chart circle")).toHaveCount(3);
  await page.selectOption("#workload", "zero");
  await expect(page.locator("#run-count")).toHaveText("1 run in view");
  await expect(page.locator("#validation-average")).toHaveText("\u2014");
  await expect(page.locator("#average-chart")).toContainText("No complete measurements");
  await expect(page.locator("#count-chart circle")).toHaveCount(1);
  await page.reload();
  await expect(page.locator("#workload")).toHaveValue("zero");
  await page.selectOption("#workload", "with-specs");
  await expect(page.locator("#run-count")).toHaveText("2 runs in view");
  await page.locator("#runs summary").first().click();
  await expect(page.locator("#runs details").first().locator("table")).toContainText("Validation / spec");
  expect(errors).toEqual([]);
});

test("regular mobile layout and navigation to main-only TSV-All", async ({ page }) => {
  await page.route("**/data/regular.json", (route) => route.fulfill({ json: fixture }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/regular.html");
  await expect(page.locator("#total-chart svg")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole("navigation", { name: "Dashboards" }).getByRole("link", { name: "TSV-All", exact: true })).toHaveAttribute("href", "./index.html");
});

test("archived regular history renders all three charts", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/regular.html");
  await expect(page.locator(".chart svg")).toHaveCount(3);
  await expect(page.locator("#spec-count")).not.toHaveText("--");
  await page.screenshot({ path: testInfo.outputPath("regular-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("regular-mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});
