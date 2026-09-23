// spec 第 6 节 T2 行②（Agent 循环部分）：路由（显式 skill / 命令前缀 / 缺省 assistant）、roles 拒绝、只暴露 allowedTools、
// 调用未授权工具得到 VALIDATION 工具消息、SECURITY_PREAMBLE 在系统提示中、max_steps / budget 停止、provider 抛错 → stoppedBy=error、
// proposals 回收、审计写入。
import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  KaidanError,
  SECURITY_PREAMBLE,
  formatToolResultForModel,
  type AgentDeps,
  type AgentRunInput,
  type LlmProvider,
  type LlmRequest,
  type ScriptStep,
  type ToolContext,
} from "@kaidan/contracts";
import { createAgentRuntime, createScriptedProvider } from "../src/index.js";
import { ADMIN, FakeAudit, FakeProposals, FakeRegistry, START, TENANT, ZHANG, skillSet } from "./fakes.js";

function setup(steps: ScriptStep[], over: Partial<AgentDeps> = {}) {
  const provider = createScriptedProvider(steps, { providerName: "测试", modelName: "scripted" });
  const tools = new FakeRegistry();
  const audit = new FakeAudit();
  const proposals = new FakeProposals();
  const agent = createAgentRuntime({
    provider,
    tools,
    audit,
    proposals,
    skills: skillSet(),
    timezone: "Asia/Shanghai",
    clock: () => new Date(START),
    ...over,
  });
  return { agent, provider, tools, audit, proposals };
}

function input(text: string, over: Partial<AgentRunInput> = {}): AgentRunInput {
  return { actor: ZHANG, text, traceId: "t-1", channel: "cli", ...over };
}

function userText(req: LlmRequest | undefined): string {
  const m = req?.messages.find((x) => x.role === "user");
  return m?.role === "user" ? m.content : "";
}

function systemText(req: LlmRequest | undefined): string {
  return (req?.messages ?? []).flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n");
}

function toolMessages(req: LlmRequest | undefined) {
  return (req?.messages ?? []).flatMap((m) => (m.role === "tool" ? [m] : []));
}

describe("路由", () => {
  it("显式 skill 优先于命令前缀；文本恰为该技能命令时，用户消息用技能名", async () => {
    const { agent, provider } = setup([{ content: "好" }]);
    const r = await agent.run(input("/晨报", { skill: "daily-brief" }));
    expect(r.skill).toBe("daily-brief");
    expect(userText(provider.requests[0])).toBe("daily-brief");

    const { agent: a2, provider: p2 } = setup([{ content: "好" }]);
    const r2 = await a2.run(input("/周报 看看本周", { skill: "deal-review" }));
    expect(r2.skill).toBe("deal-review");
    expect(userText(p2.requests[0])).toBe("/周报 看看本周");
  });

  it("命令前缀：去掉命令后作为用户文本", async () => {
    const { agent, provider } = setup([{ content: "好" }]);
    const r = await agent.run(input("  /会后 今天和华东精密开会，对方确认方案 "));
    expect(r.skill).toBe("post-meeting");
    expect(userText(provider.requests[0])).toBe("今天和华东精密开会，对方确认方案");
  });

  it("无命令 / 未知命令 → 缺省 assistant，原文作为用户文本", async () => {
    const { agent, provider } = setup([{ content: "a" }, { content: "b" }]);
    expect((await agent.run(input("华东精密最近怎么样"))).skill).toBe("assistant");
    expect((await agent.run(input("/不存在的命令 你好"))).skill).toBe("assistant");
    expect(userText(provider.requests[1])).toBe("/不存在的命令 你好");
  });

  it("skills() 返回加载的技能清单", () => {
    const { agent } = setup([]);
    expect(agent.skills().map((s) => s.name)).toEqual(skillSet().map((s) => s.name));
  });
});

