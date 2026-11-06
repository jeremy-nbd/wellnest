"""Resumable, atomic nutrition indexing with the legacy page/chunk format."""

import asyncio
import hashlib
import json
import os
import shutil
import struct
from datetime import UTC, datetime

import httpx

from .config import Settings
from .rag import embed, metadata, open_database, tokenize


def page_rows(page):
    lines = [line for line in page["lines"] if line["text"].strip()]
    vertical = sum(
        line["height"] * page["height"] > line["width"] * page["width"] * 1.5
        for line in lines
    )
    if lines and vertical / len(lines) > 0.5:
        lines = [
            {
                **line,
                "x": 1 - line["y"] - line["height"],
                "y": line["x"],
                "width": line["height"],
                "height": line["width"],
            }
            for line in lines
        ]
    rows = []
    for line in sorted(lines, key=lambda item: item["y"]):
        center = line["y"] + line["height"] / 2
        row = next(
            (
                row
                for row in rows
                if abs(row["center"] - center) < min(line["height"] * 0.45, 0.009)
            ),
            None,
        )
        if row is None:
            rows.append(dict(center=center, items=[line]))
        else:
            row["items"].append(line)
    return [
        " | ".join(
            item["text"] for item in sorted(row["items"], key=lambda item: item["x"])
        )
        for row in sorted(rows, key=lambda row: row["center"])
    ]


def write_metadata(db, key, value):
    db.execute(
        "INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)",
        (key, json.dumps(value, ensure_ascii=False)),
    )


def write_progress(directory, value):
    temporary = directory / "progress-next.json"
    temporary.write_text(json.dumps(value))
    temporary.replace(directory / "progress.json")


