import { proxyBackend } from "../../../../lib/backend";

export async function POST(request: Request, context: { params: Promise<{ operation: string }> }) {
  const { operation } = await context.params;
  if (!["analyze", "calculate"].includes(operation))
    return Response.json({ error: "接口不存在。" }, { status: 404 });
  return proxyBackend(request, `/meals/${operation}`, 6000000);
}
