import { comparison, dailyMedians, duration, median, metrics, milestone, selectRuns } from "./metrics.js";

const $ = (id) => document.getElementById(id);
const fields = ["cohort", "days", "metric", "outcome"];
const date = (value) => new Date(value).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
const timestamp = (value) => new Date(value).toISOString().slice(0, 16).replace("T", " ");
let dataset;
let limit = 20;

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function link(text, href) {
  const node = element("a", text);
  const url = new URL(href);
  if (url.origin !== "https://github.com") throw new Error(`Unexpected link origin: ${url.origin}`);
  node.href = url.href;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  return node;
}

function svgNode(tag, attributes = {}, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function drawChart(runs) {
  const points = runs.filter((run) => run.ubuntu !== null || run.windows !== null);
  $("chart").replaceChildren();
  if (!points.length) {
    $("chart").append(element("p", "No complete timings match these filters.", "empty"));
    return;
  }
  const width = 1100, height = 340;
  const margin = { left: 55, right: 20, top: 36, bottom: 34 };
  const first = Date.parse(points[0].createdAt);
  const last = Date.parse(points.at(-1).createdAt);
  const minX = Math.floor(first / 86_400_000) * 86_400_000;
  const maxX = Math.floor(last / 86_400_000 + 1) * 86_400_000;
  const largest = Math.max(...points.flatMap((run) => [run.ubuntu ?? 0, run.windows ?? 0]));
  const tick = Math.max(300, Math.ceil(largest / 5 / 300) * 300);
  const maxY = Math.max(tick, Math.ceil(largest / tick) * tick);
  const x = (value) => margin.left + (value - minX) / (maxX - minX) * (width - margin.left - margin.right);
  const y = (value) => height - margin.bottom - value / maxY * (height - margin.top - margin.bottom);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": `${metrics[$("metric").value].label} by run, Linux and Windows` });
  svg.append(svgNode("title", {}, "Workflow runtime trends. Individual points link to GitHub runs."));
  for (let value = 0; value <= maxY; value += tick) {
    svg.append(svgNode("line", { x1: margin.left, y1: y(value), x2: width - margin.right, y2: y(value), class: "grid" }));
    svg.append(svgNode("text", { x: margin.left - 12, y: y(value) + 4, "text-anchor": "end", class: "axis-label" }, `${value / 60}m`));
  }
  for (let index = 0; index <= 6; index++) {
    const time = minX + (maxX - minX) * index / 6;
    svg.append(svgNode("text", { x: x(time), y: height - 8, "text-anchor": index === 0 ? "start" : index === 6 ? "end" : "middle", class: "axis-label" }, date(time)));
  }
  const mergeTime = Date.parse(milestone.time);
  if ($("cohort").value !== "next" && mergeTime >= minX && mergeTime <= maxX) {
    const position = x(mergeTime);
    svg.append(svgNode("line", { x1: position, x2: position, y1: margin.top - 8, y2: height - margin.bottom, class: "milestone" }));
    svg.append(svgNode("text", { x: position > width / 2 ? position - 8 : position + 8, y: 18, "text-anchor": position > width / 2 ? "end" : "start", class: "milestone-label" }, "Direct CLI launches merged"));
  }
  for (const os of ["ubuntu", "windows"]) {
    const css = os === "ubuntu" ? "series-linux" : "series-windows";
    const daily = dailyMedians(points, os);
    svg.append(svgNode("path", { d: daily.map((point, index) => `${index ? "L" : "M"}${x(point.time)},${y(point.value)}`).join(" "), class: `${css} trend` }));
    for (const run of points) {
      if (run[os] === null) continue;
      const label = `${timestamp(run.createdAt)} UTC, ${os === "ubuntu" ? "Linux" : "Windows"}: ${duration(run[os])} (${run.selectedConclusion}). ${run.title}`;
      const anchor = svgNode("a", { href: link("", run.url).href, target: "_blank", rel: "noopener noreferrer", "aria-label": label });
      const point = svgNode("circle", { cx: x(Date.parse(run.createdAt)), cy: y(run[os]), r: 3.5, class: `${css} point` });
      point.append(svgNode("title", {}, label));
      anchor.append(point);
      svg.append(anchor);
    }
  }
  $("chart").append(svg);
}

function renderComparison(runs) {
  $("comparison-panel").hidden = $("cohort").value !== "push";
  $("comparison").replaceChildren();
  for (const os of ["ubuntu", "windows"]) {
    const result = comparison(runs.filter((run) => run.selectedConclusion === "success"), os);
    const row = element("div", undefined, "comparison-row");
    row.append(element("p", os === "ubuntu" ? "LINUX" : "WINDOWS"));
    row.append(element("strong", `${duration(result.baseline)} \u2192 ${duration(result.current)}`));
    if (result.reduction !== null) {
      row.append(element("span", `${Math.abs(result.reduction).toFixed(1)}% ${result.reduction >= 0 ? "faster" : "slower"}`, `change${result.reduction < 0 ? " slower" : ""}`));
    } else {
      row.append(element("span", "No runs on both sides of the merge within these filters."));
    }
    row.append(element("p", `${result.before} before / ${result.after} after \u00b7 ${metrics[$("metric").value].label.toLowerCase()}`));
    $("comparison").append(row);
  }
}

function renderRuns(runs) {
  $("runs").replaceChildren();
  for (const run of runs.toReversed().slice(0, limit)) {
    const details = element("details");
    const summary = element("summary");
    summary.append(element("span", `${timestamp(run.createdAt)} UTC`, "run-date"), element("span", run.title, "run-title"));
    for (const os of ["ubuntu", "windows"]) {
      const value = element("span", duration(run[os]), "run-value");
      value.append(element("small", os === "ubuntu" ? "Linux" : "Windows"));
      summary.append(value);
    }
    details.append(summary);
    const body = element("div", undefined, "run-details");
    const meta = element("div", undefined, "run-meta");
    meta.append(link(`Run ${run.id} \u2197`, run.url), element("span", `Commit ${run.sha.slice(0, 7)} \u00b7 attempt ${run.attempt}`));
    meta.append(element("span", `Selected checkout: ${run.selectedConclusion}`, run.selectedConclusion));
    const workflowTime = (Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000;
    meta.append(element("span", `Whole workflow (all checkouts + queue): ${duration(workflowTime)}`));
    body.append(meta);
    const scroll = element("div", undefined, "table-scroll");
    const table = element("table");
    const head = element("thead");
    const heading = element("tr");
    for (const text of ["OS / shard", "Result", "Job elapsed", "Validation", "Setup"]) heading.append(element("th", text));
    head.append(heading);
    table.append(head);
    const tbody = element("tbody");
    for (const job of run.selectedJobs.toSorted((a, b) => a.os.localeCompare(b.os) || a.shard - b.shard)) {
      const row = element("tr");
      const name = element("td");
      name.append(link(`${job.os === "ubuntu" ? "Linux" : "Windows"} / ${job.shard}`, job.url));
      row.append(name, element("td", job.conclusion ?? job.status, job.conclusion === "success" ? "success" : "failure"));
      for (const value of [job.elapsed, job.validation, job.setup]) row.append(element("td", duration(value)));
      tbody.append(row);
    }
    table.append(tbody);
    scroll.append(table);
    body.append(scroll);
    details.append(body);
    $("runs").append(details);
  }
  if (!runs.length) $("runs").append(element("p", "No runs match these filters.", "empty"));
  $("more").hidden = runs.length <= limit;
}

function render() {
  if (!dataset) return;
  const options = Object.fromEntries(fields.map((field) => [field, $(field).value]));
  const runs = selectRuns(dataset.runs, options);
  const query = new URLSearchParams(options);
  history.replaceState(null, "", `?${query}`);
  for (const [os, id] of [["ubuntu", "linux"], ["windows", "windows"]]) {
    const values = runs.map((run) => run[os]).filter((value) => value !== null);
    $(`${id}-median`).textContent = duration(median(values));
    $(`${id}-count`).textContent = `${values.length} complete timings \u00b7 ${metrics[options.metric].label.toLowerCase()}`;
  }
  $("run-count").textContent = runs.length.toLocaleString();
  $("date-range").textContent = runs.length ? `${date(runs[0].createdAt)} \u2013 ${date(runs.at(-1).createdAt)}` : "No matching runs";
  $("chart-title").textContent = metrics[options.metric].label;
  $("metric-description").textContent = metrics[options.metric].description;
  drawChart(runs);
  renderComparison(runs);
  renderRuns(runs);
}

async function load() {
  for (const field of fields) {
    const value = new URLSearchParams(location.search).get(field);
    if ([...$(field).options].some((option) => option.value === value)) $(field).value = value;
    $(field).addEventListener("change", () => { limit = 20; render(); });
  }
  $("more").addEventListener("click", () => { limit += 20; render(); });
  const response = await fetch("./data/workflow.json", { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load workflow history (HTTP ${response.status}).`);
  dataset = await response.json();
  if (dataset.schemaVersion !== 1 || !Array.isArray(dataset.runs)) throw new Error("Unsupported workflow history format.");
  const stale = Date.now() - Date.parse(dataset.generatedAt) > 4 * 3_600_000;
  $("status").textContent = `Updated ${timestamp(dataset.generatedAt)} UTC \u00b7 ${dataset.runs.length} runs archived since ${date(dataset.historyStart)}${stale ? " \u00b7 Data is over 4 hours old; the refresh workflow may be delayed or failing." : ""}`;
  if (stale) $("status").classList.add("error");
  render();
}

load().catch((error) => {
  $("status").textContent = `${error.message} See the source repository's Actions tab for refresh failures.`;
  $("status").classList.add("error");
  $("status").setAttribute("role", "alert");
  console.error(error);
});
