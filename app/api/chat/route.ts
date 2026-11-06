import { env } from "cloudflare:workers";
import { chatSchema } from "../../../lib/domain";
import { runtimeConfig, ProviderError } from "../../../lib/provider";
import { runConsultation } from "../../../lib/orchestrator";
import { getChatGPTUser } from "../../chatgpt-auth";

export async function POST(request: Request) {
  const url = new URL(request.url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && !(await getChatGPTUser()))
    return Response.json({ error: "请先登录。" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin)
    return Response.json({ error: "请求来源不匹配。" }, { status: 403 });
  // Read incrementally so oversized uploads cannot allocate an unbounded body.
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "请求为空。" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 6000000) {
      await reader.cancel();
      return Response.json({ error: "图片或消息过大。" }, { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return Response.json({ error: "请求格式错误。" }, { status: 400 });
  }
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success || parsed.data.messages.at(-1)?.role !== "user")
    return Response.json(
      { error: "请检查消息、健康档案或图片格式。" },
      { status: 400 },
    );
  const config = runtimeConfig(env as unknown as Record<string, unknown>);
  if (parsed.data.mode === "live" && !config.apiKey)
    return Response.json(
      { error: "尚未配置 LLM_API_KEY，请在服务端配置或切换演示模式。" },
      { status: 503 },
    );
  const abort = new AbortController();
  const signal = AbortSignal.any([
    request.signal,
    abort.signal,
    AbortSignal.timeout(300000),
  ]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: unknown) => {
        if (!signal.aborted)
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        const result = await runConsultation(parsed.data, config, emit, signal);
        emit({ type: "result", data: result });
      } catch (error) {
        emit({
          type: "error",
          data: {
            message:
              error instanceof ProviderError
                ? error.message
                : "咨询未完成，请重试。",
          },
        });
      } finally {
        try {
          controller.close();
        } catch {
          /* Stream may have been cancelled by the browser. */
        }
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
