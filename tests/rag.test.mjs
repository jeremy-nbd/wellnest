import test from "node:test";
import assert from "node:assert/strict";
import {
  openDatabase,
  normalizedVector,
  tokenize,
} from "../scripts/rag/common.mjs";
import { searchIndex } from "../scripts/rag/retrieval.mjs";

test("hybrid retrieval preserves physical PDF page and exact source text", () => {
  const db = openDatabase(":memory:");
  try {
    db.prepare("INSERT INTO documents VALUES(?,?,?,?,?)").run(
      "doc",
      "营养资料.pdf",
      20,
      "reference",
      "digest",
    );
    const insert = db.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?)");
    for (const [id, page, text, vector] of [
      ["a", 12, "蔬菜推荐摄入量", [1, 0]],
      ["b", 13, "运动安排", [0, 1]],
    ]) {
      insert.run(
        id,
        "doc",
        page,
        0,
        text,
        0.9,
        Buffer.from(normalizedVector(vector).buffer),
      );
      db.prepare("INSERT INTO chunks_fts VALUES(?,?)").run(
        id,
        tokenize(text).join(" "),
      );
    }
    const hits = searchIndex(db, "蔬菜", [1, 0]);
    assert.equal(hits[0].page, 12);
    assert.equal(hits[0].text, "蔬菜推荐摄入量");
    assert.equal(hits[0].filename, "营养资料.pdf");
    assert.equal(searchIndex(db, "运动", null)[0].id, "b");
    assert.deepEqual(searchIndex(db, "zzunknown", null), []);
    assert.deepEqual(searchIndex(db, '";DROP TABLE chunks;--', null), []);
    assert.throws(() => searchIndex(db, "蔬菜", [1, 0, 0]), /dimensions/);
  } finally {
    db.close();
  }
});
test("Chinese nutrient single characters are searchable", () => {
  assert.ok(tokenize("钙参考摄入量").includes("钙"));
  assert.ok(tokenize("食物蛋白质").includes("蛋白"));
  assert.throws(() => normalizedVector([0, 0]), /Invalid/);
});

import { pageRows } from "../scripts/rag/layout.mjs";
test("rotated scan coordinates keep table food names and values on the same row", () => {
  const rows = pageRows({
    width: 100,
    height: 200,
    lines: [
      { text: "鸡蛋", x: 0.1, y: 0.7, width: 0.02, height: 0.1 },
      { text: "蛋白质", x: 0.05, y: 0.4, width: 0.02, height: 0.1 },
      { text: "12.3", x: 0.1, y: 0.4, width: 0.02, height: 0.1 },
    ],
  });
  assert.deepEqual(rows, ["蛋白质", "鸡蛋 | 12.3"]);
});
