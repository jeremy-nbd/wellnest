import { env } from "cloudflare:workers";
import { getChatGPTUser } from "../app/chatgpt-auth";

/** Same-origin gateway. All agent and retrieval logic runs in Python. */
export async function proxyBackend(
  request: Request,
  path: string,
  limit = 4096,
) {
  const url = new URL(request.url);
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
    !(await getChatGPTUser())
  )
    return Response.json({ error: "请先登录。" }, { status: 401 });
  const origin = request.headers.get("origin");
  if (origin && origin !== url.origin)
    return Response.json({ error: "请求来源不匹配。" }, { status: 403 });
  const bindings = env as unknown as Record<string, unknown>;
  const get = (key: string) => String(bindings[key] ?? process.env[key] ?? "");
  const base = (get("BACKEND_SERVICE_URL") || "http://127.0.0.1:3012").replace(
    /\/$/,
    "",
  );
  const token = get("BACKEND_SERVICE_TOKEN") || get("RAG_SERVICE_TOKEN");
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (request.method === "POST") {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "请求为空。" }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return Response.json({ error: "图片或消息过大。" }, { status: 413 });
      }
      chunks.push(value);
    }
    body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.length;
    }
  }
  try {
    const response = await fetch(base + path, {
      method: request.method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(310000)]),
    });
    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type":
          response.headers.get("Content-Type") || "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return Response.json(
      { error: "Python 后端连接失败，请确认后端已启动。" },
      { status: 503 },
    );
  }
}
