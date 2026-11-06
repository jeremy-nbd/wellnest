import asyncio
import json
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.wellnest.api import create_app
from backend.wellnest.config import Settings
from backend.wellnest.indexer import build_index, page_rows
from backend.wellnest.models import ChatInput, Route
from backend.wellnest.orchestrator import run_consultation
from backend.wellnest.provider import Provider, ProviderError
from backend.wellnest.rag import (
    KnowledgeBase,
    normalized_vector,
    search_index,
    tokenize,
)
from backend.wellnest.tools import execute_local, execute_tool

PROFILE = dict(
    name="",
    age=None,
    goals="",
    conditions="",
    medications="",
    allergies="",
    sleep="昨夜睡眠 6 小时，用户自述。",
    diet="",
    exercise="",
    vitals="",
    source="user",
)
INPUT = dict(
    messages=[dict(role="user", content="看看我的睡眠")],
    profile=PROFILE,
    preferred="auto",
    mode="live",
)
ROUTE = dict(
    primary="sleep",
    summary="睡眠咨询",
    tasks=[dict(agent="sleep", task="查看睡眠记录", dependsOn=[])],
    urgent=False,
    clarification=None,
)
REPORT = dict(
    findings=["昨夜睡眠6小时"],
    recommendations=["补充近期记录"],
    constraints=["未经核验"],
    missing=["日期"],
)


def response(content, calls=None):
    result = dict(
        role="assistant",
        content=content
        if isinstance(content, str)
        else json.dumps(content, ensure_ascii=False),
    )
    if calls:
        result["tool_calls"] = calls
    return result


def tool_call(name, args):
    return dict(
        id="call-1",
        type="function",
        function=dict(name=name, arguments=json.dumps(args)),
    )


class FakeProvider:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.messages = []

    async def complete(self, messages, **options):
        self.messages.append(json.loads(json.dumps(messages)))
        reply = next(self.replies)
        if isinstance(reply, Exception):
            raise reply
        return reply


class Contracts(unittest.TestCase):
    def test_invalid_routes(self):
        invalid = [
            dict(ROUTE, primary="general"),
            dict(ROUTE, tasks=ROUTE["tasks"] * 2),
        ]
        invalid.extend(
            dict(ROUTE, tasks=[dict(agent="sleep", task="x", dependsOn=[dependency])])
            for dependency in ["sleep", "general"]
        )
        for route in invalid:
            with self.assertRaises(ValidationError):
                Route.model_validate(route)

    def test_dependency_order(self):
        route = dict(
            ROUTE,
            tasks=[
                dict(agent="sleep", task="x", dependsOn=["general"]),
                dict(agent="general", task="x", dependsOn=[]),
            ],
        )
        self.assertEqual(Route.model_validate(route).primary, "sleep")

    def test_records_and_permissions(self):
        with self.assertRaises(ValueError):
            execute_local(
                "nutrition", "read_health_records", {"kind": "vitals"}, PROFILE
            )
        result = execute_local(
            "nutrition", "read_health_records", {"kind": "diet"}, PROFILE
        )
        self.assertFalse(result["data"]["available"])
        self.assertIsNone(result["data"]["record"])
        with self.assertRaises(ValueError):
            execute_local("sleep", "read_health_profile", {"extra": True}, PROFILE)

    def test_chat_validation(self):
        self.assertEqual(
            ChatInput.model_validate(INPUT).profile.sleep, PROFILE["sleep"]
        )
        for changes in [
            dict(messages=[]),
            dict(image="data:text/html;base64,AA=="),
            dict(messages=[dict(role="assistant", content="x")]),
        ]:
            with self.assertRaises(ValidationError):
                ChatInput.model_validate(dict(INPUT, **changes))


