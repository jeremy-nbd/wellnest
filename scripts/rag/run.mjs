import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { root, ragDirectory } from "./common.mjs";
const [command, ...args] = process.argv.slice(2);
const runtimeFile = path.join(ragDirectory, "runtime.json");
let python = existsSync(runtimeFile)
  ? JSON.parse(readFileSync(runtimeFile, "utf8")).python
  : path.join(ragDirectory, "venv/bin/python3");
function run(binary, args) {
  const result = spawnSync(binary, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (command === "setup") {
  mkdirSync(ragDirectory, { recursive: true });
  python = path.join(ragDirectory, "venv/bin/python3");
  run(process.env.PYTHON || "python3", [
    "-m",
    "venv",
    path.join(ragDirectory, "venv"),
  ]);
  run(python, ["-m", "pip", "install", "-r", "scripts/rag/requirements.txt"]);
  writeFileSync(runtimeFile, JSON.stringify({ python }));
} else if (command === "extract") {
  run(python, ["scripts/rag/extract.py", ...args]);
} else throw new Error("Expected setup or extract");
