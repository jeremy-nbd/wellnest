"""Cancellation-aware model client with per-consultation call budget."""

import asyncio
import json
import re
from time import perf_counter

import httpx


class ProviderError(Exception):
    """A safe, user-facing operational error."""


def parse_json(content):
    if not isinstance(content, str):
        raise ProviderError("模型未返回有效文本。")
    try:
        return json.loads(
            re.sub(
                r"\s*```$",
                "",
                re.sub(r"^```(?:json)?\s*", "", content.strip(), flags=re.IGNORECASE),
            )
        )
    except ValueError as error:
        raise ProviderError("模型输出格式异常，请重试。") from error


class Provider:
    def __init__(self, settings, client):
        self.settings = settings
        self.client = client
        self.calls = 0
        self.timings = []

    async def complete(self, messages, *, tools=None, json_mode=False, vision=False):
        started = perf_counter()
        try:
            return await self._complete(messages, tools=tools, json_mode=json_mode, vision=vision)
        finally:
            self.timings.append(dict(kind="vision" if vision else "text", durationMs=round((perf_counter() - started) * 1000)))

    async def _complete(self, messages, *, tools=None, json_mode=False, vision=False):
        self.calls += 1
        if self.calls > 28:
            raise ProviderError("本次咨询达到模型调用上限，请缩小问题范围后重试。")
        if not self.settings.api_key:
            raise ProviderError("尚未配置 LLM_API_KEY，请配置后重启或切换到演示模式。")
        payload = dict(
            model=self.settings.vision_model if vision else self.settings.model,
            messages=messages,
            temperature=self.settings.temperature,
            stream=False,
            enable_thinking=False,
            max_tokens=2200,
        )
        if tools:
            payload.update(tools=tools, tool_choice="auto")
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        timeout = self.settings.vision_timeout if vision else self.settings.timeout
        try:
            async with asyncio.timeout(timeout):
                response = await self.client.post(
                    self.settings.base_url + "/chat/completions",
                    json=payload,
                    headers={"Authorization": "Bearer " + self.settings.api_key},
                    timeout=timeout,
                )
        except (TimeoutError, httpx.TimeoutException) as error:
            raise ProviderError("模型请求超时，请重试或提高服务端超时配置。") from error
        except httpx.HTTPError as error:
            raise ProviderError(
                "无法连接模型服务，请检查网络与 LLM_BASE_URL。"
            ) from error
        if response.is_error:
            messages = {
                401: "API Key 验证失败，请检查服务端配置。",
                403: "模型访问被拒绝，请检查账号权限与区域。",
                429: "模型调用额度或频率受限，请稍后重试。",
                400: "模型请求被拒绝，请检查模型名称、区域与兼容参数。",
            }
            raise ProviderError(
                messages.get(
                    response.status_code,
                    f"模型服务暂时不可用（HTTP {response.status_code}）。",
                )
            )
        try:
            message = response.json()["choices"][0]["message"]
            if not message.get("content") and not message.get("tool_calls"):
                raise ValueError("empty")
            return message
        except (ValueError, KeyError, IndexError, TypeError) as error:
            raise ProviderError("模型返回了无效结果，请重试。") from error


    async def stream_text(self, messages, on_delta):
        """Stream only the final user-facing answer, never tool planning or JSON."""
        started = perf_counter()
        try:
            return await self._stream_text(messages, on_delta)
        finally:
            self.timings.append(dict(kind="answer", durationMs=round((perf_counter() - started) * 1000)))

    async def _stream_text(self, messages, on_delta):
        self.calls += 1
        if self.calls > 28:
            raise ProviderError("本次咨询达到模型调用上限，请缩小问题范围后重试。")
        if not self.settings.api_key:
            raise ProviderError("尚未配置 LLM_API_KEY，请配置后重启或切换到演示模式。")
        payload = dict(model=self.settings.model, messages=messages,
                       temperature=self.settings.temperature, stream=True,
                       enable_thinking=False, max_tokens=2200)
        chunks = []
        finished = False
        saw_done = False

        def consume(lines):
            nonlocal finished, saw_done
            value = "\n".join(lines)
            if value == "[DONE]":
                saw_done = True
                return
            if not value:
                return
            try:
                event = json.loads(value)
                if event.get("error"):
                    raise ValueError("provider error")
                choices = event.get("choices", [])
                if not choices:
                    return  # Optional usage-only events.
                choice = choices[0]
                delta = choice.get("delta", {})
                if delta.get("tool_calls"):
                    raise ValueError("unexpected tool call")
                content = delta.get("content")
                if content is not None:
                    if not isinstance(content, str):
                        raise ValueError("invalid content")
                    if content:
                        chunks.append(content)
                        on_delta(content)
                reason = choice.get("finish_reason")
                if reason is not None:
                    if reason != "stop":
                        raise ProviderError("回答未完整生成，请重试或缩小问题范围。")
                    finished = True
            except (ValueError, KeyError, IndexError, TypeError, AttributeError) as error:
                raise ProviderError("模型响应流格式异常，请重试。") from error

        try:
            async with asyncio.timeout(self.settings.timeout):
                async with self.client.stream(
                    "POST", self.settings.base_url + "/chat/completions",
                    json=payload, headers={"Authorization": "Bearer " + self.settings.api_key},
                    timeout=self.settings.timeout,
                ) as response:
                    if response.is_error:
                        errors = {401: "API Key 验证失败，请检查服务端配置。",
                                  403: "模型访问被拒绝，请检查账号权限与区域。",
                                  429: "模型调用额度或频率受限，请稍后重试。"}
                        raise ProviderError(errors.get(response.status_code, f"模型服务暂时不可用（HTTP {response.status_code}）。"))
                    lines = []
                    async for line in response.aiter_lines():
                        if line == "":
                            consume(lines)
                            lines = []
                            if saw_done:
                                break
                        elif line.startswith("data:"):
                            lines.append(line[5:].lstrip())
                    if lines and not saw_done:
                        consume(lines)
        except (TimeoutError, httpx.TimeoutException) as error:
            raise ProviderError("模型请求超时，回答尚未完成，请重试。") from error
        except httpx.HTTPError as error:
            raise ProviderError("模型连接中断，回答尚未完成，请重试。") from error
        if not finished or not saw_done or not "".join(chunks).strip():
            raise ProviderError("连接已结束，但回答未完整生成，请重试。")
        return "".join(chunks)
