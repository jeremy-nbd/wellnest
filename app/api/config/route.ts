import { env } from "cloudflare:workers";
import { runtimeConfig } from "../../../lib/provider";
export async function GET() {
  const config = runtimeConfig(env as unknown as Record<string, unknown>);
  return Response.json(
    {
      configured: Boolean(config.apiKey),
      model: config.model,
      visionModel: config.visionModel,
      temperature: config.temperature,
      timeoutSeconds: config.timeout / 1000,
      visionTimeoutSeconds: config.visionTimeout / 1000,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
