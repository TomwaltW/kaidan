// spec 第 6 节 T2 行②：OpenAI 兼容 provider 的请求体与响应映射（注入 fake fetch：tool_calls、429、500、超时、缺密钥）。
// 不联网：fetch 一律为 fake（注入或 vi.stubGlobal）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCode, KaidanError, isKaidanError, type KaidanConfig, type LlmRequest } from "@kaidan/contracts";
import { createOpenAICompatibleProvider } from "../src/index.js";
import { openAICompatibleProvider } from "../src/openai-provider.js";

const LLM: KaidanConfig["llm"] = {
  kind: "openai_compatible",
  baseURL: "https://llm.example.invalid/compatible-mode/v1/",
  model: "qwen-plus",
  apiKeyEnv: "TEST_LLM_KEY",
  temperature: 0.2,
  maxTokens: 1024,
  disclosure: { providerName: "阿里云百炼", modelName: "通义千问", filingNo: "备案-测试" },
};
const ENV = { TEST_LLM_KEY: "sk-test-secret" };

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function fakeFetch(respond: (c: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const c: Captured = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? "{}")) };
    calls.push(c);
    return respond(c);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const REQ: LlmRequest = {
  messages: [
    { role: "system", content: "系统提示" },
    { role: "user", content: "晨报" },
    { role: "assistant", content: null, toolCalls: [{ id: "call_a", name: "pipeline_snapshot", arguments: '{"scope":"me"}' }] },
    { role: "tool", toolCallId: "call_a", content: '{"ok":true,"output":{}}' },
  ],
  tools: [{ name: "pipeline_snapshot", description: "管道快照", parameters: { type: "object", properties: {} } }],
};

async function caught(p: Promise<unknown>): Promise<KaidanError> {
  const e = await p.then(
    () => expect.fail("期望抛出 KaidanError"),
    (x: unknown) => x,
  );
  expect(isKaidanError(e), String(e)).toBe(true);
  return e as KaidanError;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("OpenAI 兼容 provider：请求体", () => {
  it("POST {baseURL}/chat/completions，Bearer 密钥，messages / tools / temperature / max_tokens 映射", async () => {
    const { fn, calls } = fakeFetch(() => json({ choices: [{ message: { content: "好" }, finish_reason: "stop" }] }));
    const p = openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV });
    await p.chat(REQ);

    expect(calls).toHaveLength(1);
    const c = calls[0]!;
    expect(c.url).toBe("https://llm.example.invalid/compatible-mode/v1/chat/completions");
    expect(c.init.method).toBe("POST");
    const headers = c.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-test-secret");
    expect(headers["content-type"]).toBe("application/json");
    expect(c.body).toEqual({
      model: "qwen-plus",
      messages: [
        { role: "system", content: "系统提示" },
        { role: "user", content: "晨报" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_a", type: "function", function: { name: "pipeline_snapshot", arguments: '{"scope":"me"}' } }],
        },
        { role: "tool", tool_call_id: "call_a", content: '{"ok":true,"output":{}}' },
      ],
      tools: [
        { type: "function", function: { name: "pipeline_snapshot", description: "管道快照", parameters: { type: "object", properties: {} } } },
      ],
      temperature: 0.2,
      max_tokens: 1024,
    });
  });

  it("请求里的 temperature / maxTokens 覆盖配置；没有 tools 时不带 tools 字段", async () => {
    const { fn, calls } = fakeFetch(() => json({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }));
    const p = openAICompatibleProvider({ ...LLM, temperature: undefined, maxTokens: undefined }, { fetchImpl: fn, env: ENV });
    await p.chat({ messages: [{ role: "user", content: "hi" }] });
    expect(calls[0]!.body).toEqual({ model: "qwen-plus", messages: [{ role: "user", content: "hi" }] });
    await p.chat({ messages: [{ role: "user", content: "hi" }], temperature: 0.7, maxTokens: 5, tools: [] });
    expect(calls[1]!.body).toMatchObject({ temperature: 0.7, max_tokens: 5 });
    expect(calls[1]!.body).not.toHaveProperty("tools");
  });

  it("id = openai_compatible:<model>；disclosure 取配置", () => {
    const p = createOpenAICompatibleProvider(LLM);
    expect(p.id).toBe("openai_compatible:qwen-plus");
    expect(p.disclosure).toEqual({ providerName: "阿里云百炼", modelName: "通义千问", filingNo: "备案-测试" });
  });
});

