import {
  readFile,
  writeFile,
  rename,
  mkdir,
  unlink,
  copyFile,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  config,
  ragDirectory,
  openDatabase,
  tokenize,
  embed,
  readMetadata,
  writeMetadata,
} from "./common.mjs";

import { pageRows } from "./layout.mjs";

const settings = config();
if (!settings.apiKey) throw new Error("Configure LLM_API_KEY before indexing.");
await mkdir(ragDirectory, { recursive: true });
const lockFile = path.join(ragDirectory, "index.lock");
try {
  await writeFile(lockFile, String(process.pid), { flag: "wx" });
} catch {
  throw new Error(
    "An indexing process is already active. Remove .rag/index.lock only after confirming it has stopped.",
  );
}
let database;
try {
  const manifest = JSON.parse(
    await readFile(path.join(ragDirectory, "manifest.json"), "utf8"),
  );
  const buildFile = path.join(ragDirectory, "nutrition-next.sqlite");
  try {
    await copyFile(path.join(ragDirectory, "nutrition.sqlite"), buildFile, 1);
  } catch (error) {
    if (!["ENOENT", "EEXIST"].includes(error.code)) throw error;
  }
  database = openDatabase(buildFile);
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        manifest,
        model: settings.embeddingModel,
        dimensions: settings.dimensions,
        format: 2,
      }),
    )
    .digest("hex");
  const previous = readMetadata(database, "fingerprint");
  if (previous && previous !== fingerprint) {
    database.exec(
      "DELETE FROM documents; DELETE FROM chunks; DELETE FROM chunks_fts; DELETE FROM metadata;",
    );
  }
  writeMetadata(database, "fingerprint", fingerprint);
  writeMetadata(database, "model", settings.embeddingModel);
  writeMetadata(database, "dimensions", settings.dimensions);
  const insert = database.prepare(
    "INSERT OR IGNORE INTO chunks(id,document_id,page,ordinal,text,confidence) VALUES(?,?,?,?,?,?)",
  );
  const retainedIds = new Set();
  const existingChunk = database.prepare("SELECT text FROM chunks WHERE id=?");
  const refreshChunk = database.prepare(
    "UPDATE chunks SET text=?,confidence=?,embedding=NULL WHERE id=?",
  );
  const removeTerms = database.prepare("DELETE FROM chunks_fts WHERE id=?");
  let emptyPages = 0;
  let sparsePages = 0;
  database.exec("BEGIN");
  for (const document of manifest.documents) {
    database
      .prepare(
        "INSERT OR REPLACE INTO documents(id,name,pages,kind,sha256) VALUES(?,?,?,?,?)",
      )
      .run(
        document.id,
        document.name,
        document.pages,
        document.kind,
        document.sha256,
      );
    for (let pageNumber = 1; pageNumber <= document.pages; pageNumber++) {
      const pagePath = path.join(
        ragDirectory,
        "pages",
        document.id,
        `${String(pageNumber).padStart(4, "0")}.json`,
      );
      const page = JSON.parse(await readFile(pagePath, "utf8"));
      const lines = page.lines.filter((line) => line.text.trim());
      if (!lines.length) {
        emptyPages++;
        continue;
      }
      if (lines.reduce((total, line) => total + line.text.length, 0) < 20) {
        sparsePages++;
        continue;
      }
      const rowTexts = pageRows(page);
      const header =
        document.kind === "table" ? rowTexts.slice(0, 4).join("\n") : "";
      const confidence =
        lines.reduce((sum, line) => sum + line.confidence, 0) / lines.length;
      let start = 0;
      let ordinal = 0;
      while (start < rowTexts.length) {
        let end = start;
        let length = 0;
        while (end < rowTexts.length && (length < 900 || end === start)) {
          length += rowTexts[end].length + 1;
          end++;
        }
        const text = `${start > 0 && header ? header + "\n" : ""}${rowTexts.slice(start, end).join("\n")}`;
        const id = `${document.id}-${pageNumber}-${ordinal++}`;
        retainedIds.add(id);
        const existing = existingChunk.get(id);
        const created = insert.run(
          id,
          document.id,
          pageNumber,
          ordinal,
          text,
          confidence,
        );
        const changed = existing && existing.text !== text;
        if (changed) {
          refreshChunk.run(text, confidence, id);
          removeTerms.run(id);
        }
        if (created.changes || changed)
          database
            .prepare("INSERT INTO chunks_fts(id,terms) VALUES(?,?)")
            .run(id, tokenize(`${document.name}\n${text}`).join(" "));
        if (end === rowTexts.length) break;
        start = Math.max(start + 1, end - 2);
      }
    }
    console.log(`Prepared ${document.name} (${document.pages} pages)`);
  }
  const removeChunk = database.prepare("DELETE FROM chunks WHERE id=?");
  for (const row of database.prepare("SELECT id FROM chunks").all()) {
    if (!retainedIds.has(row.id)) {
      removeChunk.run(row.id);
      removeTerms.run(row.id);
    }
  }
  database.exec("COMMIT");
  const pending = database
    .prepare(
      "SELECT c.id,c.text,d.name FROM chunks c JOIN documents d ON d.id=c.document_id WHERE embedding IS NULL",
    )
    .all();
  const total = database
    .prepare("SELECT count(*) AS count FROM chunks")
    .get().count;
  const update = database.prepare("UPDATE chunks SET embedding=? WHERE id=?");
  let position = 0;
  let embedded = total - pending.length;
  const progress = async () =>
    writeFile(
      path.join(ragDirectory, "progress.json"),
      JSON.stringify({ stage: "embedding", completed: embedded, total }),
    );
  await progress();
  async function worker() {
    while (position < pending.length) {
      const batch = pending.slice(position, position + 10);
      position += batch.length;
      let vectors;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          vectors = await embed(
            batch.map((row) => `${row.name}\n${row.text}`),
            settings,
          );
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 1500 * (attempt + 1)),
          );
        }
      }
      database.exec("BEGIN");
      try {
        batch.forEach((row, i) =>
          update.run(Buffer.from(vectors[i].buffer), row.id),
        );
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      embedded += batch.length;
      if (embedded % 100 < 10 || embedded === total) {
        console.log(`Embedded ${embedded}/${total}`);
        await progress();
      }
    }
  }
  const workers = await Promise.allSettled([worker(), worker(), worker()]);
  const failure = workers.find((result) => result.status === "rejected");
  if (failure) throw failure.reason;
  writeMetadata(database, "builtAt", new Date().toISOString());
  writeMetadata(database, "emptyPages", emptyPages);
  writeMetadata(database, "sparsePages", sparsePages);
  writeMetadata(database, "complete", true);
  database.close();
  database = null;
  await rename(buildFile, path.join(ragDirectory, "nutrition.sqlite"));
  await writeFile(
    path.join(ragDirectory, "progress.json"),
    JSON.stringify({ stage: "ready", completed: total, total }),
  );
  console.log(
    `Nutrition index ready: ${manifest.documents.length} documents, ${total} chunks, ${settings.dimensions} dimensions.`,
  );
} finally {
  database?.close();
  await unlink(lockFile);
}