describe("权限与工具暴露", () => {
  it("技能 roles 不含 actor 角色 → 不调模型，stoppedBy=forbidden，写 permission_denied{skill}", async () => {
    const { agent, provider, audit } = setup([{ content: "不应被调用" }]);
    const r = await agent.run(input("/初始化"));
    expect(r.skill).toBe("setup");
    expect(r.stoppedBy).toBe("forbidden");
    expect(r.steps).toBe(0);
    expect(r.reply).toContain("权限");
    expect(provider.requests).toHaveLength(0);
    expect(audit.events.map((e) => [e.type, e.data])).toEqual([["permission_denied", { skill: "setup" }]]);
  });

  it("admin 可以使用 setup，且只暴露 schema_inspect", async () => {
    const { agent, provider } = setup([{ content: "mapping 草稿" }]);
    const r = await agent.run(input("/初始化", { actor: ADMIN }));
    expect(r.stoppedBy).toBe("final");
    expect(provider.requests[0]?.tools?.map((t) => t.name)).toEqual(["schema_inspect"]);
  });

  it("只把 skill.allowedTools 暴露给模型；parameters 为 JSON Schema 且去掉顶层 $schema", async () => {
    const { agent, provider } = setup([{ content: "晨报" }]);
    await agent.run(input("/晨报"));
    const tools = provider.requests[0]?.tools ?? [];
    expect(tools.map((t) => t.name).sort()).toEqual(["calendar_today", "crm_get", "crm_timeline", "pipeline_snapshot"]);
    const pipeline = tools.find((t) => t.name === "pipeline_snapshot")!;
    expect(pipeline.description).toBe("pipeline_snapshot 的说明");
    expect(pipeline.parameters).not.toHaveProperty("$schema");
    expect(pipeline.parameters).toMatchObject({
      type: "object",
      properties: { scope: { type: "string", enum: ["me", "team"] } },
      required: ["scope"],
    });
    for (const t of tools) expect(t.parameters).not.toHaveProperty("$schema");
  });

  it("调用技能不允许的工具 → 照样交给 registry（ctx 带技能的 allowedTools），由 registry 返回 VALIDATION，运行继续", async () => {
    const { agent, provider, tools } = setup([
      { toolCalls: [{ name: "propose_update", arguments: { ref: { type: "opportunity", id: "opp_1" }, patch: {}, reason: "x" } }] },
      { content: "抱歉，晨报不能修改 CRM" },
    ]);
    const r = await agent.run(input("/晨报"));
    expect(r.stoppedBy).toBe("final");
    expect(r.reply).toBe("抱歉，晨报不能修改 CRM");
    // 第 3 轮 R1：被拒的调用也进 registry —— ctx 带着 daily-brief 的 allowedTools，参数是模型给的原始 JSON 字符串
    expect(tools.calls).toHaveLength(1);
    expect(tools.calls[0]!.name).toBe("propose_update");
    expect(tools.calls[0]!.ctx.allowedTools).toEqual(["pipeline_snapshot", "calendar_today", "crm_get", "crm_timeline"]);
    expect(tools.calls[0]!.input).toBe('{"ref":{"type":"opportunity","id":"opp_1"},"patch":{},"reason":"x"}');
    // r.toolCalls 是 registry 给的结果（FakeRegistry 拒绝时 ms=1；第 2 轮 agent 自己拦截时是 0）
    expect(r.toolCalls).toEqual([{ name: "propose_update", ok: false, ms: 1, errorCode: "VALIDATION" }]);
    const [msg] = toolMessages(provider.requests[1]);
    expect(msg?.toolCallId).toBe("call_0_0");
    expect(JSON.parse(msg!.content)).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "当前技能不允许调用工具 propose_update" },
    });
  });

  it("工具参数不是合法 JSON → 原始字符串照样交给 registry，由 registry 返回 VALIDATION", async () => {
    const seen: LlmRequest[] = [];
    const provider: LlmProvider = {
      id: "bad-json",
      disclosure: { providerName: "测试", modelName: "bad" },
      chat: async (req) => {
        seen.push(req);
        return req.messages.some((m) => m.role === "tool")
          ? { message: { role: "assistant", content: "完成" }, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }
          : {
              message: { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "crm_search", arguments: "{oops" }] },
              usage: { inputTokens: 1, outputTokens: 1 },
              finishReason: "tool_calls",
            };
      },
    };
    const { agent, tools } = setup([], { provider });
    const r = await agent.run(input("查一下"));
    expect(r.stoppedBy).toBe("final");
    expect(r.toolCalls).toEqual([{ name: "crm_search", ok: false, ms: 1, errorCode: "VALIDATION" }]);
    expect(tools.calls.map((c) => [c.name, c.input])).toEqual([["crm_search", "{oops"]]);
    expect(tools.calls[0]!.ctx.allowedTools).toEqual(skillSet().find((s) => s.name === "assistant")!.allowedTools);
    expect(JSON.parse(toolMessages(seen[1])[0]!.content)).toEqual({
      ok: false,
      error: { code: "VALIDATION", message: "工具 crm_search 的参数不是合法 JSON" },
    });
  });
});

