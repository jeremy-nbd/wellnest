"""Hybrid retrieval over the existing SQLite/FTS5 and float32 index format."""

import asyncio
import hashlib
import json
import math
import re
import sqlite3
import struct
import sys
import unicodedata
from contextlib import closing

from .provider import ProviderError


def tokenize(text):
    normalized = unicodedata.normalize("NFKC", text).lower()
    tokens = re.findall(r"[a-z][a-z0-9]+|\d+(?:\.\d+)?", normalized)
    for run in re.findall(r"[\u3400-\u9fff]+", normalized):
        tokens.extend(run[i : i + 2] for i in range(len(run) - 1))
        tokens.extend(
            char for char in run if char in "钙铁锌碘硒钠钾镁磷铜锰氟铬盐糖油奶蛋"
        )
    return tokens


def normalized_vector(values):
    if not values or not all(
        isinstance(v, (int, float)) and math.isfinite(v) for v in values
    ):
        raise ValueError("Invalid embedding vector")
    norm = math.sqrt(sum(v * v for v in values))
    if not norm:
        raise ValueError("Invalid embedding vector")
    return [v / norm for v in values]


def metadata(db, key):
    row = db.execute("SELECT value FROM metadata WHERE key=?", (key,)).fetchone()
    return json.loads(row[0]) if row else None


def open_database(file, readonly=True):
    db = (
        sqlite3.connect(f"file:{file}?mode=ro", uri=True)
        if readonly
        else sqlite3.connect(file)
    )
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=5000")
    return db


def read_json(file, fallback):
    try:
        return json.loads(file.read_text())
    except (OSError, ValueError):
        return fallback


async def embed(texts, settings, client, model=None, dimensions=None):
    dimensions = dimensions or settings.dimensions
    async with asyncio.timeout(60):
        response = await client.post(
            settings.base_url + "/embeddings",
            headers={"Authorization": "Bearer " + settings.api_key},
            json=dict(
                model=model or settings.embedding_model,
                input=texts,
                dimensions=dimensions,
                encoding_format="float",
            ),
            timeout=60,
        )
    if response.is_error:
        raise ProviderError(f"Embedding request failed (HTTP {response.status_code})")
    entries = sorted(response.json()["data"], key=lambda entry: entry["index"])
    if len(entries) != len(texts):
        raise ValueError("Embedding response length mismatch")
    for i, entry in enumerate(entries):
        if entry["index"] != i or len(entry["embedding"]) != dimensions:
            raise ValueError("Invalid embedding response")
    return [normalized_vector(entry["embedding"]) for entry in entries]