describe("OpenAI 兼容 provider：tool_choice（第 3 轮 R3）", () => {
  it("toolChoice {name} → 请求体 tool_choice 深等于 {type:\"function\",function:{name}}，其余字段与不带时逐字相同", async () => {
    const { fn, calls } = fakeFetch(() => json({ choices: [{ message: { content: "好" }, finish_reason: "stop" }] }));
    const p = openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV });
    await p.chat(REQ);
    await p.chat({ ...REQ, toolChoice: { name: "propose_update" } });
    expect(calls[0]!.body).not.toHaveProperty("tool_choice");
    expect(calls[1]!.body).toEqual({ ...calls[0]!.body, tool_choice: { type: "function", function: { name: "propose_update" } } });
  });

  it('toolChoice "required" / "auto" / "none" 原样下发为 tool_choice', async () => {
    const { fn, calls } = fakeFetch(() => json({ choices: [{ message: { content: "好" }, finish_reason: "stop" }] }));
    const p = openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV });
    for (const toolChoice of ["required", "auto", "none"] as const) await p.chat({ ...REQ, toolChoice });
    expect(calls.map((c) => c.body["tool_choice"])).toEqual(["required", "auto", "none"]);
  });

  it("tools 为空或缺省时不下发 tool_choice（也不下发 tools）", async () => {
    const { fn, calls } = fakeFetch(() => json({ choices: [{ message: { content: "好" }, finish_reason: "stop" }] }));
    const p = openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV });
    const messages: LlmRequest["messages"] = [{ role: "user", content: "hi" }];
    await p.chat({ messages, toolChoice: "required" });
    await p.chat({ messages, tools: [], toolChoice: { name: "propose_update" } });
    for (const c of calls) {
      expect(c.body).toEqual({ model: "qwen-plus", messages: [{ role: "user", content: "hi" }], temperature: 0.2, max_tokens: 1024 });
    }
  });
});

describe("OpenAI 兼容 provider：响应映射", () => {
  it("tool_calls → toolCalls，usage → inputTokens/outputTokens，finish_reason=tool_calls", async () => {
    const { fn } = fakeFetch(() =>
      json({
        id: "chatcmpl-1",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                { id: "call_x1", type: "function", function: { name: "crm_search", arguments: '{"type":"opportunity"}' } },
                { id: "call_x2", type: "function", function: { name: "calendar_today", arguments: {} } },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 321, completion_tokens: 45, total_tokens: 366 },
      }),
    );
    const r = await openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV }).chat(REQ);
    expect(r).toEqual({
      message: {
        role: "assistant",
        content: null,
        toolCalls: [
          { id: "call_x1", name: "crm_search", arguments: '{"type":"opportunity"}' },
          { id: "call_x2", name: "calendar_today", arguments: "{}" },
        ],
      },
      usage: { inputTokens: 321, outputTokens: 45 },
      finishReason: "tool_calls",
    });
  });

  it("文本回复 → content + stop；缺 usage 记 0；length / content_filter 原样映射", async () => {
    const replies = [
      { choices: [{ message: { content: "你好" }, finish_reason: "stop" }] },
      { choices: [{ message: { content: "截断" }, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 2 } },
      { choices: [{ message: { content: "" }, finish_reason: "content_filter" }] },
    ];
    const { fn } = fakeFetch(() => json(replies.shift()));
    const p = openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV });
    expect(await p.chat(REQ)).toEqual({
      message: { role: "assistant", content: "你好" },
      usage: { inputTokens: 0, outputTokens: 0 },
      finishReason: "stop",
    });
    expect((await p.chat(REQ)).finishReason).toBe("length");
    expect((await p.chat(REQ)).finishReason).toBe("content_filter");
  });

  it("返回缺少 choices 或不是 JSON → UPSTREAM", async () => {
    const bodies = [new Response(JSON.stringify({ error: "x" })), new Response("<html>oops</html>")];
    const { fn } = fakeFetch(() => bodies.shift()!);
    const p = openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV });
    expect((await caught(p.chat(REQ))).code).toBe(ErrorCode.UPSTREAM);
    expect((await caught(p.chat(REQ))).code).toBe(ErrorCode.UPSTREAM);
  });
});

