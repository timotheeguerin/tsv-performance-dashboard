import { duration, median, milestone } from "./metrics.js";
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

function tickStep(max, count) {
  if (max <= 0) return count ? 1 : 10;
  const rough = max / 5;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find((value) => value * magnitude >= rough) * magnitude;
  return count ? Math.max(1, step) : step;
}

export function drawChart(container, runs, { title, series, count = false, annotation = false, format = duration }) {
  container.replaceChildren();
  const points = runs.filter((run) => series.some(({ key }) => Number.isFinite(run[key])));
  if (!points.length) {
    container.append(element("p", "No complete measurements match these filters.", "empty"));
    return;
  }
  const width = 1100, height = 300;
  const margin = { left: 60, right: 20, top: 32, bottom: 34 };
  const minX = Math.floor(Date.parse(points[0].createdAt) / 86_400_000) * 86_400_000;
  const maxX = Math.floor(Date.parse(points.at(-1).createdAt) / 86_400_000 + 1) * 86_400_000;
  const largest = points.reduce((max, run) => Math.max(max, ...series.map(({ key }) => run[key] ?? 0)), 0);
  const tick = tickStep(largest, count);
  const maxY = Math.max(tick, Math.ceil(largest / tick) * tick);
  const x = (value) => margin.left + (value - minX) / (maxX - minX) * (width - margin.left - margin.right);
  const y = (value) => height - margin.bottom - value / maxY * (height - margin.top - margin.bottom);
  const svg = svgNode("svg", { viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": title });
  svg.append(svgNode("title", {}, `${title}. Individual points link to GitHub runs.`));
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
  const mergeTime = Date.parse(milestone.time);
  if (annotation && mergeTime >= minX && mergeTime <= maxX) {
    const position = x(mergeTime);
    svg.append(svgNode("line", { x1: position, x2: position, y1: margin.top - 8, y2: height - margin.bottom, class: "milestone" }));
    svg.append(svgNode("text", { x: position > width / 2 ? position - 8 : position + 8, y: 16, "text-anchor": position > width / 2 ? "end" : "start", class: "milestone-label" }, "Direct CLI launches merged"));
  }
  for (const { key, label, color, weightKey } of series) {
    const daily = dailySeries(points, key, weightKey);
    svg.append(svgNode("path", { d: daily.map((point, index) => `${index ? "L" : "M"}${x(point.time)},${y(point.value)}`).join(" "), class: `series-${color} trend` }));
    for (const run of points) {
      if (!Number.isFinite(run[key])) continue;
      const tooltip = `${timestamp(run.createdAt)} UTC, ${label}: ${format(run[key])} (${run.selectedConclusion}). ${run.title}`;
      const anchor = svgNode("a", { href: link("", run.url).href, target: "_blank", rel: "noopener noreferrer", "aria-label": tooltip });
      const point = svgNode("circle", { cx: x(Date.parse(run.createdAt)), cy: y(run[key]), r: 3.5, class: `series-${color} point` });
      point.append(svgNode("title", {}, tooltip));
      anchor.append(point);
      svg.append(anchor);
    }
  }
  container.append(svg);
}
