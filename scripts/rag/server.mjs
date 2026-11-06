import { createServer } from "node:http";
import {
  readFileSync,
  existsSync,
  statSync,
  mkdirSync,
  createReadStream,
  readdirSync,
} from "node:fs";
import { timingSafeEqual, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import {
  config,
  root,
  ragDirectory,
  openDatabase,
  readMetadata,
  embed,
} from "./common.mjs";
import { searchIndex } from "./retrieval.mjs";

const settings = config();
if (!settings.token)
  throw new Error(
    "Configure RAG_SERVICE_TOKEN before starting the local knowledge service.",
  );
const execute = promisify(execFile);
const indexFile = path.join(ragDirectory, "nutrition.sqlite");
let database;
let modified = 0;
const renders = new Map();
const verifiedFiles = new Map();
async function verifyFile(document) {
  const file = path.join(root, "RAG", document.name);
  const stat = statSync(file);
  const key = `${document.id}-${stat.size}-${stat.mtimeMs}`;
  if (!verifiedFiles.has(key)) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== document.sha256) return false;
    verifiedFiles.set(key, true);
  }
  return true;
}
function jsonFile(name, fallback) {
  try {
    return JSON.parse(readFileSync(path.join(ragDirectory, name), "utf8"));
  } catch {
    return fallback;
  }
}
function index() {
  if (!existsSync(indexFile)) return null;
  const current = statSync(indexFile).mtimeMs;
  if (!database || modified !== current) {
    database?.close();
    database = openDatabase(indexFile, true);
    modified = current;
  }
  return database;
}
function reply(response, status, data) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(data));
}
const server = createServer(async (request, response) => {
  const authorization = Buffer.from(request.headers.authorization || "");
  const expected = Buffer.from(`Bearer ${settings.token}`);
  if (
    authorization.length !== expected.length ||
    !timingSafeEqual(authorization, expected)
  )
    return reply(response, 401, { error: "Unauthorized" });
  const controller = new AbortController();
  response.on("close", () => {
    if (!response.writableEnded) controller.abort();
  });
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const db = index();
    if (request.method === "GET" && url.pathname === "/status") {
      const documents = db
        ? db.prepare("SELECT id,name,pages,kind FROM documents").all()
        : jsonFile("manifest.json", { documents: [] }).documents.map(
            ({ id, name, pages, kind }) => ({ id, name, pages, kind }),
          );
      const progress = jsonFile("progress.json", null);
      if (progress?.stage === "ocr") {
        progress.completed = documents.reduce((total, document) => {
          const directory = path.join(ragDirectory, "pages", document.id);
          return (
            total +
            (existsSync(directory)
              ? readdirSync(directory).filter((file) =>
                  /^\d{4}\.json$/.test(file),
                ).length
              : 0)
          );
        }, 0);
      }
      return reply(response, 200, {
        ready: Boolean(db && readMetadata(db, "complete")),
        documents,
        pages: documents.reduce((total, doc) => total + doc.pages, 0),
        chunks: db
          ? db.prepare("SELECT count(*) AS count FROM chunks").get().count
          : 0,
        model: db ? readMetadata(db, "model") : settings.embeddingModel,
        dimensions: db ? readMetadata(db, "dimensions") : settings.dimensions,
        builtAt: db ? readMetadata(db, "builtAt") : null,
        emptyPages: db ? readMetadata(db, "emptyPages") : 0,
        progress,
      });
    }
    if (request.method === "POST" && url.pathname === "/search") {
      if (!db)
        return reply(response, 503, {
          error: "营养知识库正在建立，请稍后重试。",
        });
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 4096)
          return reply(response, 413, { error: "Query too large" });
        chunks.push(chunk);
      }
      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(response, 400, { error: "请求格式错误。" });
      }
      const query = parsed?.query;
      if (typeof query !== "string" || !query.trim() || query.length > 500)
        return reply(response, 400, { error: "请输入 1–500 字检索问题。" });
      let vector;
      let mode = "hybrid";
      const embeddingSettings = {
        ...settings,
        embeddingModel: readMetadata(db, "model"),
        dimensions: readMetadata(db, "dimensions"),
      };
      try {
        [vector] = await embed([query], embeddingSettings, controller.signal);
      } catch {
        if (controller.signal.aborted) return;
        mode = "keyword";
      }
      const current = index();
      if (!current)
        return reply(response, 503, { error: "索引正在更新，请重试。" });
      if (
        readMetadata(current, "model") !== embeddingSettings.embeddingModel ||
        readMetadata(current, "dimensions") !== embeddingSettings.dimensions
      ) {
        vector = undefined;
        mode = "keyword";
      }
      const hits = searchIndex(current, query, vector);
      return reply(response, 200, {
        query,
        mode,
        hits,
        warning:
          mode === "keyword" ? "向量服务暂不可用，已使用关键词检索。" : null,
      });
    }
    if (request.method === "GET" && url.pathname === "/page") {
      const id = url.searchParams.get("document");
      const page = Number(url.searchParams.get("page"));
      const document = jsonFile("manifest.json", {
        documents: [],
      }).documents.find((doc) => doc.id === id);
      if (
        !document ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        page > document.pages
      )
        return reply(response, 404, { error: "未找到原始页面。" });
      const file = path.join(ragDirectory, "rendered", `${id}-${page}-v2.png`);
      if (!existsSync(file)) {
        if (!(await verifyFile(document)))
          return reply(response, 409, {
            error: "原始 PDF 已变更，请重新建立索引。",
          });
        const key = `${id}-${page}`;
        if (!renders.has(key)) {
          mkdirSync(path.dirname(file), { recursive: true });
          const python =
            jsonFile("runtime.json", {}).python ||
            path.join(ragDirectory, "venv/bin/python3");
          const operation = execute(
            python,
            [
              path.join(root, "scripts/rag/render.py"),
              path.join(root, "RAG", document.name),
              String(page),
              file,
              path.join(
                ragDirectory,
                "pages",
                id,
                `${String(page).padStart(4, "0")}.json`,
              ),
            ],
            { timeout: 30000 },
          ).finally(() => renders.delete(key));
          renders.set(key, operation);
        }
        await renders.get(key);
      }
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      });
      createReadStream(file).pipe(response);
      return;
    }
    reply(response, 404, { error: "Not found" });
  } catch (error) {
    console.error("RAG request failed:", error.name);
    if (!response.headersSent)
      reply(response, 500, { error: "知识库请求失败，请稍后重试。" });
    else response.end();
  }
});
server.listen(settings.port, "127.0.0.1", () =>
  console.log(`Nutrition RAG listening on 127.0.0.1:${settings.port}`),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () =>
    server.close(() => {
      database?.close();
      process.exit(0);
    }),
  );
