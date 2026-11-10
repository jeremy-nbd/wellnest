"""Private Python backend. The Web gateway enforces browser origin and identity."""

import asyncio
import hmac
import json
from contextlib import asynccontextmanager, suppress

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import ValidationError

from .config import Settings
from .models import ChatInput, Query
from .orchestrator import run_consultation
from .provider import Provider, ProviderError
from .nutrition import AnalyzeInput, ConfirmedMeal, analyze, calculate
from .rag import KnowledgeBase


async def read_body(request, limit):
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise OverflowError
    return json.loads(body)


def create_app(settings=None):
    settings = settings or Settings.load()

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient() as client:
            app.state.client = client
            app.state.rag = KnowledgeBase(settings, client)
            yield

    app = FastAPI(
        title="Wellnest Python Backend",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    @app.middleware("http")
    async def authenticate(request, call_next):
        expected = "Bearer " + settings.token
        if not settings.token or not hmac.compare_digest(
            request.headers.get("authorization", "").encode(), expected.encode()
        ):
            return JSONResponse({"error": "Unauthorized"}, status_code=401)
        return await call_next(request)

    @app.exception_handler(ProviderError)
    async def provider_error(request, error):
        return JSONResponse({"error": str(error)}, status_code=503)

    @app.exception_handler(Exception)
    async def unexpected_error(request, error):
        return JSONResponse({"error": "后端请求失败，请稍后重试。"}, status_code=500)

    @app.get("/health")
    async def health():
        return {"service": "wellnest-python", "version": 1}

    @app.get("/config")
    async def config():
        return dict(
            configured=bool(settings.api_key),
            model=settings.model,
            visionModel=settings.vision_model,
            temperature=settings.temperature,
            timeoutSeconds=settings.timeout,
            visionTimeoutSeconds=settings.vision_timeout,
        )

    @app.post("/chat")
    async def chat(request: Request):
        try:
            data = ChatInput.model_validate(
                await read_body(request, 6000000)
            ).model_dump()
        except OverflowError:
            return JSONResponse({"error": "图片或消息过大。"}, status_code=413)
        except (ValueError, ValidationError):
            return JSONResponse(
                {"error": "请检查消息、健康档案或图片格式。"}, status_code=400
            )
        if data["mode"] == "live" and not settings.api_key:
            return JSONResponse(
                {"error": "尚未配置 LLM_API_KEY，请配置或切换演示模式。"},
                status_code=503,
            )

        async def stream():
            queue = asyncio.Queue()

            async def produce():
                try:
                    async with asyncio.timeout(300):
                        result = await run_consultation(
                            data,
                            settings,
                            queue.put_nowait,
                            app.state.client,
                            app.state.rag,
                        )
                        queue.put_nowait(dict(type="result", data=result))
                except TimeoutError:
                    queue.put_nowait(
                        dict(
                            type="error",
                            data={
                                "message": "本次咨询达到五分钟时限，请缩小问题范围后重试。"
                            },
                        )
                    )
                except Exception as error:
                    queue.put_nowait(
                        dict(
                            type="error",
                            data={
                                "message": str(error)
                                if isinstance(error, ProviderError)
                                else "咨询未完成，请重试。"
                            },
                        )
                    )
                finally:
                    queue.put_nowait(None)

            task = asyncio.create_task(produce())
            try:
                while True:
                    event = await queue.get()
                    if event is None:
                        break
                    yield json.dumps(event, ensure_ascii=False) + "\n"
            finally:
                task.cancel()
                with suppress(asyncio.CancelledError):
                    await task

        return StreamingResponse(
            stream(),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    @app.post("/meals/{operation}")
    async def meals(operation: str, request: Request):
        if operation not in ("analyze", "calculate"):
            return JSONResponse({"error": "接口不存在。"}, status_code=404)
        try:
            body = await read_body(request, 6000000)
            if operation == "calculate":
                meal = ConfirmedMeal.model_validate(body)
                return calculate(meal.items)
            data = AnalyzeInput.model_validate(body)
        except OverflowError:
            return JSONResponse({"error": "图片或消息过大。"}, status_code=413)
        except (ValueError, ValidationError):
            return JSONResponse({"error": "请检查图片、食物分量或日期；演示模式只支持示例餐食。"}, status_code=400)
        return await analyze(data, Provider(settings, app.state.client))

    @app.get("/status")
    async def status():
        return await asyncio.to_thread(app.state.rag.status)

    @app.post("/search")
    async def search(request: Request):
        try:
            query = Query.model_validate(await read_body(request, 4096)).query
        except OverflowError:
            return JSONResponse({"error": "查询过长。"}, status_code=413)
        except (ValueError, ValidationError):
            return JSONResponse({"error": "请输入 1–500 字检索问题。"}, status_code=400)
        return await app.state.rag.search(query)

    @app.get("/page")
    async def page(document: str, page: int):
        file = await app.state.rag.page(document, page)
        return FileResponse(
            file,
            media_type="image/png",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
        )

    return app


app = create_app()
