import { comparison, duration, median, metrics, selectRuns } from "./metrics.js";
import { drawChart } from "./chart.js";
import { $, date, element, filterOptions, link, loadDataset, restoreFilters, showError, timestamp } from "./ui.js";

const fields = ["days", "metric", "outcome"];
let dataset;
let limit = 20;

function renderComparison(runs) {
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
    meta.append(element("span", `Result: ${run.selectedConclusion}`, run.selectedConclusion));
    const workflowTime = (Date.parse(run.updatedAt) - Date.parse(run.createdAt)) / 1000;
    meta.append(element("span", `Whole workflow (including queue): ${duration(workflowTime)}`));
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
  const options = filterOptions(fields);
  const runs = selectRuns(dataset.runs, options);
  for (const [os, id] of [["ubuntu", "linux"], ["windows", "windows"]]) {
    const values = runs.map((run) => run[os]).filter((value) => value !== null);
    $(`${id}-median`).textContent = duration(median(values));
    $(`${id}-count`).textContent = `${values.length} complete timings \u00b7 ${metrics[options.metric].label.toLowerCase()}`;
  }
  $("run-count").textContent = runs.length.toLocaleString();
  $("date-range").textContent = runs.length ? `${date(runs[0].createdAt)} \u2013 ${date(runs.at(-1).createdAt)}` : "No matching runs";
  $("chart-title").textContent = metrics[options.metric].label;
  $("metric-description").textContent = metrics[options.metric].description;
  drawChart($("chart"), runs, {
    title: `${metrics[options.metric].label} by run, Linux and Windows`,
    annotation: true,
    series: [{ key: "ubuntu", label: "Linux", color: "linux" }, { key: "windows", label: "Windows", color: "windows" }],
  });
  renderComparison(runs);
  renderRuns(runs);
}

async function load() {
  restoreFilters(fields, () => { limit = 20; render(); });
  $("more").addEventListener("click", () => { limit += 20; render(); });
  dataset = await loadDataset("./data/workflow.json");
  render();
}

load().catch(showError);
