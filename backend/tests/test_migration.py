"""Regressions at the Python/Web and legacy-index boundaries."""

import asyncio
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from test_backend import INPUT, REPORT, ROUTE, response

from backend.wellnest.api import create_app
from backend.wellnest.config import Settings
from backend.wellnest.orchestrator import run_consultation
from backend.wellnest.rag import KnowledgeBase
from backend.wellnest.tools import execute_tool


class MigrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_independent_experts_run_concurrently(self):
        route = dict(
            ROUTE,
            tasks=[
                dict(agent=agent, task="x", dependsOn=[])
                for agent in ["sleep", "sports"]
            ],
        )
        started = 0
        together = asyncio.Event()

        class ParallelProvider:
            calls = 0

            async def complete(self, messages, **options):
                nonlocal started
                self.calls += 1
                if self.calls == 1:
                    return response(route)
                if options.get("tools"):
                    started += 1
                    if started == 2:
                        together.set()
                    await asyncio.wait_for(together.wait(), 1)
                    return response(REPORT)
                return response("汇总")

            async def stream_text(self, messages, on_delta):
                reply = await self.complete(messages)
                on_delta(reply["content"])
                return reply["content"]

        result = await run_consultation(
            INPUT,
            Settings(),
            lambda event: None,
            None,
            Mock(ready=lambda: False),
            ParallelProvider(),
        )
        self.assertFalse(result["partial"])
        self.assertEqual(started, 2)

    async def test_visual_verification_uses_retrieved_page(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "page.png"
            image.write_bytes(b"fixture-png")
            rag = Mock(page=AsyncMock(return_value=image))
            provider = Mock(
                complete=AsyncMock(return_value=response("单位与行列已核对"))
            )
            source = dict(
                id="page1",
                filename="资料.pdf",
                page=1,
                title="资料.pdf · PDF 第 1 页",
                url="/api/rag/page?document=0123456789abcdef&page=1",
            )
            result = await execute_tool(
                "nutrition",
                "verify_nutrition_page",
                dict(sourceId="page1", question="蛋白质单位"),
                INPUT["profile"],
                rag,
                provider,
                [source],
            )
            self.assertEqual(result["sources"][0]["id"], "page1")
            self.assertTrue(provider.complete.call_args.kwargs["vision"])
            self.assertIn(
                "data:image/png;base64,", json.dumps(provider.complete.call_args.args)
            )

    async def test_failed_embedding_falls_back_to_legacy_fts(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(root=Path(directory))
            settings.rag_directory.mkdir()
            with sqlite3.connect(settings.rag_directory / "nutrition.sqlite") as db:
                db.executescript("""
                    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
                    INSERT INTO metadata VALUES('model','"test"'),('dimensions','2');
                    CREATE TABLE documents(id TEXT,name TEXT,kind TEXT);
                    CREATE TABLE chunks(id TEXT,document_id TEXT,page INTEGER,text TEXT,confidence REAL,embedding BLOB);
                    CREATE VIRTUAL TABLE chunks_fts USING fts5(id UNINDEXED,terms);
                    INSERT INTO documents VALUES('0123456789abcdef','资料.pdf','reference');
                    INSERT INTO chunks VALUES('a','0123456789abcdef',12,'钙相关资料',0.95,NULL);
                    INSERT INTO chunks_fts VALUES('a','钙');
                """)
            rag = KnowledgeBase(settings, None)
            with patch(
                "backend.wellnest.rag.embed",
                AsyncMock(side_effect=RuntimeError("network")),
            ):
                result = await rag.search("钙")
            self.assertEqual(result["mode"], "keyword")
            self.assertEqual(result["hits"][0]["page"], 12)
            self.assertTrue(result["warning"])

    async def test_http_disconnect_cancels_consultation(self):
        settings = Settings(token="test")
        app = create_app(settings)
        started = asyncio.Event()
        cancelled = asyncio.Event()
        sent = []
        delivered = False

        async def consult(*args, **kwargs):
            started.set()
            try:
                await asyncio.sleep(60)
            finally:
                cancelled.set()

        async def receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {
                    "type": "http.request",
                    "body": json.dumps(dict(INPUT, mode="demo")).encode(),
                    "more_body": False,
                }
            await started.wait()
            return {"type": "http.disconnect"}

        async def send(event):
            sent.append(event)

        scope = dict(
            type="http",
            asgi={"version": "3.0", "spec_version": "2.3"},
            http_version="1.1",
            method="POST",
            scheme="http",
            path="/chat",
            raw_path=b"/chat",
            query_string=b"",
            root_path="",
            headers=[
                (b"authorization", b"Bearer test"),
                (b"content-type", b"application/json"),
            ],
            server=("127.0.0.1", 3012),
            client=("127.0.0.1", 40000),
        )
        async with app.router.lifespan_context(app):
            with patch("backend.wellnest.api.run_consultation", consult):
                await asyncio.wait_for(app(scope, receive, send), 3)
        self.assertTrue(cancelled.is_set())