describe("OpenAI 兼容 provider：失败面", () => {
  it("HTTP 429 → RATE_LIMITED（retryable）", async () => {
    const { fn } = fakeFetch(() => json({ error: { message: "rate limit" } }, 429));
    const e = await caught(openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV }).chat(REQ));
    expect(e.code).toBe(ErrorCode.RATE_LIMITED);
    expect(e.retryable).toBe(true);
  });

  it("HTTP 500 / 503 → UPSTREAM（retryable）", async () => {
    for (const status of [500, 503]) {
      const { fn } = fakeFetch(() => json({ error: "server" }, status));
      const e = await caught(openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV }).chat(REQ));
      expect(e.code).toBe(ErrorCode.UPSTREAM);
      expect(e.retryable).toBe(true);
      expect(e.message).toContain(String(status));
    }
  });

  it("其他 4xx → UPSTREAM（不可重试）；错误信息不含密钥", async () => {
    const { fn } = fakeFetch(() => json({ error: { message: "invalid api key" } }, 401));
    const e = await caught(openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV }).chat(REQ));
    expect(e.code).toBe(ErrorCode.UPSTREAM);
    expect(e.retryable).toBe(false);
    expect(e.message).not.toContain("sk-test-secret");
  });

  it("网络错误 → UPSTREAM（retryable）", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const e = await caught(openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV }).chat(REQ));
    expect(e.code).toBe(ErrorCode.UPSTREAM);
    expect(e.retryable).toBe(true);
  });

  it("超时 → UPSTREAM（retryable），请求被 abort", async () => {
    let aborted = false;
    const fn = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        }),
    ) as unknown as typeof fetch;
    const e = await caught(openAICompatibleProvider(LLM, { fetchImpl: fn, env: ENV, timeoutMs: 20 }).chat(REQ));
    expect(e.code).toBe(ErrorCode.UPSTREAM);
    expect(e.retryable).toBe(true);
    expect(e.message).toContain("超时");
    expect(aborted).toBe(true);
  });

  it("缺密钥 → CONFIG，且不发请求；构造时不读密钥、不联网", async () => {
    const { fn, calls } = fakeFetch(() => json({}));
    const env: Record<string, string | undefined> = {};
    const p = openAICompatibleProvider(LLM, { fetchImpl: fn, env });
    expect(calls).toHaveLength(0);
    const e = await caught(p.chat(REQ));
    expect(e.code).toBe(ErrorCode.CONFIG);
    expect(e.message).toContain("TEST_LLM_KEY");
    expect(calls).toHaveLength(0);
  });

  it("缺 apiKeyEnv / baseURL / model → CONFIG", async () => {
    const { fn } = fakeFetch(() => json({}));
    for (const llm of [
      { ...LLM, apiKeyEnv: undefined },
      { ...LLM, baseURL: undefined },
      { ...LLM, model: undefined },
    ]) {
      expect((await caught(openAICompatibleProvider(llm, { fetchImpl: fn, env: ENV }).chat(REQ))).code).toBe(ErrorCode.CONFIG);
    }
  });

  it("导出的工厂：用全局 fetch（vi.stubGlobal）与 process.env（vi.stubEnv）", async () => {
    const { fn, calls } = fakeFetch(() => json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    vi.stubGlobal("fetch", fn);
    const p = createOpenAICompatibleProvider(LLM);
    expect((await caught(p.chat(REQ))).code).toBe(ErrorCode.CONFIG); // 环境变量尚未设置
    vi.stubEnv("TEST_LLM_KEY", "sk-from-env");
    const r = await p.chat(REQ);
    expect(r.message.content).toBe("ok");
    expect((calls[0]!.init.headers as Record<string, string>)["authorization"]).toBe("Bearer sk-from-env");
  });
});

