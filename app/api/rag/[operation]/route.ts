import { proxyBackend } from "../../../../lib/backend";
async function handle(request: Request) {
  const url = new URL(request.url);
  const operation = url.pathname.split("/").at(-1);
  if (
    (request.method === "POST" && operation !== "search") ||
    (request.method === "GET" && !["page", "status"].includes(operation || ""))
  )
    return Response.json({ error: "请求无效。" }, { status: 404 });
  return proxyBackend(
    request,
    `/${operation}${operation === "page" ? url.search : ""}`,
  );
}
export const GET = handle;
export const POST = handle;
