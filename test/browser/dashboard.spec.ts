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
  await expect(page.locator("#chart svg")).toHaveAccessibleName("Completion time by run, Linux and Windows");
  await expect(page.locator("#chart svg title")).toHaveCount(0);
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
    const { left, right } = node.getBoundingClientRect();
    return { left, right };
  }));
  expect(labels[0].right).toBeLessThan(labels[1].left);

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

test("setup regression and fix markers explain completion overhead without changing validation charts", async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-10-06T12:00:00Z"));
  const runs = ["2026-07-01T00:00:00Z", "2026-10-06T00:00:00Z"]
    .map((createdAt, index) => ({ ...baseRun, id: index + 1, createdAt }));
  await page.route("**/data/workflow.json", (route) => route.fulfill({ json: { ...fixture, runs } }));
  await page.goto("/?days=all&metric=elapsed");
  await expect(page.locator("#chart .milestone-label")).toHaveText([
    "Direct CLI launches merged",
    "Action archive setup regression",
    "Skip redundant client compilation merged",
    "Action archive setup removed",
  ]);
  const regression = page.locator("#chart .chart-event.milestone-regression");
  const fix = page.locator("#chart .chart-event.milestone-fix");
  await expect(regression).toHaveAttribute("href", /\/pull\/46946$/);
  await expect(fix).toHaveAttribute("href", /\/pull\/47021$/);
  await expect(regression).toContainText("2026-10-01 18:40 UTC");
  await expect(fix).toContainText("2026-10-05 16:19 UTC");
  expect(await regression.evaluate((node) => getComputedStyle(node).borderLeftColor))
    .not.toEqual(await fix.evaluate((node) => getComputedStyle(node).borderLeftColor));
  await expect(page.locator("#chart .annotation-number")).toHaveText(["1", "2", "3", "4"]);
  await expect(page.locator("#chart .milestone-number")).toHaveText(["1", "2", "3", "4"]);
  for (const width of [1440, 800, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const labels = await page.locator("#chart .chart-event").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
    for (let index = 0; index < labels.length; index++) {
      expect(labels[index].left).toBeGreaterThanOrEqual(0);
      expect(labels[index].right).toBeLessThanOrEqual(width);
      for (const other of labels.slice(index + 1)) {
        expect(labels[index].right <= other.left || other.right <= labels[index].left ||
          labels[index].bottom <= other.top || other.bottom <= labels[index].top).toBe(true);
      }
    }
    const badges = await page.locator("#chart .milestone-badge").evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
    for (let index = 0; index < badges.length; index++) {
      for (const other of badges.slice(index + 1)) {
        expect(badges[index].right <= other.left || other.right <= badges[index].left ||
          badges[index].bottom <= other.top || other.bottom <= badges[index].top).toBe(true);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("marker-key-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath("marker-key-desktop.png"), fullPage: true });
  await expect(page.locator("#setup-notice")).toBeVisible();
  await expect(page.locator("#setup-notice")).toContainText("not validation work");
  await expect(page.locator("#comparisons section")).toHaveCount(2);
  for (const metric of ["validation", "slowest"]) {
    await page.selectOption("#metric", metric);
    await expect(page.locator("#chart .milestone-label")).toHaveCount(2);
    await expect(page.locator("#chart .milestone-regression, #chart .milestone-fix")).toHaveCount(0);
    await expect(page.locator("#setup-notice")).toBeHidden();
  }
});

test("completion trend has a point per run and drops only at the first measured post-fix run", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-06T12:00:00Z"));
  const samples = [
    ["2026-10-05T12:00:00Z", 1800],
    ["2026-10-05T16:19:34Z", 1800],
    ["2026-10-05T16:19:38Z", 1200],
    ["2026-10-05T17:00:00Z", 1000],
  ] as const;
  const runs = samples.map(([createdAt, elapsed], index) => ({
    ...baseRun, id: index + 1, createdAt,
    jobs: jobs().map((job) => ({
      ...job, startedAt: createdAt, completedAt: new Date(Date.parse(createdAt) + elapsed * 1000).toISOString(),
    })),
  }));
  await page.route("**/data/workflow.json", (route) => route.fulfill({ json: { ...fixture, runs } }));
  await page.goto("/?days=all&metric=elapsed");
  await expect(page.locator("#chart circle")).toHaveCount(8);
  await expect(page.locator(".chart-caption")).toContainText("rolling medians of up to 7 runs");
  const vertices = await page.locator("#chart path.series-linux").evaluate((node) => {
    const commands = node.getAttribute("d")!.match(/[MHV][\d.,-]+/g)!;
    const [x, y] = commands[0].slice(1).split(",").map(Number);
    return [
      { x, y },
      ...commands.slice(1).filter((_, index) => index % 2 === 0).map((command, index) => ({
        x: Number(command.slice(1)), y: Number(commands[index * 2 + 2].slice(1)),
      })),
    ];
  });
  const dots = await page.locator("#chart circle.series-linux").evaluateAll((nodes) => nodes.map((node) => ({
    x: Number(node.getAttribute("cx")), y: Number(node.getAttribute("cy")),
  })));
  expect(vertices).toHaveLength(samples.length);
  expect(vertices.slice(0, 3)).toEqual(dots.slice(0, 3));
  expect(vertices[3].x).toBe(dots[3].x);
  expect(vertices[3].y).toBeCloseTo((dots[2].y + dots[3].y) / 2);
  const fixX = Number(await page.locator("#chart line.milestone-fix").getAttribute("x1"));
  expect(vertices[1].x).toBeLessThan(fixX);
  expect(vertices[2].x).toBeGreaterThan(fixX);
  expect(vertices[2].y).toBeGreaterThan(vertices[1].y);
  expect(await page.locator("#chart path.series-linux").getAttribute("d")).not.toContain("L");
  await expect(page.locator("#linux-median")).toHaveText("25m 00s");
});

test("line style switches between daily and rolling medians without changing runs or summaries", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-10-06T12:00:00Z"));
  const samples = [
    ["2026-10-05T12:00:00Z", 1800],
    ["2026-10-05T16:19:38Z", 1200],
    ["2026-10-05T17:00:00Z", 1000],
    ["2026-10-06T01:00:00Z", 1100],
  ] as const;
  const runs = samples.map(([createdAt, elapsed], index) => ({
    ...baseRun, id: index + 1, createdAt,
    jobs: jobs().map((job) => ({
      ...job, startedAt: createdAt, completedAt: new Date(Date.parse(createdAt) + elapsed * 1000).toISOString(),
    })),
  }));
  await page.route("**/data/workflow.json", (route) => route.fulfill({ json: { ...fixture, runs } }));
  await page.goto("/?days=all&metric=elapsed");
  await expect(page.getByLabel("Trend line")).toHaveValue("rolling");
  const dots = await page.locator("#chart circle").evaluateAll((nodes) => nodes.map((node) => node.outerHTML));
  const summary = await page.locator(".cards").textContent();
  const rolling = await page.locator("#chart path.series-linux").getAttribute("d");
  expect(rolling!.match(/H/g)).toHaveLength(3);
  await page.selectOption("#trend", "daily");
  await expect(page.locator("#trend-caption")).toContainText("UTC daily medians");
  await expect(page).toHaveURL(/trend=daily/);
  await expect(page.locator("#days")).toHaveValue("all");
  await expect(page.locator("#metric")).toHaveValue("elapsed");
  expect(await page.locator("#chart path.series-linux").getAttribute("d")).toMatch(/^M[\d.,]+ L[\d.,]+$/);
  expect(await page.locator("#chart circle").evaluateAll((nodes) => nodes.map((node) => node.outerHTML))).toEqual(dots);
  expect(await page.locator(".cards").textContent()).toEqual(summary);
  await page.reload();
  await expect(page.locator("#trend")).toHaveValue("daily");
  await expect(page.locator("#trend-caption")).toContainText("UTC daily medians");
  await page.getByRole("button", { name: "Zoom to archive removal" }).click();
  await expect(page.locator("#trend")).toHaveValue("daily");
  await page.selectOption("#days", "all");
  await page.selectOption("#trend", "rolling");
  await expect(page.locator("#trend-caption")).toContainText("rolling medians of up to 7 runs");
  expect(await page.locator("#chart path.series-linux").getAttribute("d")).toBe(rolling);
  expect(await page.locator(".cards").textContent()).toEqual(summary);
});

test("focused daily trend stays within the plot while keeping runs from partial boundary days", async ({ page }) => {
  const runs = ["2026-10-04T18:00:00Z", "2026-10-05T12:00:00Z", "2026-10-06T12:00:00Z"]
    .map((createdAt, index) => ({ ...baseRun, id: index + 1, createdAt }));
  await page.route("**/data/workflow.json", (route) => route.fulfill({ json: { ...fixture, runs } }));
  await page.goto("/?days=setup-fix&metric=elapsed&trend=daily");
  await expect(page.locator("#run-count")).toHaveText("3");
  await expect(page.locator("#chart circle")).toHaveCount(6);
  const xs = await page.locator("#chart path.series-linux").evaluate((node) =>
    node.getAttribute("d")!.match(/[ML][\d.,-]+/g)!.map((command) => Number(command.slice(1).split(",")[0])));
  expect(xs).toHaveLength(2);
  for (const x of xs) {
    expect(x).toBeGreaterThanOrEqual(60);
    expect(x).toBeLessThanOrEqual(1080);
  }
});

test("unsupported line styles fall back to the rolling default", async ({ page }) => {
  await page.route("**/data/workflow.json", (route) => route.fulfill({ json: fixture }));
  await page.goto("/?trend=unknown");
  await expect(page.locator("#trend")).toHaveValue("rolling");
  await expect(page).toHaveURL(/trend=rolling/);
  await expect(page.locator("#trend-caption")).toContainText("rolling medians");
});

test("archive-removal zoom centers the merge and visibly expands the measured drop", async ({ page }, testInfo) => {
  await page.clock.setFixedTime(new Date("2026-10-06T12:00:00Z"));
  const samples = [
    ["2026-10-01T12:00:00Z", 1800, 3000],
    ["2026-10-05T12:00:00Z", 1740, 2400],
    ["2026-10-05T16:19:38Z", 1620, 2100],
    ["2026-10-05T17:00:00Z", 1620, 2100],
    ["2026-10-06T17:00:00Z", 1600, 2100],
  ] as const;
  const runs = samples.map(([createdAt, linux, windows], index) => ({
    ...baseRun, id: index + 1, createdAt,
    jobs: jobs().map((job) => ({
      ...job, startedAt: createdAt,
      completedAt: new Date(Date.parse(createdAt) + (job.os === "ubuntu" ? linux : windows) * 1000).toISOString(),
    })),
  }));
  await page.route("**/data/workflow.json", (route) => route.fulfill({ json: { ...fixture, runs } }));
  await page.goto("/?days=all&metric=elapsed&outcome=all");
  const normal = await page.locator("#chart circle.series-windows").evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("cy"))));
  const normalDrop = Math.abs(normal[2] - normal[1]);
  await page.getByRole("button", { name: "Zoom to archive removal" }).click();
  await expect(page.locator("#days")).toHaveValue("setup-fix");
  await expect(page.locator("#metric")).toHaveValue("elapsed");
  await expect(page.locator("#outcome")).toHaveValue("all");
  await expect(page).toHaveURL(/days=setup-fix&metric=elapsed&outcome=all/);
  await expect(page.locator("#run-count")).toHaveText("3");
  await expect(page.locator("#focus-notice")).toContainText("may not start at zero");
  await expect(page.locator("#chart .milestone-label")).toHaveText("Action archive setup removed");
  await expect(page.locator("#chart svg")).toHaveAccessibleName("Completion time by run, Linux and Windows, zoomed around archive removal");
  const focused = await page.locator("#chart circle.series-windows").evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("cy"))));
  expect(Math.abs(focused[1] - focused[0])).toBeGreaterThan(normalDrop * 2);
  await expect(page.locator("#chart text.axis-label").first()).not.toHaveText("0s");
  expect(Number(await page.locator("#chart line.milestone-fix").getAttribute("x1"))).toBe(570);
  await expect(page.locator("#chart text.axis-label")).toContainText(["Oct 4 16:19", "Oct 6 16:19"]);
  await page.screenshot({ path: testInfo.outputPath("archive-focus-desktop.png"), fullPage: true });
  await page.reload();
  await expect(page.locator("#days")).toHaveValue("setup-fix");
  await expect(page.locator("#focus-notice")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#chart svg")).toHaveAttribute("viewBox", /0 0 3\d\d 300/);
  expect(await page.locator("#chart").evaluate((chart) => {
    const bounds = chart.getBoundingClientRect();
    return [...chart.querySelectorAll("circle")].every((dot) => {
      const point = dot.getBoundingClientRect();
      return point.left >= bounds.left && point.right <= bounds.right;
    });
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("archive-focus-mobile.png"), fullPage: true });
  await page.selectOption("#metric", "validation");
  await expect(page.locator("#chart line.milestone-fix")).toHaveCount(0);
  await page.getByRole("button", { name: "Zoom to archive removal" }).click();
  await expect(page.locator("#metric")).toHaveValue("elapsed");
  await page.selectOption("#days", "all");
  await expect(page.locator("#focus-notice")).toBeHidden();
  await expect(page.locator("#chart text.axis-label").first()).toHaveText("0s");
});

