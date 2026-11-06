export type RuntimeConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
  temperature: number;
  timeout: number;
  visionModel: string;
  visionTimeout: number;
  ragUrl?: string;
  ragToken?: string;
};
export function runtimeConfig(
  bindings: Record<string, unknown> = {},
): RuntimeConfig {
  const get = (key: string, fallback = "") =>
    String(bindings[key] ?? process.env[key] ?? fallback);
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = Number(get(key, String(fallback)));
    return Number.isFinite(value)
      ? Math.max(min, Math.min(max, value))
      : fallback;
  };
  return {
    apiKey: get("LLM_API_KEY"),
    ragUrl: get("RAG_SERVICE_URL").replace(/\/$/, ""),
    ragToken: get("RAG_SERVICE_TOKEN"),
    baseUrl: get(
      "LLM_BASE_URL",
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    ).replace(/\/$/, ""),
    model: get("LLM_DEFAULT_MODEL_ID", "qwen3.5-plus"),
    temperature: number("LLM_TEMPERATURE", 0.2, 0, 2),
    timeout: number("LLM_TIMEOUT_S", 60, 5, 180) * 1000,
    visionModel: get("VLM_DEFAULT_MODEL_ID", "qwen3-vl-plus"),
    visionTimeout: number("VLM_TIMEOUT_S", 120, 5, 240) * 1000,
  };
}
export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};
export type ModelMessage = {
  role: string;
  content: unknown;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
export type ToolDefinition = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};
export class ProviderError extends Error {}
export class Provider {
  calls = 0;
  constructor(
    private config: RuntimeConfig,
    private signal: AbortSignal,
  ) {}
  async complete(
    messages: ModelMessage[],
    options: {
      tools?: ToolDefinition[];
      json?: boolean;
      vision?: boolean;
    } = {},
  ): Promise<ModelMessage> {
    if (++this.calls > 28)
      throw new ProviderError(
        "本次咨询达到模型调用上限，请缩小问题范围后重试。",
      );
    if (!this.config.apiKey)
      throw new ProviderError(
        "尚未配置 LLM_API_KEY。请在服务端配置后重启，或切换到演示模式。",
      );
    const timeout = AbortSignal.timeout(
      options.vision ? this.config.visionTimeout : this.config.timeout,
    );
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.any([this.signal, timeout]),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: options.vision ? this.config.visionModel : this.config.model,
          messages,
          temperature: this.config.temperature,
          stream: false,
          enable_thinking: false,
          max_tokens: 2200,
          ...(options.tools
            ? { tools: options.tools, tool_choice: "auto" }
            : {}),
          ...(options.json ? { response_format: { type: "json_object" } } : {}),
        }),
      });
    } catch {
      if (this.signal.aborted) throw new ProviderError("咨询已停止。");
      throw new ProviderError(
        timeout.aborted
          ? "模型请求超时，请重试或提高服务端超时配置。"
          : "无法连接模型服务，请检查网络与 LLM_BASE_URL。",
      );
    }
    if (!response.ok) {
      const messages: Record<number, string> = {
        401: "API Key 验证失败，请检查服务端配置。",
        403: "模型访问被拒绝，请检查账号权限与区域。",
        429: "模型调用额度或频率受限，请稍后重试。",
        400: "模型请求被拒绝，请检查模型名称、区域与兼容参数。",
      };
      throw new ProviderError(
        messages[response.status] ??
          `模型服务暂时不可用（HTTP ${response.status}），请稍后重试。`,
      );
    }
    const payload = (await response.json()) as {
      choices?: { message?: ModelMessage }[];
    };
    const message = payload.choices?.[0]?.message;
    if (!message || (!message.content && !message.tool_calls?.length))
      throw new ProviderError("模型返回了空结果，请重试。");
    return message;
  }
}
export function parseJSON(content: unknown): unknown {
  if (typeof content !== "string")
    throw new ProviderError("模型未返回有效文本。");
  try {
    return JSON.parse(
      content
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim(),
    );
  } catch {
    throw new ProviderError("模型输出格式异常，请重试。");
  }
}
