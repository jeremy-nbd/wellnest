import { proxyBackend } from "../../../lib/backend";
export async function POST(request: Request) {
  return proxyBackend(request, "/chat", 6000000);
}