describe("系统提示", () => {
  it("= systemPreamble + SECURITY_PREAMBLE 全文 + 技能正文 + 当前时间与用户", async () => {
    const { agent, provider } = setup([{ content: "好" }], { systemPreamble: "你是开单助手。" });
    await agent.run(input("/晨报"));
    const sys = systemText(provider.requests[0]);
    expect(sys).toContain(SECURITY_PREAMBLE);
    expect(sys.indexOf("你是开单助手。")).toBe(0);
    expect(sys.indexOf(SECURITY_PREAMBLE)).toBeLessThan(sys.indexOf("BODY_daily-brief"));
    expect(sys).toContain("2026-09-21 09:00 星期一");
    expect(sys).toContain("Asia/Shanghai");
    expect(sys).toContain("张三（rep）");
    expect(provider.requests[0]?.messages[0]?.role).toBe("system");
  });

  it("没有 systemPreamble 时以 SECURITY_PREAMBLE 开头", async () => {
    const { agent, provider } = setup([{ content: "好" }]);
    await agent.run(input("你好"));
    expect(systemText(provider.requests[0]).startsWith(SECURITY_PREAMBLE)).toBe(true);
  });
});

describe("工具循环", () => {
  it("B1 形状：同一步两个工具按顺序执行，工具消息 = formatToolResultForModel，steps=2", async () => {
    const { agent, provider, tools } = setup([
      {
        toolCalls: [
          { name: "pipeline_snapshot", arguments: { scope: "me", closingWithinDays: 30 } },
          { name: "calendar_today", arguments: {} },
        ],
      },
      { content: "晨报（测试）" },
    ]);
    tools.handlers.set("pipeline_snapshot", () => ({ ok: true, output: { openAmount: 600000 }, ms: 5 }));
    const r = await agent.run(input("/晨报", { skill: "daily-brief", channel: "schedule", traceId: "t-b1" }));

    expect(r).toMatchObject({ stoppedBy: "final", skill: "daily-brief", steps: 2, reply: "晨报（测试）", traceId: "t-b1" });
    expect(r.toolCalls).toEqual([
      { name: "pipeline_snapshot", ok: true, ms: 5 },
      { name: "calendar_today", ok: true, ms: 1 },
    ]);
    expect(tools.calls.map((c) => c.name)).toEqual(["pipeline_snapshot", "calendar_today"]);
    // 第 3 轮 R1：参数是模型给的原始 JSON 字符串，ctx 带技能的 allowedTools（解析与越界拦截都在 registry）
    expect(tools.calls[0]!.input).toBe('{"scope":"me","closingWithinDays":30}');
    expect(tools.calls[0]!.ctx).toMatchObject({
      actor: ZHANG,
      traceId: "t-b1",
      skill: "daily-brief",
      allowedTools: ["pipeline_snapshot", "calendar_today", "crm_get", "crm_timeline"],
    });
    expect(tools.calls[0]!.ctx.now.toISOString()).toBe(new Date(START).toISOString());

    const msgs = toolMessages(provider.requests[1]);
    expect(msgs.map((m) => m.toolCallId)).toEqual(["call_0_0", "call_0_1"]);
    expect(msgs[0]!.content).toBe(formatToolResultForModel({ ok: true, output: { openAmount: 600000 }, ms: 5 }));
    // 第 2 次请求带着 assistant 的 toolCalls 消息
    const assistant = provider.requests[1]!.messages.find((m) => m.role === "assistant");
    expect(assistant?.role === "assistant" && assistant.toolCalls?.length).toBe(2);
    expect(r.disclosure).toEqual({ providerName: "测试", modelName: "scripted" });
  });

  it("reply = 最后一条 assistant 的 content（null 视为空串）", async () => {
    const provider: LlmProvider = {
      id: "null-content",
      disclosure: { providerName: "测试", modelName: "n" },
      chat: async () => ({ message: { role: "assistant", content: null }, usage: { inputTokens: 1, outputTokens: 0 }, finishReason: "stop" }),
    };
    const { agent } = setup([], { provider });
    const r = await agent.run(input("你好"));
    expect(r).toMatchObject({ stoppedBy: "final", reply: "", steps: 1 });
  });

  it("registry.invoke 意外抛错 → 工具消息 ok:false，不中断", async () => {
    const { agent, provider, tools } = setup([
      { toolCalls: [{ name: "crm_search", arguments: { type: "opportunity" } }] },
      { content: "查询失败了" },
    ]);
    tools.handlers.set("crm_search", () => {
      throw new Error("boom");
    });
    const r = await agent.run(input("查商机"));
    expect(r.stoppedBy).toBe("final");
    expect(r.toolCalls[0]).toMatchObject({ ok: false, errorCode: "UPSTREAM" });
    expect(JSON.parse(toolMessages(provider.requests[1])[0]!.content)).toMatchObject({ ok: false });
  });

  it("proposals 回收：成功的 propose_* 输出里的 proposalId 经 proposals.get 取回；失败的不算", async () => {
    const { agent, tools, proposals } = setup([
      {
        toolCalls: [
          { name: "propose_update", arguments: { ref: { type: "opportunity", id: "opp_1" }, patch: { stage: "negotiation" }, reason: "会后" } },
          { name: "propose_update", arguments: { ref: { type: "opportunity", id: "opp_3" }, patch: { stage: "won" }, reason: "越权" } },
          { name: "propose_create", arguments: { objectType: "task", data: { title: "发送报价单" }, reason: "待办" } },
        ],
      },
      { content: "已生成更新提案" },
    ]);
    const created: string[] = [];
    const propose = async (targetId: string | undefined, kind: "update" | "create") => {
      const p = await proposals.create({
        tenantId: TENANT,
        actorUserId: ZHANG.userId,
        kind,
        objectType: kind === "update" ? "opportunity" : "task",
        ...(targetId ? { targetId } : {}),
        patch: {},
        diff: [],
        reason: "r",
        traceId: "t-1",
      });
      created.push(p.id);
      return { ok: true as const, output: { proposalId: p.id, status: "pending", diff: [], expiresAt: p.expiresAt }, ms: 2 };
    };
    tools.handlers.set("propose_update", async (_ctx, raw) => {
      const id = (raw as { ref: { id: string } }).ref.id;
      if (id === "opp_3") return { ok: false, error: { code: ErrorCode.PERMISSION_DENIED, message: "无权限访问该记录" }, ms: 1 };
      return propose(id, "update");
    });
    tools.handlers.set("propose_create", () => propose(undefined, "create"));

    const r = await agent.run(input("/会后 开完会了"));
    expect(r.proposals.map((p) => p.id)).toEqual(created);
    expect(r.proposals.map((p) => [p.kind, p.status])).toEqual([
      ["update", "pending"],
      ["create", "pending"],
    ]);
    expect(r.toolCalls.map((c) => c.errorCode)).toEqual([undefined, "PERMISSION_DENIED", undefined]);
  });
});

