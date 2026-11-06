"""Cancellation-aware model client with per-consultation call budget."""

import asyncio
import json
import re

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

    async def complete(self, messages, *, tools=None, json_mode=False, vision=False):
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
