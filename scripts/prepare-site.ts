import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function prepareSite(source: string, destination: string) {
  const files = (await readdir(source)).toSorted();
  const assets = await Promise.all(files.filter((name) => /\.(js|css)$/.test(name)).map(async (name) => ({
    name, content: await readFile(join(source, name)),
  })));
  const hash = createHash("sha256");
  for (const asset of assets) hash.update(asset.name).update("\0").update(asset.content).update("\0");
  const version = hash.digest("hex");
  const assetPath = `assets/${version}`;
  await cp(source, destination, { recursive: true });
  await mkdir(join(destination, assetPath), { recursive: true });
  await Promise.all(assets.map((asset) => writeFile(join(destination, assetPath, asset.name), asset.content)));
  await Promise.all(files.filter((name) => name.endsWith(".html")).map(async (name) => {
    let html = await readFile(join(source, name), "utf8");
    for (const asset of assets) html = html.replaceAll(`"./${asset.name}"`, `"./${assetPath}/${asset.name}"`);
    await writeFile(join(destination, name), html);
  }));
  return version;
}

if (import.meta.main) {
  const version = await prepareSite(
    fileURLToPath(new URL("../public/", import.meta.url)),
    fileURLToPath(new URL("../dist/", import.meta.url)),
  );
  console.log(`Prepared site with asset revision ${version}`);
}