class Orchestration(unittest.IsolatedAsyncioTestCase):
    async def run_case(self, replies, data=None, rag=None):
        events = []
        provider = FakeProvider(replies)
        rag = rag or unittest.mock.Mock(ready=lambda: False)
        result = await run_consultation(
            data or INPUT, Settings(), events.append, None, rag, provider
        )
        return result, events, provider

    async def test_live_tool_feedback(self):
        result, events, provider = await self.run_case(
            [
                response(ROUTE),
                response(None, [tool_call("read_health_records", {"kind": "sleep"})]),
                response(REPORT),
                response("汇总"),
            ]
        )
        self.assertEqual(result["answer"], "汇总")
        self.assertIn("昨夜睡眠", provider.messages[2][-1]["content"])
        self.assertTrue(
            any(
                event["type"] == "trace" and event["data"]["type"] == "tool"
                for event in events
            )
        )

    async def test_route_and_report_repairs(self):
        result, events, _ = await self.run_case(
            [
                response(dict(ROUTE, primary="general")),
                response(ROUTE),
                response("free text"),
                response(REPORT),
                response("ok"),
            ]
        )
        self.assertEqual(result["reports"][0]["status"], "complete")
        self.assertTrue(
            any(
                "修正任务" in event.get("data", {}).get("title", "") for event in events
            )
        )

    async def test_upstream_failure(self):
        route = dict(
            ROUTE,
            primary="general",
            tasks=[
                dict(agent="general", task="x", dependsOn=[]),
                dict(agent="sleep", task="x", dependsOn=["general"]),
            ],
        )
        events = []
        provider = FakeProvider(
            [response(route), response("invalid"), response("invalid")]
        )
        with self.assertRaises(ProviderError):
            await run_consultation(
                INPUT,
                Settings(),
                events.append,
                None,
                unittest.mock.Mock(ready=lambda: False),
                provider,
            )
        self.assertEqual(len(provider.messages), 3)
        self.assertTrue(
            any("暂停" in event.get("data", {}).get("title", "") for event in events)
        )

    async def test_urgent_and_clarification(self):
        for route in [
            dict(ROUTE, urgent=True),
            dict(ROUTE, clarification="请补充日期"),
        ]:
            result, _, provider = await self.run_case([response(route)])
            self.assertEqual(len(provider.messages), 1)
            self.assertEqual(result["reports"], [])

    async def test_demo_three_experts(self):
        result, _, provider = await self.run_case(
            [],
            dict(
                INPUT, mode="demo", messages=[dict(role="user", content="睡眠饮食运动")]
            ),
        )
        self.assertEqual(len(result["reports"]), 3)
        self.assertEqual(provider.messages, [])

    async def test_cancel_stops_model(self):
        started = asyncio.Event()
        cancelled = asyncio.Event()

        class SlowProvider:
            async def complete(self, *args, **kwargs):
                started.set()
                try:
                    await asyncio.sleep(60)
                finally:
                    cancelled.set()

        task = asyncio.create_task(
            run_consultation(
                INPUT,
                Settings(),
                lambda event: None,
                None,
                unittest.mock.Mock(ready=lambda: False),
                SlowProvider(),
            )
        )
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(cancelled.is_set())

    async def test_nutrition_forced_retrieval_and_citation(self):
        route = dict(
            ROUTE,
            primary="nutrition",
            tasks=[dict(agent="nutrition", task="蔬菜", dependsOn=[])],
        )
        hit = dict(
            id="source-1",
            documentId="0123456789abcdef",
            filename="资料.pdf",
            page=12,
            text="蔬菜证据",
            confidence=0.95,
            kind="reference",
        )
        rag = unittest.mock.Mock(
            ready=lambda: True,
            search=AsyncMock(
                return_value=dict(mode="hybrid", warning=None, hits=[hit])
            ),
        )
        url = "/api/rag/page?document=0123456789abcdef&page=12"
        result, _, provider = await self.run_case(
            [
                response(route),
                response(REPORT),
                response(
                    f"[来源]({url}) [假来源](/api/rag/page?document=ffffffffffffffff&page=1)"
                ),
            ],
            rag=rag,
        )
        self.assertIn("蔬菜证据", provider.messages[1][-1]["content"])
        self.assertIn("资料.pdf · PDF 第 12 页", result["answer"])
        self.assertIn("引用待核对", result["answer"])

    async def test_rag_failure_retains_gap(self):
        route = dict(
            ROUTE,
            primary="nutrition",
            tasks=[dict(agent="nutrition", task="蔬菜", dependsOn=[])],
        )
        rag = unittest.mock.Mock(
            ready=lambda: False, search=AsyncMock(side_effect=ProviderError("尚未就绪"))
        )
        with self.assertRaisesRegex(ProviderError, "尚未就绪"):
            await self.run_case([response(route)], rag=rag)

    async def test_verification_requires_retrieved_source(self):
        for agent in ["nutrition", "sleep"]:
            with self.assertRaises(ValueError):
                await execute_tool(
                    agent,
                    "verify_nutrition_page",
                    {"sourceId": "unknown", "question": "钙"},
                    PROFILE,
                    None,
                    None,
                    [],
                )

    async def test_tool_budget(self):
        calls = [tool_call("read_health_profile", {}) for _ in range(10)]
        result, events, _ = await self.run_case(
            [response(ROUTE), response(None, calls), response(REPORT), response("ok")]
        )
        successes = [
            e for e in events if e.get("data", {}).get("title") == "读取共享健康档案"
        ]
        self.assertEqual(len(successes), 8)


class ProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_error_redaction_and_budget(self):
        transport = httpx.MockTransport(
            lambda request: httpx.Response(401, text="secret-provider-body")
        )
        async with httpx.AsyncClient(transport=transport) as client:
            provider = Provider(Settings(api_key="secret-key"), client)
            with self.assertRaises(ProviderError) as caught:
                await provider.complete([])
            self.assertNotIn("secret", str(caught.exception))
            provider.calls = 28
            with self.assertRaisesRegex(ProviderError, "上限"):
                await provider.complete([])

    async def test_vision_parameters(self):
        def handler(request):
            body = json.loads(request.content)
            self.assertEqual(body["model"], "vision-test")
            self.assertFalse(body["enable_thinking"])
            return httpx.Response(
                200, json={"choices": [{"message": response("verified")}]}
            )

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await Provider(
                Settings(api_key="test", vision_model="vision-test"), client
            ).complete([], vision=True)


class RetrievalTests(unittest.IsolatedAsyncioTestCase):
    async def test_atomic_index_reuse_and_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(
                root=Path(directory), dimensions=2, embedding_model="test"
            )
            rag = settings.rag_directory
            pages = rag / "pages" / "0123456789abcdef"
            pages.mkdir(parents=True)
            manifest = {
                "documents": [
                    dict(
                        id="0123456789abcdef",
                        name="test.pdf",
                        pages=1,
                        kind="reference",
                        sha256="test",
                    )
                ]
            }
            (rag / "manifest.json").write_text(json.dumps(manifest))
            page = dict(
                width=100,
                height=100,
                lines=[
                    dict(
                        text="成人膳食营养钙摄入资料需要结合年龄性别核实与确认",
                        confidence=0.95,
                        x=0.1,
                        y=0.1,
                        width=0.8,
                        height=0.02,
                    )
                ],
            )
            page_file = pages / "0001.json"
            page_file.write_text(json.dumps(page))
            with patch(
                "backend.wellnest.indexer.embed", AsyncMock(return_value=[[1, 0]])
            ) as embedding:
                await build_index(settings)
                await build_index(settings)
                self.assertEqual(embedding.await_count, 1)
                with closing(sqlite3.connect(rag / "nutrition.sqlite")) as db:
                    db.row_factory = sqlite3.Row
                    hits = search_index(db, "钙", [1, 0])
                    self.assertEqual(hits[0]["page"], 1)
                    self.assertEqual(hits[0]["text"], page["lines"][0]["text"])
                original = (rag / "nutrition.sqlite").read_bytes()
                page["lines"][0]["text"] += "更新"
                page_file.write_text(json.dumps(page))
                with (
                    patch(
                        "backend.wellnest.indexer.embed",
                        AsyncMock(side_effect=ProviderError("fail")),
                    ),
                    patch("backend.wellnest.indexer.asyncio.sleep", AsyncMock()),
                ):
                    with self.assertRaises(ExceptionGroup):
                        await build_index(settings)
                self.assertEqual((rag / "nutrition.sqlite").read_bytes(), original)
                self.assertFalse((rag / "index.lock").exists())
                await build_index(settings)
                self.assertEqual(embedding.await_count, 2)

    async def test_missing_index(self):
        with tempfile.TemporaryDirectory() as directory:
            rag = KnowledgeBase(Settings(root=Path(directory)), None)
            self.assertFalse(rag.status()["ready"])
            with self.assertRaises(ProviderError):
                await rag.search("钙")

    def test_tokens_and_rotation(self):
        self.assertIn("钙", tokenize("牛奶含钙"))
        with self.assertRaises(ValueError):
            normalized_vector([0, 0])
        page = dict(
            width=100,
            height=100,
            lines=[
                dict(text="鸡蛋", x=0.1, y=0.8, width=0.02, height=0.1),
                dict(text="13.1", x=0.1, y=0.5, width=0.02, height=0.1),
            ],
        )
        self.assertEqual(page_rows(page), ["鸡蛋 | 13.1"])


class ApiTests(unittest.TestCase):
    def test_auth_config_limits_and_demo_stream(self):
        with tempfile.TemporaryDirectory() as directory:
            settings = Settings(token="test-token", root=Path(directory))
            with TestClient(create_app(settings)) as client:
                self.assertEqual(client.get("/config").status_code, 401)
                client.headers["Authorization"] = "Bearer test-token"
                self.assertEqual(
                    client.get("/health").json()["service"], "wellnest-python"
                )
                self.assertFalse(client.get("/config").json()["configured"])
                self.assertEqual(client.post("/chat", json=INPUT).status_code, 503)
                self.assertEqual(client.post("/chat", json={}).status_code, 400)
                self.assertEqual(
                    client.post("/search", content="x" * 4097).status_code, 413
                )
                response = client.post("/chat", json=dict(INPUT, mode="demo"))
                events = [json.loads(line) for line in response.text.splitlines()]
                self.assertEqual(events[-1]["type"], "result")
                self.assertEqual(events[-1]["data"]["dataSource"], "user")


if __name__ == "__main__":
    unittest.main()
