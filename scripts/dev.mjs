import { spawn } from "node:child_process";
import { config } from "./rag/common.mjs";
const settings = config();
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}
function start(file, args = []) {
  const child = spawn(process.execPath, [file, ...args], { stdio: "inherit" });
  children.push(child);
  child.on("error", (error) => {
    console.error(error.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code || 0);
  });
  return child;
}
if (settings.token) {
  let running = false;
  try {
    const result = await fetch(`http://127.0.0.1:${settings.port}/status`, {
      headers: { Authorization: `Bearer ${settings.token}` },
      signal: AbortSignal.timeout(1000),
    });
    running = result.ok;
  } catch {
    /* Start a new service when the configured port is free. */
  }
  if (!running) start("scripts/rag/server.mjs");
}
start("scripts/run-framework.mjs", ["dev", ...process.argv.slice(2)]);
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