describe("停止条件", () => {
  const loopForever: ScriptStep[] = Array.from({ length: 20 }, () => ({
    toolCalls: [{ name: "crm_search", arguments: { type: "opportunity" } }],
  }));

  it("超过 maxSteps → stoppedBy=max_steps，reply 说明原因", async () => {
    const { agent, provider } = setup(loopForever, { limits: { maxSteps: 3 } });
    const r = await agent.run(input("一直查"));
    expect(r.stoppedBy).toBe("max_steps");
    expect(r.steps).toBe(3);
    expect(provider.requests).toHaveLength(3);
    expect(r.reply).toContain("步数上限");
  });

  it("缺省 maxSteps = 8", async () => {
    const { agent } = setup(loopForever);
    const r = await agent.run(input("一直查"));
    expect(r).toMatchObject({ stoppedBy: "max_steps", steps: 8 });
  });

  it("超过 maxToolCalls → stoppedBy=budget，超出的调用不执行", async () => {
    const { agent, tools } = setup(
      [
        {
          toolCalls: [
            { name: "crm_search", arguments: { type: "opportunity" } },
            { name: "crm_search", arguments: { type: "account" } },
            { name: "crm_search", arguments: { type: "contact" } },
          ],
        },
        { content: "不应到达" },
      ],
      { limits: { maxToolCalls: 2 } },
    );
    const r = await agent.run(input("查三次"));
    expect(r.stoppedBy).toBe("budget");
    expect(tools.calls).toHaveLength(2);
    expect(r.toolCalls).toHaveLength(2);
    expect(r.reply).toContain("工具调用次数");
  });

  it("累计 inputTokens 达到 maxInputTokens → stoppedBy=budget", async () => {
    let n = 0;
    const provider: LlmProvider = {
      id: "costly",
      disclosure: { providerName: "测试", modelName: "costly" },
      chat: async () => {
        n++;
        return {
          message: { role: "assistant", content: `第${n}步`, toolCalls: [{ id: `c${n}`, name: "crm_search", arguments: '{"type":"task"}' }] },
          usage: { inputTokens: 600, outputTokens: 10 },
          finishReason: "tool_calls",
        };
      },
    };
    const { agent } = setup([], { provider, limits: { maxInputTokens: 1000 } });
    const r = await agent.run(input("查"));
    expect(r.stoppedBy).toBe("budget");
    expect(r.steps).toBe(2);
    expect(r.usage).toEqual({ inputTokens: 1200, outputTokens: 20 });
    expect(r.reply).toContain("第2步");
    expect(r.reply).toContain("token");
  });

  it("provider 抛 RATE_LIMITED → stoppedBy=error，友好提示，不抛出", async () => {
    const provider: LlmProvider = {
      id: "limited",
      disclosure: { providerName: "测试", modelName: "x" },
      chat: async () => {
        throw new KaidanError(ErrorCode.RATE_LIMITED, "HTTP 429", { retryable: true });
      },
    };
    const { agent, audit } = setup([], { provider });
    const r = await agent.run(input("你好"));
    expect(r).toMatchObject({ stoppedBy: "error", steps: 0, proposals: [] });
    expect(r.reply).toContain("稍后再试");
    expect(r.reply).not.toContain("429");
    expect(audit.types()).toEqual(["skill_invoked"]);
  });

  it("provider 在第 2 步抛普通错误 → stoppedBy=error，已完成的步骤与工具调用保留", async () => {
    const { agent } = setup([{ toolCalls: [{ name: "crm_search", arguments: { type: "opportunity" } }] }]);
    // 脚本只有 1 步，第 2 次调用会抛 CONFIG（步骤用完）
    const r = await agent.run(input("查一下"));
    expect(r.stoppedBy).toBe("error");
    expect(r.steps).toBe(1);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.reply.length).toBeGreaterThan(0);
  });
});

