import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
export const root = fileURLToPath(new URL("../", import.meta.url));
export function pythonExecutable() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const local = path.join(
    root,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python3",
  );
  if (existsSync(local)) return local;
  const runtime = path.join(root, ".rag/runtime.json");
  if (existsSync(runtime)) {
    const saved = JSON.parse(readFileSync(runtime, "utf8")).python;
    if (saved && existsSync(saved)) return saved;
  }
  return "python3";
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync(pythonExecutable(), process.argv.slice(2), {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? 1;
}
