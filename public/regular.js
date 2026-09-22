import { averagePerSpec, duration, median, selectRegularRuns, specDuration } from "./metrics.js";
import { drawChart } from "./chart.js";
import { $, element, filterOptions, link, loadDataset, restoreFilters, showError, timestamp } from "./ui.js";

const fields = ["days", "workload", "outcome"];
const count = (value) => Number.isFinite(value) ? value.toLocaleString("en-US") : "\u2014";
let dataset;
let limit = 20;

function valueCell(value, label) {
  const cell = element("span", value, "run-value");
  cell.append(element("small", label));
  return cell;
}

function renderRuns(runs) {
  $("runs").replaceChildren();
  for (const run of runs.toReversed().slice(0, limit)) {
    const details = element("details");
    const summary = element("summary", undefined, "regular-summary");
    summary.append(element("span", `${timestamp(run.createdAt)} UTC`, "run-date"), element("span", run.title, "run-title"));
    summary.append(valueCell(count(run.specCount), "specs"), valueCell(duration(run.total), "total runtime"));
    const averages = valueCell(`${specDuration(run.validationPerSpec)} / ${specDuration(run.totalPerSpec)}`, "validation / total per spec");
    summary.append(averages);
    details.append(summary);
    const body = element("div", undefined, "run-details");
    const meta = element("div", undefined, "run-meta");
    meta.append(link(`Run ${run.id} \u2197`, run.url));
    for (const number of run.pullRequests) meta.append(link(`PR ${number} \u2197`, `https://github.com/Azure/azure-rest-api-specs/pull/${number}`));
    meta.append(element("span", `Commit ${run.sha.slice(0, 7)} \u00b7 attempt ${run.attempt}`), element("span", run.selectedConclusion, run.selectedConclusion));
    const detail = run.specs.status === "available"
      ? `${count(run.specs.selected)} selected / ${count(run.specCount)} actually validated`
      : `Project count unavailable: ${run.specs.status}`;
    meta.append(element("span", detail));
    body.append(meta);
    const table = element("table");
    const heading = element("tr");
    for (const label of ["Total job", "Validation step", "Setup", "Validation / spec", "Total / spec"]) heading.append(element("th", label));
    const thead = element("thead"); thead.append(heading); table.append(thead);
    const row = element("tr");
    for (const value of [duration(run.total), duration(run.validation), duration(run.jobs[0].setup), specDuration(run.validationPerSpec), specDuration(run.totalPerSpec)]) row.append(element("td", value));
    const tbody = element("tbody"); tbody.append(row); table.append(tbody);
    const scroll = element("div", undefined, "table-scroll"); scroll.append(table); body.append(scroll);
    details.append(body);
    $("runs").append(details);
  }
  if (!runs.length) $("runs").append(element("p", "No runs match these filters.", "empty"));
  $("more").hidden = runs.length <= limit;
}

function render() {
  if (!dataset) return;
  const runs = selectRegularRuns(dataset.runs, filterOptions(fields));
  $("total-median").textContent = duration(median(runs.map((run) => run.total).filter(Number.isFinite)));
  $("validation-average").textContent = specDuration(averagePerSpec(runs, "validation"));
  $("total-average").textContent = specDuration(averagePerSpec(runs, "total"));
  $("run-count").textContent = `${runs.length.toLocaleString()} ${runs.length === 1 ? "run" : "runs"} in view`;
  const known = runs.filter((run) => run.specCount !== null);
  $("spec-count").textContent = known.length ? count(known.reduce((sum, run) => sum + run.specCount, 0)) : "\u2014";
  $("zero-count").textContent = `${runs.filter((run) => run.specCount === 0).length.toLocaleString()} zero-spec runs \u00b7 not unique specs`;
  const missing = runs.length - known.length;
  $("count-notice").hidden = missing === 0;
  $("count-notice").textContent = `${missing} ${missing === 1 ? "run has" : "runs have"} unavailable project counts. These runtimes are shown, but excluded from per-spec averages and spec-count totals. Expand a run for the reason.`;
  drawChart($("total-chart"), runs, {
    title: "Total job and validation runtime",
    series: [{ key: "total", label: "Total job", color: "linux" }, { key: "validation", label: "Validation", color: "windows" }],
  });
  drawChart($("average-chart"), runs, {
    title: "Average runtime per validated spec", format: specDuration,
    series: [{ key: "validationPerSpec", label: "Validation / spec", color: "linux", weightKey: "specCount" }, { key: "totalPerSpec", label: "Total / spec", color: "windows", weightKey: "specCount" }],
  });
  drawChart($("count-chart"), runs, {
    title: "Specs validated per run", count: true, format: count,
    series: [{ key: "specCount", label: "Validated specs", color: "count" }],
  });
  renderRuns(runs);
}

async function load() {
  restoreFilters(fields, () => { limit = 20; render(); });
  $("more").addEventListener("click", () => { limit += 20; render(); });
  dataset = await loadDataset("./data/regular.json");
  render();
}

load().catch(showError);