describe("审计", () => {
  it("开始写 skill_invoked{skill,channel}；每次 LLM 调用写 llm_call{provider,inputTokens,outputTokens,finishReason}", async () => {
    const { agent, audit } = setup([
      { toolCalls: [{ name: "calendar_today", arguments: {} }] },
      { content: "完成" },
    ]);
    await agent.run(input("/晨报", { channel: "feishu", traceId: "t-audit" }));
    expect(audit.types()).toEqual(["skill_invoked", "llm_call", "llm_call"]);
    expect(audit.events.every((e) => e.traceId === "t-audit" && e.tenantId === TENANT && e.actorUserId === ZHANG.userId)).toBe(true);
    expect(audit.events[0]!.data).toEqual({ skill: "daily-brief", channel: "feishu" });
    expect(audit.events[1]!.data).toEqual({ provider: "scripted", inputTokens: 0, outputTokens: 0, finishReason: "tool_calls" });
    expect(audit.events[2]!.data).toMatchObject({ finishReason: "stop" });
  });

  it("审计 data 不含用户正文", async () => {
    const { agent, audit } = setup([{ content: "好" }]);
    await agent.run(input("/会后 客户手机 13800000001"));
    expect(JSON.stringify(audit.events)).not.toContain("13800000001");
  });

  it("显式指定未加载的技能 → stoppedBy=error，不调模型、不抛出", async () => {
    const { agent, provider } = setup([{ content: "x" }], { skills: skillSet().filter((s) => s.name !== "weekly-review") });
    const r = await agent.run(input("/周报", { skill: "weekly-review" }));
    expect(r.stoppedBy).toBe("error");
    expect(provider.requests).toHaveLength(0);
  });
});

