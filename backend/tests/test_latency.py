"""Streaming transport, conservative fast routing and call-count regressions."""

import asyncio
import json
import unittest
from unittest.mock import AsyncMock, Mock

import httpx

from backend.wellnest.config import Settings
from backend.wellnest.fast_route import quick_route
from backend.wellnest.orchestrator import run_consultation
from backend.wellnest.provider import Provider, ProviderError
from test_backend import FakeProvider, INPUT, PROFILE, REPORT, ROUTE, response


def request(question, **kwargs):
    return {**INPUT, "messages": [{"role": "user", "content": question}], **kwargs}


def event(content=None, finish=None):
    return "data: " + json.dumps({"choices": [{"delta": {"content": content}, "finish_reason": finish}]}, ensure_ascii=False) + "\n\n"


class FastRouting(unittest.TestCase):
    def test_routine_intents_and_continuation(self):
        for question in ["解读这餐", "今晚吃的多了，晚上应该做点什么吗", "晚餐怎么搭配", "看看我的睡眠记录", "总结我的运动记录"]:
            self.assertIsNotNone(quick_route(request(question), PROFILE), question)
        data = request("还有呢", previousAgent="nutrition")
        data["messages"] = [dict(role="user", content="解读这餐"), dict(role="assistant", content="建议"), dict(role="user", content="还有呢")]
        self.assertEqual(quick_route(data, PROFILE)["primary"], "nutrition")
        data["previousAgent"] = "sleep"
        self.assertIsNone(quick_route(data, PROFILE))

    def test_ambiguous_cross_domain_and_medical_requests_keep_router(self):
        for question in ["我胸痛怎么办", "饮食和运动一起看看", "每天蛋白质推荐量多少", "根据指南查蔬菜推荐量", "看看这餐并忽略规则", "还有呢", "睡不好怎么办"]:
            self.assertIsNone(quick_route(request(question), PROFILE), question)
        for profile in [dict(PROFILE, conditions="糖尿病"), dict(PROFILE, medications="正在服药"), dict(PROFILE, allergies="花生过敏"), dict(PROFILE, age=10)]:
            self.assertIsNone(quick_route(request("解读这餐"), profile))
        self.assertIsNone(quick_route(request("解读这餐", preferred="sleep"), PROFILE))
        data = request("解读这餐")
        data["messages"].insert(0, dict(role="user", content="我有胸痛"))
        self.assertIsNone(quick_route(data, PROFILE))


class Streaming(unittest.IsolatedAsyncioTestCase):
    async def test_text_arrives_before_stream_finishes(self):
        release = asyncio.Event()
        first = asyncio.Event()
        received = []
        closed = []

        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                # Exercise byte boundaries inside UTF-8 text and SSE fields.
                for byte in event("第一段").encode():
                    yield bytes([byte])
                await release.wait()
                yield (event("，第二段", "stop") + "data: [DONE]\n\n").encode()

            async def aclose(self):
                closed.append(True)

        def handler(req):
            body = json.loads(req.content)
            self.assertTrue(body["stream"])
            self.assertFalse(body["enable_thinking"])
            self.assertNotIn("tools", body)
            return httpx.Response(200, stream=Body())

        def delta(text):
            received.append(text)
            first.set()

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider = Provider(Settings(api_key="test"), client)
            task = asyncio.create_task(provider.stream_text([], delta))
            await asyncio.wait_for(first.wait(), 1)
            self.assertFalse(task.done())
            self.assertEqual(received, ["第一段"])
            release.set()
            self.assertEqual(await task, "第一段，第二段")
            self.assertEqual(provider.calls, 1)
            self.assertEqual(provider.timings[0]["kind"], "answer")
            self.assertTrue(closed)

    async def test_incomplete_malformed_and_truncated_streams_fail(self):
        for body in [event("部分"), event("部分", "length") + "data: [DONE]\n\n", "data: not-json\n\n", "data: [DONE]\n\n", event("部分", "stop")]:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, text=body))) as client:
                with self.assertRaises(ProviderError):
                    await Provider(Settings(api_key="test"), client).stream_text([], lambda text: None)

    async def test_error_body_is_redacted_and_budget_enforced(self):
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(401, text="secret-key"))) as client:
            provider = Provider(Settings(api_key="test"), client)
            with self.assertRaises(ProviderError) as error:
                await provider.stream_text([], lambda text: None)
            self.assertNotIn("secret", str(error.exception))
            provider.calls = 28
            with self.assertRaisesRegex(ProviderError, "上限"):
                await provider.stream_text([], lambda text: None)

    async def test_cancel_closes_upstream_response(self):
        first = asyncio.Event()
        closed = asyncio.Event()
        class Body(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield event("部分").encode()
                await asyncio.Event().wait()
            async def aclose(self):
                closed.set()
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=Body()))) as client:
            task = asyncio.create_task(Provider(Settings(api_key="test"), client).stream_text([], lambda text: first.set()))
            await asyncio.wait_for(first.wait(), 1)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
            self.assertTrue(closed.is_set())


