import { duration, median } from "./metrics.js";
import { date, element, link, svgNode, timestamp } from "./ui.js";

export function dailySeries(runs, key, weightKey) {
  const days = new Map();
  for (const run of runs) {
    if (!Number.isFinite(run[key])) continue;
    if (weightKey && !(run[weightKey] > 0)) continue;
    const day = run.createdAt.slice(0, 10);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push({ value: run[key], weight: weightKey ? run[weightKey] : 1 });
  }
  return [...days].map(([day, values]) => ({
    time: Date.parse(`${day}T12:00:00Z`),
    value: weightKey
      ? values.reduce((sum, item) => sum + item.value * item.weight, 0) / values.reduce((sum, item) => sum + item.weight, 0)
      : median(values.map((item) => item.value)),
  }));
}

export function rollingMedianSeries(runs, key, annotations = []) {
  const boundaries = annotations.map((annotation) => Date.parse(annotation.time)).toSorted((a, b) => a - b);
  const values = [];
  let boundary = 0;
  return runs.filter((run) => Number.isFinite(run[key]))
    .toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .map((run) => {
      const time = Date.parse(run.createdAt);
      while (boundary < boundaries.length && boundaries[boundary] <= time) {
        values.length = 0;
        boundary++;
      }
      values.push(run[key]);
      if (values.length > 7) values.shift();
      return { time, value: median(values) };
    });
}

function tickStep(max, count) {
  if (max <= 0) return count ? 1 : 10;
  const rough = max / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((value) => value * magnitude >= rough) * magnitude;
  return count ? Math.max(1, step) : step;
}