async def build_index(settings):
    directory = settings.rag_directory
    directory.mkdir(parents=True, exist_ok=True)
    lock = directory / "index.lock"
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        raise RuntimeError(
            "索引任务已运行。确认旧进程已停止后才可移除 .rag/index.lock。"
        ) from error
    with os.fdopen(descriptor, "w") as handle:
        handle.write(str(os.getpid()))
    db = None
    try:
        manifest = json.loads((directory / "manifest.json").read_text())
        published = directory / "nutrition.sqlite"
        building = directory / "nutrition-next.sqlite"
        if published.exists() and not building.exists():
            shutil.copyfile(published, building)
        db = open_database(building, readonly=False)
        db.executescript("""
            CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,name TEXT NOT NULL,pages INTEGER NOT NULL,kind TEXT NOT NULL,sha256 TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,page INTEGER NOT NULL,ordinal INTEGER NOT NULL,text TEXT NOT NULL,confidence REAL NOT NULL,embedding BLOB);
            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED,terms);
        """)
        fingerprint = hashlib.sha256(
            json.dumps(
                dict(
                    manifest=manifest,
                    model=settings.embedding_model,
                    dimensions=settings.dimensions,
                    format=2,
                ),
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        # Preserve embeddings across the language migration. Model/dimension changes
        # invalidate vectors; changed OCR text is handled independently below.
        reset_vectors = (
            metadata(db, "model") != settings.embedding_model
            or metadata(db, "dimensions") != settings.dimensions
        )
        with db:
            if reset_vectors:
                db.execute("UPDATE chunks SET embedding=NULL")
            write_metadata(db, "fingerprint", fingerprint)
            write_metadata(db, "model", settings.embedding_model)
            write_metadata(db, "dimensions", settings.dimensions)
            write_metadata(db, "complete", False)
            retained = set()
            empty_pages = sparse_pages = 0
            db.execute("DELETE FROM documents")
            for document in manifest["documents"]:
                db.execute(
                    "INSERT INTO documents VALUES(?,?,?,?,?)",
                    tuple(
                        document[key]
                        for key in ["id", "name", "pages", "kind", "sha256"]
                    ),
                )
                for number in range(1, document["pages"] + 1):
                    page = json.loads(
                        (
                            directory / "pages" / document["id"] / f"{number:04d}.json"
                        ).read_text()
                    )
                    lines = [line for line in page["lines"] if line["text"].strip()]
                    if not lines:
                        empty_pages += 1
                        continue
                    if sum(len(line["text"]) for line in lines) < 20:
                        sparse_pages += 1
                        continue
                    rows = page_rows(page)
                    header = "\n".join(rows[:4]) if document["kind"] == "table" else ""
                    confidence = sum(line["confidence"] for line in lines) / len(lines)
                    start = ordinal = 0
                    while start < len(rows):
                        end = start
                        length = 0
                        while end < len(rows) and (length < 900 or end == start):
                            length += len(rows[end]) + 1
                            end += 1
                        text = (header + "\n" if start and header else "") + "\n".join(
                            rows[start:end]
                        )
                        identifier = f"{document['id']}-{number}-{ordinal}"
                        ordinal += 1
                        retained.add(identifier)
                        existing = db.execute(
                            "SELECT text FROM chunks WHERE id=?", (identifier,)
                        ).fetchone()
                        if existing is None:
                            db.execute(
                                "INSERT INTO chunks(id,document_id,page,ordinal,text,confidence) VALUES(?,?,?,?,?,?)",
                                (
                                    identifier,
                                    document["id"],
                                    number,
                                    ordinal,
                                    text,
                                    confidence,
                                ),
                            )
                        elif existing["text"] != text:
                            db.execute(
                                "UPDATE chunks SET text=?,confidence=?,embedding=NULL WHERE id=?",
                                (text, confidence, identifier),
                            )
                        else:
                            db.execute(
                                "UPDATE chunks SET confidence=? WHERE id=?",
                                (confidence, identifier),
                            )
                        if existing is None or existing["text"] != text:
                            db.execute(
                                "DELETE FROM chunks_fts WHERE id=?", (identifier,)
                            )
                            db.execute(
                                "INSERT INTO chunks_fts(id,terms) VALUES(?,?)",
                                (
                                    identifier,
                                    " ".join(tokenize(document["name"] + "\n" + text)),
                                ),
                            )
                        if end == len(rows):
                            break
                        start = max(start + 1, end - 2)
                print(
                    f"Prepared {document['name']} ({document['pages']} pages)",
                    flush=True,
                )
            for row in db.execute("SELECT id FROM chunks").fetchall():
                if row["id"] not in retained:
                    db.execute("DELETE FROM chunks WHERE id=?", (row["id"],))
                    db.execute("DELETE FROM chunks_fts WHERE id=?", (row["id"],))
        pending = db.execute(
            "SELECT c.id,c.text,d.name FROM chunks c JOIN documents d ON d.id=c.document_id WHERE embedding IS NULL"
        ).fetchall()
        total = db.execute("SELECT count(*) FROM chunks").fetchone()[0]
        embedded = total - len(pending)
        write_progress(
            directory, dict(stage="embedding", completed=embedded, total=total)
        )
        batches = iter([pending[i : i + 10] for i in range(0, len(pending), 10)])
        async with httpx.AsyncClient() as client:

            async def worker():
                nonlocal embedded
                for batch in batches:
                    for attempt in range(4):
                        try:
                            vectors = await embed(
                                [row["name"] + "\n" + row["text"] for row in batch],
                                settings,
                                client,
                            )
                            break
                        except Exception:
                            if attempt == 3:
                                raise
                            await asyncio.sleep(1.5 * (attempt + 1))
                    with db:
                        for row, vector in zip(batch, vectors):
                            db.execute(
                                "UPDATE chunks SET embedding=? WHERE id=?",
                                (
                                    struct.pack("<" + "f" * len(vector), *vector),
                                    row["id"],
                                ),
                            )
                    embedded += len(batch)
                    write_progress(
                        directory,
                        dict(stage="embedding", completed=embedded, total=total),
                    )

            # TaskGroup cancels and joins sibling requests before closing the database.
            async with asyncio.TaskGroup() as group:
                for _ in range(3):
                    group.create_task(worker())
        with db:
            for key, value in dict(
                builtAt=datetime.now(UTC).isoformat(),
                emptyPages=empty_pages,
                sparsePages=sparse_pages,
                complete=True,
            ).items():
                write_metadata(db, key, value)
        db.close()
        db = None
        building.replace(published)
        write_progress(directory, dict(stage="ready", completed=total, total=total))
        print(
            f"Nutrition index ready: {len(manifest['documents'])} documents, {total} chunks, {settings.dimensions} dimensions."
        )
    finally:
        if db is not None:
            db.close()
        lock.unlink()


if __name__ == "__main__":
    asyncio.run(build_index(Settings.load()))
