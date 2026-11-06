import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { root, pythonExecutable } from "../python.mjs";
const ragDirectory = path.join(root, ".rag");
const [command, ...args] = process.argv.slice(2);
const runtimeFile = path.join(ragDirectory, "runtime.json");
let python = pythonExecutable();
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
  run(python, [
    "-m",
    "pip",
    "install",
    "-r",
    "scripts/rag/requirements.txt",
    "-r",
    "backend/requirements.txt",
  ]);
  writeFileSync(runtimeFile, JSON.stringify({ python }));
} else if (command === "extract") {
  run(python, ["scripts/rag/extract.py", ...args]);
} else throw new Error("Expected setup or extract");