export function drawChart(container, runs, { title, series, count = false, annotations = [], format = duration, trend = "daily" }) {
  container.replaceChildren();
  const points = runs.filter((run) => series.some(({ key }) => Number.isFinite(run[key])));
  if (!points.length) {
    container.append(element("p", "No complete measurements match these filters.", "empty"));
    return;
  }
  const width = 1100, height = 300;
  const minX = Math.floor(Date.parse(points[0].createdAt) / 86_400_000) * 86_400_000;
  const maxX = Math.floor(Date.parse(points.at(-1).createdAt) / 86_400_000 + 1) * 86_400_000;
  const visibleAnnotations = annotations.filter((annotation) => Date.parse(annotation.time) >= minX && Date.parse(annotation.time) <= maxX)
    .toSorted((a, b) => a.time.localeCompare(b.time));
  const margin = { left: 60, right: 20, top: 32, bottom: 34 };
  const largest = points.reduce((max, run) => Math.max(max, ...series.map(({ key }) => run[key] ?? 0)), 0);
  const tick = tickStep(largest, count);
  const maxY = Math.max(tick, Math.ceil(largest / tick) * tick);
  const x = (value) => margin.left + (value - minX) / (maxX - minX) * (width - margin.left - margin.right);
  const rowEnds = [];
  const annotationRows = visibleAnnotations.map((annotation) => {
    const position = x(Date.parse(annotation.time));
    let row = rowEnds.findIndex((end) => position - 16 > end);
    if (row < 0) row = rowEnds.length;
    rowEnds[row] = position + 16;
    return row;
  });
  margin.top += Math.max(0, rowEnds.length - 1) * 24;
  const y = (value) => height - margin.bottom - value / maxY * (height - margin.top - margin.bottom);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": title });
  const tooltip = element("div", undefined, "chart-tooltip");
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  const positionTooltip = (clientX, clientY) => {
    const bounds = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(12, Math.min(clientX + 12, window.innerWidth - bounds.width - 12))}px`;
    tooltip.style.top = `${Math.max(12, clientY + bounds.height + 24 <= window.innerHeight
      ? clientY + 12 : clientY - bounds.height - 12)}px`;
  };
  for (let value = 0; value <= maxY + tick / 100; value += tick) {
    svg.append(svgNode("line", { x1: margin.left, y1: y(value), x2: width - margin.right, y2: y(value), class: "grid" }));
    const label = count ? String(Math.round(value)) : value >= 60 ? `${+(value / 60).toFixed(1)}m` : `${+value.toFixed(1)}s`;
    svg.append(svgNode("text", { x: margin.left - 12, y: y(value) + 4, "text-anchor": "end", class: "axis-label" }, label));
  }
  for (let index = 0; index <= 6; index++) {
    const time = minX + (maxX - minX) * index / 6;
    const label = maxX - minX <= 86_400_000 ? new Date(time).toISOString().slice(11, 16) : date(time);
    svg.append(svgNode("text", { x: x(time), y: height - 8, "text-anchor": index === 0 ? "start" : index === 6 ? "end" : "middle", class: "axis-label" }, label));
  }
  const annotationKey = element("ol", undefined, "chart-annotations");
  annotationKey.setAttribute("aria-label", "Chart events");
  for (const [index, annotation] of visibleAnnotations.entries()) {
    const position = x(Date.parse(annotation.time));
    const kind = annotation.kind ? ` milestone-${annotation.kind}` : "";
    const label = annotation.kind ? annotation.label : `${annotation.label} merged`;
    const entry = element("li");
    const eventLink = link("", annotation.url);
    eventLink.className = `chart-event${kind}`;
    const number = element("span", String(index + 1), "annotation-number");
    const description = element("span");
    description.append(element("span", label, "milestone-label"), element("small", `${timestamp(annotation.time)} UTC`));
    eventLink.append(number, description);
    entry.append(eventLink);
    annotationKey.append(entry);
    svg.append(svgNode("line", { x1: position, x2: position, y1: margin.top - 8, y2: height - margin.bottom, class: `milestone${kind}` }));
    const top = 4 + annotationRows[index] * 24;
    const anchor = svgNode("a", { href: eventLink.href, target: "_blank", rel: "noopener noreferrer", "aria-label": `${index + 1}. ${label}. ${timestamp(annotation.time)} UTC` });
    anchor.append(
      svgNode("rect", { x: position - 12, y: top, width: 24, height: 20, rx: 5, class: `milestone-badge${kind}` }),
      svgNode("text", { x: position, y: top + 14, "text-anchor": "middle", class: `milestone-number${kind}` }, String(index + 1)),
    );
    svg.append(anchor);
  }
  for (const { key, label, color, weightKey } of series) {
    const trendPoints = trend === "rolling"
      ? rollingMedianSeries(points, key, annotations)
      : dailySeries(points, key, weightKey);
    const path = trendPoints.map((point, index) => {
      if (!index) return `M${x(point.time)},${y(point.value)}`;
      return trend === "rolling"
        ? `H${x(point.time)} V${y(point.value)}`
        : `L${x(point.time)},${y(point.value)}`;
    }).join(" ");
    svg.append(svgNode("path", { d: path, class: `series-${color} trend` }));
    for (const run of points) {
      if (!Number.isFinite(run[key])) continue;
      const description = `${timestamp(run.createdAt)} UTC, ${label}: ${format(run[key])} (${run.selectedConclusion}). ${run.title}`;
      const anchor = svgNode("a", { href: link("", run.url).href, target: "_blank", rel: "noopener noreferrer", "aria-label": description });
      const point = svgNode("circle", { cx: x(Date.parse(run.createdAt)), cy: y(run[key]), r: 3.5, class: `series-${color} point` });
      const showTooltip = (clientX, clientY) => {
        tooltip.textContent = `${label}: ${format(run[key])} (${run.selectedConclusion})\n${timestamp(run.createdAt)} UTC\n${run.title}`;
        tooltip.hidden = false;
        positionTooltip(clientX, clientY);
      };
      anchor.addEventListener("pointerenter", (event) => showTooltip(event.clientX, event.clientY));
      anchor.addEventListener("pointermove", (event) => positionTooltip(event.clientX, event.clientY));
      anchor.addEventListener("pointerleave", () => { tooltip.hidden = true; });
      anchor.addEventListener("focus", () => {
        const bounds = point.getBoundingClientRect();
        showTooltip(bounds.left + bounds.width / 2, bounds.bottom);
      });
      anchor.addEventListener("blur", () => { tooltip.hidden = true; });
      anchor.addEventListener("keydown", (event) => {
        if (event.key === "Escape") tooltip.hidden = true;
      });
      anchor.append(point);
      svg.append(anchor);
    }
  }
  if (visibleAnnotations.length) container.append(annotationKey);
  container.append(svg, tooltip);
}