test("archive-removal focus with no measurements still reports the empty window", async ({ page }) => {
  await page.route("**/data/workflow.json", (route) => route.fulfill({ json: { ...fixture, runs: [] } }));
  await page.goto("/?days=setup-fix&metric=elapsed");
  await expect(page.locator("#chart")).toContainText("No complete measurements");
  await expect(page.locator("#run-count")).toHaveText("0");
  await expect(page.locator("#focus-notice")).toBeVisible();
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
  await page.selectOption("#days", "all");
  await page.selectOption("#metric", "elapsed");
  const measuredDrop = () => page.locator("#chart").evaluate((chart) => {
    const fixX = Number(chart.querySelector("line.milestone-fix")!.getAttribute("x1"));
    const dots = [...chart.querySelectorAll("circle.series-windows")];
    const after = dots.findIndex((dot) => Number(dot.getAttribute("cx")) >= fixX);
    return Math.abs(Number(dots[after].getAttribute("cy")) - Number(dots[after - 1].getAttribute("cy")));
  });
  const normalDrop = await measuredDrop();
  await page.getByRole("button", { name: "Zoom to archive removal" }).click();
  expect(await measuredDrop()).toBeGreaterThan(normalDrop * 2);
  await page.locator(".chart-panel").screenshot({ path: testInfo.outputPath("archive-focus-real-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#chart svg")).toHaveAttribute("viewBox", /0 0 3\d\d 300/);
  await page.emulateMedia({ colorScheme: "dark" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator(".chart-panel").screenshot({ path: testInfo.outputPath("archive-focus-real-mobile.png") });
  await page.screenshot({ path: testInfo.outputPath("mobile.png"), fullPage: true });
  expect(errors).toEqual([]);
});
