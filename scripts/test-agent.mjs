import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
const directory = new URL("../work/tests/", import.meta.url);
await mkdir(directory, { recursive: true });
const output = new URL("orchestrator.test.mjs", directory);
await build({
  entryPoints: ["tests/orchestrator.test.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: output.pathname,
});
const result = spawnSync(process.execPath, ["--test", output.pathname, "tests/rag.test.mjs"], {
  stdio: "inherit",
});
await rm(output, { force: true });
process.exitCode = result.status ?? 1;
