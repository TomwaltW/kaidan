// OpenAI 兼容 provider（spec 3.2 第 5 条）：只用 Node 内置 fetch 调 POST {baseURL}/chat/completions，不引入 SDK。
// 构造时不读密钥、不联网；首次 chat 时才读 process.env[apiKeyEnv]。
// 只用于国产已备案模型的 OpenAI 兼容接口（百炼 / DeepSeek / 智谱 / 火山方舟 / Kimi 等），见 CLAUDE.md 硬规则 3。
import {
  ErrorCode,
  KaidanError,
  isKaidanError,
  type AssistantMessage,
  type KaidanConfig,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
  type LlmResponse,
  type LlmToolCall,
  type LlmToolChoice,
} from "@kaidan/contracts";

export interface OpenAICompatibleOptions {
  /** 缺省在调用时取 globalThis.fetch（便于 vi.stubGlobal） */
  fetchImpl?: typeof fetch;
  /** 缺省 60 秒 */
  timeoutMs?: number;
  /** 缺省 process.env */
  env?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export function openAICompatibleProvider(llm: KaidanConfig["llm"], opts: OpenAICompatibleOptions = {}): LlmProvider {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const model = llm.model ?? "";
  let apiKey: string | undefined;

  function readKey(): string {
    if (apiKey !== undefined) return apiKey;
    if (!llm.apiKeyEnv) throw new KaidanError(ErrorCode.CONFIG, "llm.apiKeyEnv 未配置：无法读取模型密钥");
    const env = opts.env ?? process.env;
    const key = env[llm.apiKeyEnv];
    if (!key) throw new KaidanError(ErrorCode.CONFIG, `缺少模型密钥：环境变量 ${llm.apiKeyEnv} 未设置`);
    apiKey = key;
    return key;
  }

  return {
    id: `openai_compatible:${model}`,
    disclosure: { ...llm.disclosure },
    async chat(req: LlmRequest): Promise<LlmResponse> {
      if (!llm.baseURL) throw new KaidanError(ErrorCode.CONFIG, "llm.baseURL 未配置");
      if (!llm.model) throw new KaidanError(ErrorCode.CONFIG, "llm.model 未配置");
      const key = readKey();
      const url = `${llm.baseURL.replace(/\/+$/, "")}/chat/completions`;
      const body = buildBody(llm, req);

      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      const doFetch = opts.fetchImpl ?? globalThis.fetch;

      let res: Response;
      let text: string;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
          signal,
        });
        text = await res.text();
      } catch (e) {
        if (timeout.aborted) {
          throw new KaidanError(ErrorCode.UPSTREAM, `模型接口超时（${Math.round(timeoutMs / 1000)} 秒）`, {
            retryable: true,
            cause: e,
          });
        }
        if (req.signal?.aborted) throw new KaidanError(ErrorCode.UPSTREAM, "模型请求已取消", { cause: e });
        throw new KaidanError(ErrorCode.UPSTREAM, `模型接口网络错误：${(e as Error).message}`, {
          retryable: true,
          cause: e,
        });
      }

      if (res.status === 429) {
        throw new KaidanError(ErrorCode.RATE_LIMITED, `模型接口限流（HTTP 429）：${snippet(text)}`, {
          retryable: true,
          details: { status: 429 },
        });
      }
      if (res.status >= 500) {
        throw new KaidanError(ErrorCode.UPSTREAM, `模型接口错误（HTTP ${res.status}）：${snippet(text)}`, {
          retryable: true,
          details: { status: res.status },
        });
      }
      if (!res.ok) {
        throw new KaidanError(ErrorCode.UPSTREAM, `模型接口拒绝请求（HTTP ${res.status}）：${snippet(text)}`, {
          details: { status: res.status },
        });
      }
      try {
        return parseResponse(JSON.parse(text));
      } catch (e) {
        if (isKaidanError(e)) throw e;
        throw new KaidanError(ErrorCode.UPSTREAM, `模型接口返回的不是合法 JSON：${snippet(text)}`, { cause: e });
      }
    },
  };
}

// ------------------------------------------------------------------ 请求体

function buildBody(llm: KaidanConfig["llm"], req: LlmRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { model: llm.model, messages: req.messages.map(toWireMessage) };
  if (req.tools && req.tools.length > 0) {
    body["tools"] = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    // tool_choice 只在 tools 非空时下发（第 3 轮 R3）；{name} → {type:"function",function:{name}}
    if (req.toolChoice !== undefined) body["tool_choice"] = toWireToolChoice(req.toolChoice);
  }
  const temperature = req.temperature ?? llm.temperature;
  if (temperature !== undefined) body["temperature"] = temperature;
  const maxTokens = req.maxTokens ?? llm.maxTokens;
  if (maxTokens !== undefined) body["max_tokens"] = maxTokens;
  return body;
}

function toWireToolChoice(c: LlmToolChoice): string | Record<string, unknown> {
  return typeof c === "string" ? c : { type: "function", function: { name: c.name } };
}

function toWireMessage(m: LlmMessage): Record<string, unknown> {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    case "assistant": {
      const out: Record<string, unknown> = { role: "assistant", content: m.content };
      if (m.toolCalls && m.toolCalls.length > 0) {
        out["tool_calls"] = m.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        }));
      }
      return out;
    }
  }
}

// ------------------------------------------------------------------ 响应

interface WireToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

function parseResponse(json: unknown): LlmResponse {
  const root = (json ?? {}) as { choices?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
  const choice = Array.isArray(root.choices) ? (root.choices[0] as Record<string, unknown> | undefined) : undefined;
  const msg = choice?.["message"] as { content?: unknown; tool_calls?: unknown } | undefined;
  if (!msg) throw new KaidanError(ErrorCode.UPSTREAM, "模型接口返回缺少 choices[0].message");

  const toolCalls: LlmToolCall[] = [];
  if (Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((raw: WireToolCall, j) => {
      const name = raw.function?.name;
      if (typeof name !== "string" || !name) return;
      const args = raw.function?.arguments;
      toolCalls.push({
        id: typeof raw.id === "string" && raw.id ? raw.id : `call_${j}`,
        name,
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      });
    });
  }

  const message: AssistantMessage = {
    role: "assistant",
    content: typeof msg.content === "string" ? msg.content : null,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
  return {
    message,
    usage: { inputTokens: toCount(root.usage?.prompt_tokens), outputTokens: toCount(root.usage?.completion_tokens) },
    finishReason: mapFinish(choice?.["finish_reason"], toolCalls.length > 0),
  };
}

function mapFinish(reason: unknown, hasToolCalls: boolean): LlmResponse["finishReason"] {
  switch (reason) {
    case "stop":
    case "length":
    case "content_filter":
    case "tool_calls":
      return reason;
    case "function_call":
      return "tool_calls";
    default:
      return hasToolCalls ? "tool_calls" : "stop";
  }
}

function toCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function snippet(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}
