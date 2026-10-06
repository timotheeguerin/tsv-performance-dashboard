import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareSite } from "../scripts/prepare-site.ts";

test("published HTML loads a versioned asset graph while data and source files stay unchanged", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "tsv-site-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "public");
  const destination = join(directory, "dist");
  await mkdir(join(source, "data"), { recursive: true });
  const files = {
    "index.html": '<link href="./styles.css"><script type="module" src="./app.js"></script>',
    "regular.html": '<link href="./styles.css"><script type="module" src="./regular.js"></script>',
    "app.js": 'import { value } from "./metrics.js"; import "./chart.js";',
    "regular.js": 'import { value } from "./metrics.js";',
    "chart.js": 'import { value } from "./metrics.js";',
    "metrics.js": "export const value = 1;",
    "styles.css": "body { color: black; }",
    "data/workflow.json": '{"runs":[]}',
  };
  await Promise.all(Object.entries(files).map(([name, content]) => writeFile(join(source, name), content)));
  const version = await prepareSite(source, destination);
  assert.match(version, /^[a-f0-9]{64}$/);
  for (const [name, content] of Object.entries(files)) {
    assert.equal(await readFile(join(source, name), "utf8"), content);
    if (/\.(js|css)$/.test(name)) {
      assert.equal(await readFile(join(destination, "assets", version, name), "utf8"), content);
    }
  }
  for (const [name, entry] of [["index.html", "app.js"], ["regular.html", "regular.js"]]) {
    const html = await readFile(join(destination, name), "utf8");
    assert.ok(html.includes(`src="./assets/${version}/${entry}"`));
    assert.ok(html.includes(`href="./assets/${version}/styles.css"`));
  }
  assert.equal(await readFile(join(destination, "data/workflow.json"), "utf8"), files["data/workflow.json"]);
  assert.equal(await prepareSite(source, destination), version);
  await writeFile(join(source, "data/workflow.json"), '{"runs":[{"id":1}]}');
  assert.equal(await prepareSite(source, destination), version);
  for (const name of ["metrics.js", "styles.css", "app.js"] as const) {
    await writeFile(join(source, name), `${files[name]}\n`);
    const updated = await prepareSite(source, destination);
    assert.notEqual(updated, version);
    assert.ok((await readFile(join(destination, "index.html"), "utf8")).includes(`/assets/${updated}/app.js`));
    await writeFile(join(source, name), files[name]);
  }
});
