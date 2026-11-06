import { tokenize, normalizedVector } from "./common.mjs";

export function searchIndex(database, query, queryVector, limit = 5) {
  const terms = [...new Set(tokenize(query))].slice(0, 50);
  const lexical = terms.length
    ? database
        .prepare(
          "SELECT id,bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT 40",
        )
        .all(
          terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR "),
        )
    : [];
  const scores = new Map();
  lexical.forEach((row, index) =>
    scores.set(row.id, {
      id: row.id,
      score: 1 / (50 + index + 1),
      lexicalRank: index + 1,
      cosine: null,
    }),
  );
  if (queryVector) {
    const vector = normalizedVector(queryVector);
    const semantic = database
      .prepare("SELECT id,embedding FROM chunks WHERE embedding IS NOT NULL")
      .all()
      .map((row) => {
        const buffer = row.embedding;
        const stored = new Float32Array(
          buffer.buffer.slice(
            buffer.byteOffset,
            buffer.byteOffset + buffer.byteLength,
          ),
        );
        if (stored.length !== vector.length)
          throw new Error("Embedding dimensions do not match index");
        let cosine = 0;
        for (let i = 0; i < stored.length; i++) cosine += stored[i] * vector[i];
        return { id: row.id, cosine };
      })
      .filter((row) => row.cosine >= 0.28)
      .sort((a, b) => b.cosine - a.cosine)
      .slice(0, 40);
    semantic.forEach((row, index) => {
      const existing = scores.get(row.id) || {
        id: row.id,
        score: 0,
        lexicalRank: null,
      };
      scores.set(row.id, {
        ...existing,
        cosine: row.cosine,
        score: existing.score + 1 / (50 + index + 1),
      });
    });
  }
  const get = database.prepare(
    "SELECT c.*,d.name,d.kind FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.id=?",
  );
  const pages = new Map();
  const hits = [];
  for (const ranked of [...scores.values()].sort((a, b) => b.score - a.score)) {
    const row = get.get(ranked.id);
    const pageKey = `${row.document_id}-${row.page}`;
    if ((pages.get(pageKey) || 0) >= 2) continue;
    pages.set(pageKey, (pages.get(pageKey) || 0) + 1);
    hits.push({
      id: row.id,
      documentId: row.document_id,
      filename: row.name,
      page: row.page,
      text: row.text,
      confidence: row.confidence,
      kind: row.kind,
      score: ranked.score,
      cosine: ranked.cosine,
      lexicalRank: ranked.lexicalRank,
      extraction: "本地 OCR；具体数值与表格对应关系请核对原页",
    });
    if (hits.length === limit) break;
  }
  return hits;
}