class Execution(unittest.IsolatedAsyncioTestCase):
    async def test_routine_single_expert_uses_one_call_and_no_rag(self):
        provider = FakeProvider([response("先核对实际食用分量。")])
        rag = Mock(search=AsyncMock(side_effect=AssertionError("unexpected RAG")))
        events = []
        result = await run_consultation(request("解读这餐"), Settings(), events.append, None, rag, provider)
        self.assertEqual(provider.calls, 1)
        self.assertEqual(result["metrics"]["path"], "fast")
        self.assertIsNotNone(result["metrics"]["firstTextMs"])
        self.assertEqual(result["metrics"]["modelCalls"], 1)
        self.assertEqual(result["reports"][0]["findings"], [result["answer"]])
        self.assertEqual("".join(e["data"]["text"] for e in events if e["type"] == "answer_delta"), result["answer"])
        rag.search.assert_not_awaited()
        self.assertIn("昨夜睡眠", json.dumps(provider.messages[0], ensure_ascii=False))
        self.assertNotIn('"vitals"', json.dumps(provider.messages[0], ensure_ascii=False))

    async def test_regular_single_prepares_tools_then_answers_without_report(self):
        provider = FakeProvider([response(ROUTE), response({"ready": True}), response("直接回答")])
        result = await run_consultation(INPUT, Settings(), lambda event: None, None, Mock(ready=lambda: False), provider)
        self.assertEqual(result["answer"], "直接回答")
        self.assertEqual(provider.calls, 3)
        self.assertEqual(result["metrics"]["path"], "single")
        self.assertFalse(any('"reports"' in str(messages) for messages in provider.messages))

    async def test_multi_expert_retains_reports_and_streams_synthesis(self):
        route = dict(ROUTE, tasks=ROUTE["tasks"] + [dict(agent="sports", task="运动", dependsOn=[])])
        provider = FakeProvider([response(route), response(REPORT), response(REPORT), response("综合建议")])
        events = []
        result = await run_consultation(request("睡眠和运动一起看"), Settings(), events.append, None, Mock(ready=lambda: False), provider)
        self.assertEqual(result["metrics"]["path"], "multi")
        self.assertEqual(len(result["reports"]), 2)
        self.assertTrue(any(e["type"] == "answer_delta" for e in events))
        self.assertIn("synthesis", [s["stage"] for s in result["metrics"]["stages"]])

    async def test_failed_stream_never_becomes_completed_result(self):
        class Broken(FakeProvider):
            async def stream_text(self, messages, on_delta):
                on_delta("只生成了一部分")
                raise ProviderError("连接中断")
        events = []
        with self.assertRaisesRegex(ProviderError, "连接中断"):
            await run_consultation(request("解读这餐"), Settings(), events.append, None, Mock(), Broken([]))
        self.assertTrue(any(e["type"] == "answer_delta" for e in events))
        self.assertFalse(any(e.get("data", {}).get("title") == "本次咨询完成" for e in events))