describe("第 3 轮 R1：技能边界与参数解析交给 registry", () => {
  it("FakeRegistry 与第 3 轮 registry 契约一致：越界与未知工具名同一句文案、字符串参数由它解析、不带 allowedTools 不设边界", async () => {
    const tools = new FakeRegistry();
    const ctx: ToolContext = { actor: ZHANG, traceId: "t-fake", now: new Date(START) };
    const gated: ToolContext = { ...ctx, allowedTools: ["crm_get", "schema_inspect"] };
    const rejected = (message: string) => ({ ok: false, error: { code: "VALIDATION", message }, ms: 1 });
    expect(await tools.invoke(gated, "propose_update", { reason: "x" })).toEqual(rejected("当前技能不允许调用工具 propose_update"));
    expect(await tools.invoke(gated, "crm_delete", "{}")).toEqual(rejected("当前技能不允许调用工具 crm_delete"));
    expect(await tools.invoke(gated, "crm_get", '{"type":"opportunity","id":"opp_1"}')).toEqual({
      ok: true,
      output: { echo: { type: "opportunity", id: "opp_1" } },
      ms: 1,
    });
    expect(await tools.invoke(gated, "schema_inspect", "")).toEqual({ ok: true, output: { echo: {} }, ms: 1 });
    expect(await tools.invoke(gated, "crm_get", "{不是 JSON")).toEqual(rejected("工具 crm_get 的参数不是合法 JSON"));
    // 不带 allowedTools（MCP 口径）= 不设技能边界；对象参数照旧直接用
    expect(await tools.invoke(ctx, "propose_update", { reason: "x" })).toEqual({ ok: true, output: { echo: { reason: "x" } }, ms: 1 });
    expect(tools.calls.map((c) => c.name)).toEqual(["propose_update", "crm_delete", "crm_get", "schema_inspect", "crm_get", "propose_update"]);
  });

  it("参数为空串 → 原样交给 registry（由 registry 视为 {}），调用成功", async () => {
    const provider: LlmProvider = {
      id: "empty-args",
      disclosure: { providerName: "测试", modelName: "empty" },
      chat: async (req) =>
        req.messages.some((m) => m.role === "tool")
          ? { message: { role: "assistant", content: "好" }, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }
          : {
              message: { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "calendar_today", arguments: "" }] },
              usage: { inputTokens: 1, outputTokens: 1 },
              finishReason: "tool_calls",
            },
    };
    const { agent, tools } = setup([], { provider });
    const r = await agent.run(input("/晨报"));
    expect(tools.calls.map((c) => [c.name, c.input])).toEqual([["calendar_today", ""]]);
    expect(r.toolCalls).toEqual([{ name: "calendar_today", ok: true, ms: 1 }]);
    expect(r).toMatchObject({ stoppedBy: "final", reply: "好" });
  });
});

