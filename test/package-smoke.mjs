import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, npm_config_registry: "https://registry.npmjs.org" },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const projectRoot = resolve(import.meta.dirname, "..");
const projectPackage = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
const temp = await mkdtemp(join(tmpdir(), "eve-cls-package-"));
let tarball;
try {
  const pack = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json"], projectRoot));
  assert.equal(pack.length, 1);
  tarball = join(projectRoot, pack[0].filename);
  const files = pack[0].files.map((entry) => entry.path);
  assert.ok(files.includes("dist/index.js"));
  assert.ok(files.includes("dist/index.d.ts"));
  assert.equal(files.some((file) => file.startsWith("src/") || file.startsWith("test/")), false);

  await writeFile(join(temp, "package.json"), JSON.stringify({ type: "module", private: true }));
  run(
    "npm",
    ["install", "--ignore-scripts", `file:${tarball}`, "eve@0.56.0"],
    temp,
  );
  await writeFile(
    join(temp, "consumer.mjs"),
    'import { createRequire } from "node:module";\nimport { clsObservability } from "eve-cls-observability";\nif (typeof clsObservability !== "function") throw new Error("missing export");\nconst pkg=createRequire(import.meta.url)("eve-cls-observability/package.json");\nif (pkg.version !== "0.2.0") throw new Error(`wrong version: ${pkg.version}`);\n',
  );
  run("node", ["consumer.mjs"], temp);

  const installed = JSON.parse(
    await readFile(join(temp, "node_modules/eve-cls-observability/package.json"), "utf8"),
  );
  assert.equal(installed.version, projectPackage.version);
} finally {
  if (tarball !== undefined) await rm(tarball, { force: true });
  await rm(temp, { recursive: true, force: true });
}
