import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const ragDirectory = path.join(root, ".rag");
export function config() {
  const file = path.join(root, ".dev.vars");
  const values = {
    ...(existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}),
    ...process.env,
  };
  return {
    apiKey: values.LLM_API_KEY || "",
    baseUrl: (
      values.LLM_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1"
    ).replace(/\/$/, ""),
    embeddingModel: values.RAG_EMBEDDING_MODEL || "text-embedding-v4",
    dimensions: Number(values.RAG_EMBEDDING_DIMENSIONS || 512),
    token: values.RAG_SERVICE_TOKEN || "",
    port: Number(values.RAG_PORT || 3011),
  };
}
export function openDatabase(file, readonly = false) {
  const database = new DatabaseSync(file, { readOnly: readonly });
  database.exec("PRAGMA busy_timeout=5000");
  if (!readonly)
    database.exec(`
    CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, name TEXT NOT NULL, pages INTEGER NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, page INTEGER NOT NULL, ordinal INTEGER NOT NULL, text TEXT NOT NULL, confidence REAL NOT NULL, embedding BLOB);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, terms);
  `);
  return database;
}
export function tokenize(text) {
  const normalized = text.normalize("NFKC").toLowerCase();
  const tokens = normalized.match(/[a-z][a-z0-9]+|\d+(?:\.\d+)?/g) || [];
  for (const run of normalized.match(/[\u3400-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2));
    for (const char of run)
      if ("钙铁锌碘硒钠钾镁磷铜锰氟铬盐糖油奶蛋".includes(char))
        tokens.push(char);
  }
  return tokens;
}
export function normalizedVector(values) {
  const vector = Float32Array.from(values);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm || !Number.isFinite(norm))
    throw new Error("Invalid embedding vector");
  return vector.map((value) => value / norm);
}
export async function embed(texts, settings, signal) {
  const response = await fetch(`${settings.baseUrl}/embeddings`, {
    method: "POST",
    signal: AbortSignal.any([
      signal || new AbortController().signal,
      AbortSignal.timeout(60000),
    ]),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.embeddingModel,
      input: texts,
      dimensions: settings.dimensions,
      encoding_format: "float",
    }),
  });
  if (!response.ok)
    throw new Error(`Embedding request failed (HTTP ${response.status})`);
  const body = await response.json();
  const entries = body.data?.slice().sort((a, b) => a.index - b.index);
  if (entries?.length !== texts.length)
    throw new Error("Embedding response length mismatch");
  return entries.map((entry, i) => {
    if (
      entry.index !== i ||
      entry.embedding?.length !== settings.dimensions ||
      !entry.embedding.every(Number.isFinite)
    )
      throw new Error("Invalid embedding response");
    return normalizedVector(entry.embedding);
  });
}
export function readMetadata(database, key) {
  const record = database
    .prepare("SELECT value FROM metadata WHERE key=?")
    .get(key);
  return record ? JSON.parse(record.value) : null;
}
export function writeMetadata(database, key, value) {
  database
    .prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)")
    .run(key, JSON.stringify(value));
}
