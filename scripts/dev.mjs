import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { parseEnv } from "node:util";
import { randomBytes } from "node:crypto";
import { root, pythonExecutable } from "./python.mjs";
const settings = {
  ...(existsSync(".dev.vars")
    ? parseEnv(readFileSync(".dev.vars", "utf8"))
    : {}),
  ...process.env,
};
const base = settings.BACKEND_SERVICE_URL || "http://127.0.0.1:3012";
const token =
  settings.BACKEND_SERVICE_TOKEN ||
  settings.RAG_SERVICE_TOKEN ||
  randomBytes(32).toString("hex");
const environment = {
  ...settings,
  BACKEND_SERVICE_URL: base,
  BACKEND_SERVICE_TOKEN: token,
};
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
function start(binary, args) {
  const child = spawn(binary, args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code || 0);
  });
}
async function healthy() {
  try {
    const response = await fetch(base + "/health", {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1000),
    });
    return response.ok && (await response.json()).service === "wellnest-python";
  } catch {
    return false;
  }
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
if (!(await healthy())) {
  const url = new URL(base);
  if (!["localhost", "127.0.0.1"].includes(url.hostname))
    throw new Error("Configured remote Python backend is unavailable.");
  start(pythonExecutable(), [
    "-m",
    "uvicorn",
    "backend.wellnest.api:app",
    "--host",
    "127.0.0.1",
    "--port",
    url.port || "3012",
    "--no-access-log",
  ]);
  let ready = false;
  for (let attempt = 0; attempt < 40 && !stopping; attempt++) {
    if (await healthy()) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) {
    console.error(
      "Python 后端启动失败，请安装 backend/requirements.txt 中的依赖。",
    );
    stop(1);
  }
}
if (!stopping)
  start(process.execPath, [
    "scripts/run-framework.mjs",
    "dev",
    ...process.argv.slice(2),
  ]);