describe("第 3 轮 R3：说了「已生成提案」却没调写入工具 → 补救追问一次", () => {
  const PROPOSE = {
    name: "propose_update",
    arguments: { ref: { type: "opportunity", id: "opp_1" }, patch: { nextStep: "发报价单" }, reason: "会后" },
  };
  const FOLLOW_UP = { role: "user", content: "你还没有调用写入工具，现在只输出工具调用" };

  /** propose_update 成功时生成一个真提案（FakeProposals），供 r.proposals 回收 */
  function proposeOk(h: ReturnType<typeof setup>) {
    h.tools.handlers.set("propose_update", async () => {
      const p = await h.proposals.create({
        tenantId: TENANT,
        actorUserId: ZHANG.userId,
        kind: "update",
        objectType: "opportunity",
        targetId: "opp_1",
        patch: {},
        diff: [],
        reason: "会后",
        traceId: "t-1",
      });
      return { ok: true, output: { proposalId: p.id, status: "pending", diff: [], expiresAt: p.expiresAt }, ms: 2 };
    });
  }

  it('0 个提案却声称已生成 → 追加 user 消息、带 toolChoice="required" 追问一次，拿到提案；首次与之后的请求都不带 toolChoice', async () => {
    const h = setup([{ content: "已生成提案" }, { toolCalls: [PROPOSE] }, { content: "好了" }]);
    proposeOk(h);
    const r = await h.agent.run(input("/会后 今天和华东精密开会，对方要求周三前出报价"));
    expect(h.provider.requests.map((q) => q.toolChoice)).toEqual([undefined, "required", undefined]);
    expect(h.provider.requests[1]!.messages.slice(-2)).toEqual([{ role: "assistant", content: "已生成提案" }, FOLLOW_UP]);
    expect(h.provider.requests[1]!.tools?.map((t) => t.name)).toEqual(h.provider.requests[0]!.tools?.map((t) => t.name));
    expect(r).toMatchObject({ stoppedBy: "final", steps: 3, reply: "好了" });
    expect(r.proposals.map((p) => p.targetId)).toEqual(["opp_1"]);
  });

  it("追问后仍没有提案 → 如实回复「这次没有生成提案」，而且只追问一次", async () => {
    const h = setup([{ content: "已记录会议要点" }, { content: "已更新" }]);
    const r = await h.agent.run(input("/会后 今天和华东精密开会"));
    expect(h.provider.requests.map((q) => q.toolChoice)).toEqual([undefined, "required"]);
    expect(r).toMatchObject({ stoppedBy: "final", steps: 2, proposals: [] });
    expect(r.reply).toContain("这次没有生成提案");
  });

  it("四个触发词（提案 / 已更新 / 已生成 / 已记录）都会触发追问", async () => {
    for (const word of ["提案", "已更新", "已生成", "已记录"]) {
      const h = setup([{ content: `好的，${word}` }, { content: "没有要写的" }]);
      await h.agent.run(input("/会后 开完会了"));
      expect(h.provider.requests.map((q) => q.toolChoice), word).toEqual([undefined, "required"]);
    }
  });

  it("写入工具调用失败不算提案：失败后仍声称已生成提案 → 照样追问", async () => {
    const h = setup([{ toolCalls: [PROPOSE] }, { content: "已生成提案" }, { content: "好" }]);
    h.tools.handlers.set("propose_update", () => ({ ok: false, error: { code: ErrorCode.PERMISSION_DENIED, message: "无权限访问该记录" }, ms: 1 }));
    const r = await h.agent.run(input("/会后 开完会了"));
    expect(h.provider.requests.map((q) => q.toolChoice)).toEqual([undefined, undefined, "required"]);
    expect(r).toMatchObject({ stoppedBy: "final", steps: 3, proposals: [] });
    expect(r.reply).toContain("这次没有生成提案");
  });

  it("不追问：回复没有触发词、技能不含 propose_*、或本轮已有提案", async () => {
    const a = setup([{ content: "今天没有要改的" }]);
    const ra = await a.agent.run(input("/会后 只是寒暄"));
    expect(a.provider.requests.map((q) => q.toolChoice)).toEqual([undefined]);
    expect(ra).toMatchObject({ stoppedBy: "final", steps: 1, reply: "今天没有要改的" });

    const b = setup([{ content: "已生成晨报" }]);
    const rb = await b.agent.run(input("/晨报"));
    expect(b.provider.requests).toHaveLength(1);
    expect(rb).toMatchObject({ stoppedBy: "final", steps: 1, reply: "已生成晨报" });

    const c = setup([{ toolCalls: [PROPOSE] }, { content: "已生成提案" }]);
    proposeOk(c);
    const rc = await c.agent.run(input("/会后 开完会了"));
    expect(c.provider.requests.map((q) => q.toolChoice)).toEqual([undefined, undefined]);
    expect(rc).toMatchObject({ stoppedBy: "final", steps: 2, reply: "已生成提案" });
    expect(rc.proposals).toHaveLength(1);
  });

  it("追问计入 maxSteps：步数用完就不追问，stoppedBy=max_steps", async () => {
    const h = setup([{ content: "已生成提案" }, { content: "不应到达" }], { limits: { maxSteps: 1 } });
    const r = await h.agent.run(input("/会后 开完会了"));
    expect(h.provider.requests).toHaveLength(1);
    expect(r).toMatchObject({ stoppedBy: "max_steps", steps: 1 });
    expect(r.reply).toContain("步数上限");
  });
});
