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

  it("调用技能不允许的工具 → VALIDATION 工具消息，不进 registry，运行继续", async () => {
    const { agent, provider, tools } = setup([
      { toolCalls: [{ name: "propose_update", arguments: { ref: { type: "opportunity", id: "opp_1" }, patch: {}, reason: "x" } }] },
      { content: "抱歉，晨报不能修改 CRM" },
    ]);
    const r = await agent.run(input("/晨报"));
    expect(r.stoppedBy).toBe("final");
    expect(r.reply).toBe("抱歉，晨报不能修改 CRM");
    expect(tools.calls).toHaveLength(0);
    expect(r.toolCalls).toEqual([{ name: "propose_update", ok: false, ms: 0, errorCode: "VALIDATION" }]);
    const [msg] = toolMessages(provider.requests[1]);
    expect(msg?.toolCallId).toBe("call_0_0");
    expect(JSON.parse(msg!.content)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  it("工具参数不是合法 JSON → VALIDATION 工具消息", async () => {
    const provider: LlmProvider = {
      id: "bad-json",
      disclosure: { providerName: "测试", modelName: "bad" },
      chat: async (req) =>
        req.messages.some((m) => m.role === "tool")
          ? { message: { role: "assistant", content: "完成" }, usage: { inputTokens: 1, outputTokens: 1 }, finishReason: "stop" }
          : {
              message: { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "crm_search", arguments: "{oops" }] },
              usage: { inputTokens: 1, outputTokens: 1 },
              finishReason: "tool_calls",
            },
    };
    const { agent, tools } = setup([], { provider });
    const r = await agent.run(input("查一下"));
    expect(r.stoppedBy).toBe("final");
    expect(r.toolCalls[0]).toMatchObject({ name: "crm_search", ok: false, errorCode: "VALIDATION" });
    expect(tools.calls).toHaveLength(0);
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
    expect(tools.calls[0]!.input).toEqual({ scope: "me", closingWithinDays: 30 });
    expect(tools.calls[0]!.ctx).toMatchObject({ actor: ZHANG, traceId: "t-b1", skill: "daily-brief" });
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