def search_index(db, query, vector=None, limit=5):
    terms = list(dict.fromkeys(tokenize(query)))[:50]
    lexical = (
        db.execute(
            "SELECT id,bm25(chunks_fts) AS score FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY score LIMIT 40",
            (" OR ".join('"' + term.replace('"', '""') + '"' for term in terms),),
        ).fetchall()
        if terms
        else []
    )
    scores = {
        row["id"]: dict(
            id=row["id"], score=1 / (51 + i), lexicalRank=i + 1, cosine=None
        )
        for i, row in enumerate(lexical)
    }
    if vector:
        query_vector = normalized_vector(vector)
        semantic = []
        for row in db.execute(
            "SELECT id,embedding FROM chunks WHERE embedding IS NOT NULL"
        ):
            stored = struct.unpack(
                "<" + "f" * (len(row["embedding"]) // 4), row["embedding"]
            )
            if len(stored) != len(query_vector):
                raise ValueError("Embedding dimensions do not match index")
            cosine = sum(a * b for a, b in zip(stored, query_vector))
            if cosine >= 0.28:
                semantic.append((row["id"], cosine))
        semantic.sort(key=lambda row: row[1], reverse=True)
        for i, (identifier, cosine) in enumerate(semantic[:40]):
            item = scores.setdefault(
                identifier, dict(id=identifier, score=0, lexicalRank=None)
            )
            item.update(cosine=cosine, score=item["score"] + 1 / (51 + i))
    pages = {}
    hits = []
    for ranked in sorted(scores.values(), key=lambda row: row["score"], reverse=True):
        row = db.execute(
            "SELECT c.*,d.name,d.kind FROM chunks c JOIN documents d ON d.id=c.document_id WHERE c.id=?",
            (ranked["id"],),
        ).fetchone()
        page_key = (row["document_id"], row["page"])
        if pages.get(page_key, 0) >= 2:
            continue
        pages[page_key] = pages.get(page_key, 0) + 1
        hits.append(
            dict(
                **ranked,
                documentId=row["document_id"],
                filename=row["name"],
                page=row["page"],
                text=row["text"],
                confidence=row["confidence"],
                kind=row["kind"],
                extraction="本地 OCR；具体数值与表格对应关系请核对原页",
            )
        )
        if len(hits) == limit:
            break
    return hits


class KnowledgeBase:
    def __init__(self, settings, client):
        self.settings = settings
        self.client = client
        self.directory = settings.rag_directory
        self.index_file = self.directory / "nutrition.sqlite"
        self.render_locks = {}

    def ready(self):
        return self.index_file.is_file()

    def status(self):
        manifest = read_json(self.directory / "manifest.json", {"documents": []})
        documents = [
            {k: d[k] for k in ["id", "name", "pages", "kind"]}
            for d in manifest["documents"]
        ]
        result = dict(
            ready=False,
            documents=documents,
            chunks=0,
            model=self.settings.embedding_model,
            dimensions=self.settings.dimensions,
            builtAt=None,
            emptyPages=0,
        )
        if self.ready():
            with closing(open_database(self.index_file)) as db:
                result.update(
                    ready=bool(metadata(db, "complete")),
                    documents=[
                        dict(row)
                        for row in db.execute(
                            "SELECT id,name,pages,kind FROM documents"
                        )
                    ],
                    chunks=db.execute("SELECT count(*) FROM chunks").fetchone()[0],
                )
                for key in ["model", "dimensions", "builtAt", "emptyPages"]:
                    result[key] = metadata(db, key)
        progress = read_json(self.directory / "progress.json", None)
        if progress and progress.get("stage") == "ocr":
            progress["completed"] = sum(
                len(
                    list(
                        (self.directory / "pages" / d["id"]).glob(
                            "[0-9][0-9][0-9][0-9].json"
                        )
                    )
                )
                for d in result["documents"]
            )
        return dict(
            result,
            pages=sum(d["pages"] for d in result["documents"]),
            progress=progress,
        )

    async def search(self, query):
        if not self.ready():
            raise ProviderError("营养 PDF 知识库尚未就绪，暂时无法提供文献依据。")
        with closing(open_database(self.index_file)) as db:
            model, dimensions = metadata(db, "model"), metadata(db, "dimensions")
        vector = None
        mode = "hybrid"
        try:
            vector = (
                await embed([query], self.settings, self.client, model, dimensions)
            )[0]
        except Exception:
            mode = "keyword"

        def retrieve():
            # Each request opens the currently published file. Atomic rebuilds cannot
            # close another request's connection or mix embeddings between versions.
            with closing(open_database(self.index_file)) as db:
                compatible = (
                    metadata(db, "model") == model
                    and metadata(db, "dimensions") == dimensions
                )
                return search_index(
                    db, query, vector if compatible else None
                ), compatible

        hits, compatible = await asyncio.to_thread(retrieve)
        if not compatible:
            mode = "keyword"
        return dict(
            query=query,
            mode=mode,
            hits=hits,
            warning="向量服务暂不可用，已使用关键词检索。"
            if mode == "keyword"
            else None,
        )

    async def page(self, identifier, page):
        if not re.fullmatch(r"[a-f0-9]{16}", identifier):
            raise ProviderError("未找到原始页面。")
        with closing(open_database(self.index_file)) as db:
            row = db.execute(
                "SELECT * FROM documents WHERE id=?", (identifier,)
            ).fetchone()
        if row is None or page < 1 or page > row["pages"]:
            raise ProviderError("未找到原始页面。")
        document = dict(row)
        pdf = (self.settings.root / "RAG" / document["name"]).resolve()
        if pdf.parent != (self.settings.root / "RAG").resolve():
            raise ProviderError("未找到原始页面。")
        output = self.directory / "rendered" / f"{identifier}-{page}-v2.png"
        lock = self.render_locks.setdefault((identifier, page), asyncio.Lock())
        async with lock:

            def verify():
                with pdf.open("rb") as handle:
                    return (
                        hashlib.file_digest(handle, "sha256").hexdigest()
                        == document["sha256"]
                    )

            if not await asyncio.to_thread(verify):
                raise ProviderError("原始 PDF 已变更，请重新建立索引。")
            if output.exists():
                return output
            output.parent.mkdir(parents=True, exist_ok=True)
            process = await asyncio.create_subprocess_exec(
                sys.executable,
                str(self.settings.root / "scripts/rag/render.py"),
                str(pdf),
                str(page),
                str(output),
                str(self.directory / "pages" / identifier / f"{page:04d}.json"),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                async with asyncio.timeout(30):
                    code = await process.wait()
                if code:
                    raise ProviderError("原页暂时无法读取，请保留数值待核对说明。")
            finally:
                if process.returncode is None:
                    process.kill()
                    await process.wait()
            return output
