export const $ = (id) => document.getElementById(id);
export const date = (value) => new Date(value).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
export const timestamp = (value) => new Date(value).toISOString().slice(0, 16).replace("T", " ");

export function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function link(text, href) {
  const node = element("a", text);
  const url = new URL(href);
  if (url.origin !== "https://github.com") throw new Error(`Unexpected link origin: ${url.origin}`);
  node.href = url.href;
  node.target = "_blank";
  node.rel = "noopener noreferrer";
  return node;
}

export function svgNode(tag, attributes = {}, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

export function restoreFilters(fields, render) {
  for (const field of fields) {
    const value = new URLSearchParams(location.search).get(field);
    if ([...$(field).options].some((option) => option.value === value)) $(field).value = value;
    $(field).addEventListener("change", render);
  }
}

export function filterOptions(fields) {
  const options = Object.fromEntries(fields.map((field) => [field, $(field).value]));
  history.replaceState(null, "", `?${new URLSearchParams(options)}`);
  return options;
}

export async function loadDataset(path) {
  const response = await fetch(path, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load workflow history (HTTP ${response.status}).`);
  const dataset = await response.json();
  if (dataset.schemaVersion !== 1 || !Array.isArray(dataset.runs)) throw new Error("Unsupported workflow history format.");
  const stale = Date.now() - Date.parse(dataset.generatedAt) > 4 * 3_600_000;
  const unresolved = dataset.exclusions?.filter((run) => run.reason === "base-unresolved").length ?? 0;
  $("status").textContent = `Updated ${timestamp(dataset.generatedAt)} UTC \u00b7 ${dataset.runs.length} runs archived since ${date(dataset.historyStart)}${unresolved ? ` \u00b7 ${unresolved} runs with unconfirmed PR targets excluded.` : ""}${stale ? " \u00b7 Data is over 4 hours old; the refresh workflow may be delayed or failing." : ""}`;
  if (stale) $("status").classList.add("error");
  return dataset;
}

export function showError(error) {
  $("status").textContent = `${error.message} See the source repository's Actions tab for refresh failures.`;
  $("status").classList.add("error");
  $("status").setAttribute("role", "alert");
  console.error(error);
}
