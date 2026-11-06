import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../../../chatgpt-auth";
import { runtimeConfig } from "../../../../lib/provider";
import { ragFetch } from "../../../../lib/rag";

async function handle(request: Request) {
  const url = new URL(request.url);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !(await getChatGPTUser())
  )
    return Response.json({ error: "请先登录。" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin)
    return Response.json({ error: "请求来源不匹配。" }, { status: 403 });
  const operation = url.pathname.split("/").at(-1);
  if (
    (request.method === "POST" && operation !== "search") ||
    (request.method === "GET" && !["page", "status"].includes(operation || ""))
  )
    return Response.json({ error: "请求无效。" }, { status: 404 });
  let body: string | undefined;
  if (request.method === "POST") {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (!reader) return Response.json({ error: "请求为空。" }, { status: 400 });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) {
        await reader.cancel();
        return Response.json({ error: "查询过长。" }, { status: 413 });
      }
      chunks.push(value);
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      data.set(chunk, offset);
      offset += chunk.length;
    }
    body = new TextDecoder().decode(data);
  }
  try {
    const config = runtimeConfig(env as unknown as Record<string, unknown>);
    const response = await ragFetch(
      config,
      `/${operation}${operation === "page" ? url.search : ""}`,
      { method: request.method, body, signal: request.signal },
    );
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("Content-Type") || "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "知识库暂不可用。" },
      { status: 503 },
    );
  }
}
export const GET = handle;
export const POST = handle;
