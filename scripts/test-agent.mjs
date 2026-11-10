import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, rm } from "node:fs/promises";
const directory = new URL("../work/tests/", import.meta.url);
await mkdir(directory, { recursive: true });
const output = new URL("intake.test.mjs", directory);
await build({
  entryPoints: ["tests/intake.test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: fileURLToPath(output),
});
const result = spawnSync(process.execPath, ["--test", fileURLToPath(output)], {
  stdio: "inherit",
});
await rm(output, { force: true });
process.exitCode = result.status ?? 1;
