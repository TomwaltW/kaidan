// ToolRegistry：工具清单、输入校验、读工具、propose_* 规则、出口净化、invoke 永不抛出、审计。
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ErrorCode, KaidanError, ToolName, type ToolContext, type ToolInvokeResult } from "@kaidan/contracts";
import { createToolRegistry, maskPhonesInText } from "../src/index.js";
import { ADMIN, LI, NOW, WANG, ZHANG, fixture, loadMini, type Fixture } from "./fakes.js";

const ctx = (actor = ZHANG, traceId = "t-1", skill?: string): ToolContext => ({
  actor,
  traceId,
  now: NOW,
  ...(skill ? { skill } : {}),
});

function setup(f: Fixture = fixture()) {
  return { f, reg: createToolRegistry(f.deps) };
}

function out<T>(r: ToolInvokeResult): T {
  if (!r.ok) throw new Error(`工具失败：${JSON.stringify(r.error)}`);
  return r.output as T;
}
function code(r: ToolInvokeResult): string | undefined {
  return r.ok ? undefined : r.error.code;
}
function hasKeyDeep(v: unknown, key: string): boolean {
  if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, key));
  if (v && typeof v === "object") return Object.entries(v).some(([k, x]) => k === key || hasKeyDeep(x, key));
  return false;
}

describe("工具清单", () => {
  it("恰好 8 个工具，名字与 ToolName 一致；描述为中文；readOnly / adminOnly 标记正确", () => {
    const { reg } = setup();
    const tools = reg.list();
    expect(tools.map((t) => t.name).sort()).toEqual([...ToolName.options].sort());
    for (const t of tools) expect(t.description).toMatch(/[一-龥]/);
    expect(tools.filter((t) => !t.readOnly).map((t) => t.name).sort()).toEqual(["propose_create", "propose_update"]);
    expect(tools.filter((t) => t.adminOnly).map((t) => t.name)).toEqual(["schema_inspect"]);
  });

  it("list({names}) 只返回指定工具；get 取单个", () => {
    const { reg } = setup();
    expect(reg.list({ names: ["pipeline_snapshot", "calendar_today"] }).map((t) => t.name)).toEqual([
      "pipeline_snapshot",
      "calendar_today",
    ]);
    expect(reg.get("crm_get")?.name).toBe("crm_get");
  });

  it("每个工具的 input 都能转成 JSON Schema（agent / MCP 用 z.toJSONSchema）", () => {
    const { reg } = setup();
    for (const t of reg.list()) {
      const schema = z.toJSONSchema(t.input) as { type?: string };
      expect(schema.type).toBe("object");
    }
  });
});

describe("输入校验：8 个工具都返回 VALIDATION", () => {
  const bad: [string, unknown][] = [
    ["crm_search", { type: "lead" }],
    ["crm_get", { type: "opportunity" }],
    ["crm_timeline", { limit: 0, opportunityId: "opp_1" }],
    ["pipeline_snapshot", { scope: "company" }],
    ["propose_update", { ref: { type: "opportunity", id: "opp_1" }, patch: { nextStep: "x" }, reason: "" }],
    ["propose_create", { objectType: "task", data: { title: "x" } }],
    ["calendar_today", { date: "9月21日" }],
    ["schema_inspect", 42], // 第 3 轮起字符串参数先按 JSON 解析（见 round3.test.ts），这里用非对象的数字留住 zod 这条路
  ];
  for (const [name, input] of bad) {
    it(`${name} 参数不合法 → VALIDATION`, async () => {
      const { reg, f } = setup();
      const r = await reg.invoke(ctx(ADMIN), name, input);
      expect(code(r)).toBe("VALIDATION");
      expect(f.audit.events[0]!.data).toMatchObject({ tool: name, ok: false, errorCode: "VALIDATION" });
    });
  }

  it("crm_timeline 两个 id 都没给 → VALIDATION", async () => {
    const { reg } = setup();
    expect(code(await reg.invoke(ctx(), "crm_timeline", {}))).toBe("VALIDATION");
  });
});

describe("读工具", () => {
  it("crm_search：B3 按 text 找到 opp_1；只返回可见记录", async () => {
    const { reg } = setup();
    const r = out<{ items: { id: string }[] }>(
      await reg.invoke(ctx(), "crm_search", { type: "opportunity", text: "二期产线" }),
    );
    expect(r.items.map((i) => i.id)).toEqual(["opp_1"]);
    const all = out<{ items: { id: string }[] }>(await reg.invoke(ctx(), "crm_search", { type: "opportunity" }));
    expect(all.items.map((i) => i.id)).toEqual(["opp_1", "opp_2"]);
  });

  it("crm_get：可见 → item；不存在 → {item:null}；不可见 → 固定文案且不含记录内容", async () => {
    const { reg } = setup();
    expect(out<{ item: { id: string } }>(await reg.invoke(ctx(), "crm_get", { type: "opportunity", id: "opp_1" })).item.id).toBe(
      "opp_1",
    );
    expect(out<{ item: null }>(await reg.invoke(ctx(), "crm_get", { type: "opportunity", id: "opp_404" })).item).toBeNull();
    const denied = await reg.invoke(ctx(), "crm_get", { type: "opportunity", id: "opp_3" });
    expect(denied).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED", message: "无权限访问该记录" } });
    expect(JSON.stringify(denied)).not.toMatch(/南海|260000/);
    const wang = await reg.invoke(ctx(WANG), "crm_get", { type: "opportunity", id: "opp_3" });
    expect(out<{ item: { name: string } }>(wang).item.name).toBe("南海外贸-CRM集成");
  });

  it("crm_timeline：活动按 occurredAt 倒序、附带待办；不可见商机 → PERMISSION_DENIED；不存在 → NOT_FOUND", async () => {
    const ds = loadMini();
    ds.activities.push({ ...ds.activities[2]!, id: "act_9", occurredAt: "2026-09-20T10:00:00+08:00" });
    const { reg } = setup(fixture({ dataset: ds }));
    const t = out<{ activities: { id: string }[]; tasks: { id: string }[] }>(
      await reg.invoke(ctx(), "crm_timeline", { opportunityId: "opp_2" }),
    );
    expect(t.activities.map((a) => a.id)).toEqual(["act_9", "act_3"]);
    expect(t.tasks.map((x) => x.id)).toEqual(["task_1"]);
    const byAcc = out<{ activities: { id: string }[] }>(await reg.invoke(ctx(), "crm_timeline", { accountId: "acc_hdjm" }));
    expect(byAcc.activities.map((a) => a.id)).toEqual(["act_1"]);
    const limited = out<{ activities: unknown[] }>(await reg.invoke(ctx(), "crm_timeline", { opportunityId: "opp_2", limit: 1 }));
    expect(limited.activities).toHaveLength(1);
    expect(code(await reg.invoke(ctx(), "crm_timeline", { opportunityId: "opp_3" }))).toBe("PERMISSION_DENIED");
    expect(code(await reg.invoke(ctx(), "crm_timeline", { accountId: "acc_nope" }))).toBe("NOT_FOUND");
  });

  it("calendar_today：缺省日期 = 时区下的今天；只返回本人日程", async () => {
    const f = fixture({ clock: () => new Date("2026-09-20T17:30:00Z") }); // 上海 09-21 01:30
    const { reg } = setup(f);
    const r = out<{ events: { id: string }[] }>(await reg.invoke(ctx(), "calendar_today", {}));
    expect(r.events.map((e) => e.id)).toEqual(["ev_1"]);
    expect(f.context.dates).toEqual(["2026-09-21"]);
    const li = out<{ events: { id: string }[] }>(await reg.invoke(ctx(LI), "calendar_today", { date: "2026-09-21" }));
    expect(li.events.map((e) => e.id)).toEqual(["ev_2"]);
  });

  it("schema_inspect：admin → ok；rep / manager → PERMISSION_DENIED（工具层先检查，不调用适配器）", async () => {
    const { reg } = setup();
    expect(out<{ schema: { source: string } }>(await reg.invoke(ctx(ADMIN), "schema_inspect", {})).schema.source).toBe("mock");
    const denied = await reg.invoke(ctx(ZHANG), "schema_inspect", {});
    expect(denied).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED", message: "只有管理员可以查看表结构" } });
    expect(code(await reg.invoke(ctx(WANG), "schema_inspect", {}))).toBe("PERMISSION_DENIED");
  });
});

describe("出口净化：剔除 raw、手机号只出脱敏形态", () => {
  it("所有输出里都没有 raw 键（含嵌套）", async () => {
    const ds = loadMini();
    for (const o of ds.opportunities) o.raw = { 阶段: o.rawStage, 负责人: [{ id: o.ownerId }] };
    for (const c of ds.contacts) c.raw = { 手机: "13800000001" };
    const { reg } = setup(fixture({ dataset: ds }));
    const results = [
      await reg.invoke(ctx(), "crm_search", { type: "opportunity" }),
      await reg.invoke(ctx(), "crm_get", { type: "opportunity", id: "opp_1" }),
      await reg.invoke(ctx(), "crm_search", { type: "contact" }),
      await reg.invoke(ctx(), "pipeline_snapshot", { scope: "me" }),
    ];
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(hasKeyDeep(r, "raw")).toBe(false);
    }
    expect(JSON.stringify(results)).not.toContain("13800000001");
  });

  it("文本里的完整手机号被脱敏；已脱敏号码保持不变（B4：con_chen → 138****0001）", async () => {
    const ds = loadMini();
    ds.activities[0]!.summary = "客户电话 13912345678，备用 +86 137-1234-5678，座机 021-12345678";
    const { reg } = setup(fixture({ dataset: ds }));
    const acts = out<{ items: { summary?: string }[] }>(await reg.invoke(ctx(), "crm_search", { type: "activity" }));
    expect(acts.items[0]!.summary).toBe("客户电话 139****5678，备用 137****5678，座机 021-12345678");
    const cons = out<{ items: { id: string; phoneMasked?: string }[] }>(await reg.invoke(ctx(), "crm_search", { type: "contact" }));
    expect(cons.items).toEqual([expect.objectContaining({ id: "con_chen", phoneMasked: "138****0001" })]);
    expect(JSON.stringify(acts)).not.toMatch(/1[3-9]\d{9}/);
  });

  it("maskPhonesInText 不误伤长数字与金额", () => {
    expect(maskPhonesInText("订单号 1381234567890123")).toBe("订单号 1381234567890123");
    expect(maskPhonesInText("金额 480000 元")).toBe("金额 480000 元");
    expect(maskPhonesInText("13800000001")).toBe("138****0001");
  });
});

describe("propose_update", () => {
  const B3 = {
    ref: { type: "opportunity", id: "opp_1" },
    patch: { stage: "negotiation", nextStep: "9月24日前发送正式报价单", expectedCloseDate: "2026-10-15" },
    reason: "会后：客户确认方案，进入商务谈判",
  };

  it("B3：diff 顺序 = patch 键顺序，before 取当前值（空字符串保持为空字符串），只产生提案不写入", async () => {
    const { reg, f } = setup();
    const r = out<{ proposalId: string; status: string; diff: unknown[]; expiresAt: string }>(
      await reg.invoke(ctx(ZHANG, "t-b3", "post-meeting"), "propose_update", B3),
    );
    expect(r.status).toBe("pending");
    expect(r.diff).toEqual([
      { field: "stage", before: "solution", after: "negotiation" },
      { field: "nextStep", before: "", after: "9月24日前发送正式报价单" },
      { field: "expectedCloseDate", before: "2026-09-30", after: "2026-10-15" },
    ]);
    expect(Date.parse(r.expiresAt)).toBe(Date.parse("2026-09-22T09:00:00+08:00"));
    expect(f.proposals.created[0]).toMatchObject({
      tenantId: "demo",
      actorUserId: "ou_rep_zhang",
      kind: "update",
      objectType: "opportunity",
      targetId: "opp_1",
      traceId: "t-b3",
      skill: "post-meeting",
      ttlMinutes: 1440,
      reason: B3.reason,
    });
    expect(f.adapter.writeCalls).toBe(0);
    expect(f.adapter.data.opportunities[0]!.stage).toBe("solution");
  });

  it("与当前值相同的字段不进 diff；记录中不存在的字段 before 记为 null；全部相同 → VALIDATION「没有变化」", async () => {
    const { reg, f } = setup();
    const r = out<{ diff: unknown[] }>(
      await reg.invoke(ctx(), "propose_update", {
        ref: { type: "opportunity", id: "opp_1" },
        patch: { stage: "solution", probability: 60, qualification: { pain: "交期" } },
        reason: "补充",
      }),
    );
    expect(r.diff).toEqual([
      { field: "probability", before: null, after: 60 },
      { field: "qualification", before: null, after: { pain: "交期" } },
    ]);
    expect(f.proposals.created[0]!.patch).toEqual({ probability: 60, qualification: { pain: "交期" } });
    const same = await reg.invoke(ctx(), "propose_update", {
      ref: { type: "opportunity", id: "opp_2" },
      patch: { nextStep: "等待法务审核合同", qualification: { pain: "销售数据分散", decision_maker: "CFO", budget: "已批 15 万", timeline: "9 月底签约" } },
      reason: "无变化",
    });
    expect(same).toMatchObject({ ok: false, error: { code: "VALIDATION", message: "没有变化" } });
  });

  it("非可写字段 / 空 patch / 合并后不合法 → VALIDATION；不存在 → NOT_FOUND；都不产生提案", async () => {
    const { reg, f } = setup();
    const call = (patch: object, id = "opp_1") =>
      reg.invoke(ctx(), "propose_update", { ref: { type: "opportunity", id }, patch, reason: "r" });
    expect(code(await call({ ownerId: "ou_rep_li" }))).toBe("VALIDATION");
    expect(code(await call({ rawStage: "赢单" }))).toBe("VALIDATION");
    expect(code(await call({}))).toBe("VALIDATION");
    expect(code(await call({ probability: 150 }))).toBe("VALIDATION");
    expect(code(await call({ stage: "done" }))).toBe("VALIDATION");
    expect(code(await call({ expectedCloseDate: "下周" }))).toBe("VALIDATION");
    expect(code(await call({ nextStep: "x" }, "opp_404"))).toBe("NOT_FOUND");
    expect(code(await call({ accountId: "acc_nhwm" }))).toBe("PERMISSION_DENIED"); // 改挂到不可见客户
    expect(f.proposals.created).toHaveLength(0);
  });

  it("B4：越权提案 → PERMISSION_DENIED，不产生提案，写 permission_denied", async () => {
    const { reg, f } = setup();
    const r = await reg.invoke(ctx(ZHANG, "t-b4-1"), "propose_update", {
      ref: { type: "opportunity", id: "opp_3" },
      patch: { nextStep: "越权修改" },
      reason: "越权测试",
    });
    expect(r).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED", message: "无权限访问该记录" } });
    expect(await f.proposals.listPending("demo", "ou_rep_zhang")).toEqual([]);
    expect(f.audit.events.filter((e) => e.type === "permission_denied")).toHaveLength(1);
  });
});

describe("propose_create", () => {
  it("B3 task：diff 为每个字段 {before:null, after}；缺 status 也能通过（写入时缺省 open）；不写入", async () => {
    const { reg, f } = setup();
    const r = out<{ proposalId: string; diff: unknown[] }>(
      await reg.invoke(ctx(), "propose_create", {
        objectType: "task",
        data: { title: "发送报价单", dueDate: "2026-09-24", opportunityId: "opp_1" },
        reason: "会后待办",
      }),
    );
    expect(r.diff).toEqual([
      { field: "title", before: null, after: "发送报价单" },
      { field: "dueDate", before: null, after: "2026-09-24" },
      { field: "opportunityId", before: null, after: "opp_1" },
    ]);
    expect(f.proposals.created[0]).toMatchObject({ kind: "create", objectType: "task", patch: { title: "发送报价单" } });
    expect(f.proposals.created[0]!.targetId).toBeUndefined();
    expect(f.adapter.writeCalls).toBe(0);
  });

  it("引用不可见 → PERMISSION_DENIED；引用不存在 / 非可写字段 / 缺必填 / 空 data → VALIDATION", async () => {
    const { reg, f } = setup();
    const call = (objectType: string, data: object) => reg.invoke(ctx(), "propose_create", { objectType, data, reason: "r" });
    expect(code(await call("task", { title: "x", opportunityId: "opp_3" }))).toBe("PERMISSION_DENIED");
    expect(code(await call("activity", { kind: "call", subject: "x", occurredAt: "2026-09-21T10:00:00+08:00", contactIds: ["con_liu"] }))).toBe(
      "PERMISSION_DENIED",
    );
    expect(code(await call("task", { title: "x", accountId: "acc_nope" }))).toBe("VALIDATION");
    expect(code(await call("task", { title: "x", ownerId: "ou_rep_li" }))).toBe("VALIDATION");
    expect(code(await call("contact", { accountId: "acc_hdjm", name: "新人", phoneMasked: "138****0000" }))).toBe("VALIDATION");
    expect(code(await call("opportunity", { accountId: "acc_hdjm", name: "三期" }))).toBe("VALIDATION"); // 缺 stage
    expect(code(await call("task", {}))).toBe("VALIDATION");
    expect(f.proposals.created).toHaveLength(0);
    const ok = await call("opportunity", { accountId: "acc_hdjm", name: "三期", stage: "lead", amount: 100000 });
    expect(ok.ok).toBe(true);
  });
});

describe("invoke 永不抛出", () => {
  it("未知工具 / 空输入 → VALIDATION", async () => {
    const { reg, f } = setup();
    expect(await reg.invoke(ctx(), "drop_database", {})).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(code(await reg.invoke(ctx(), "crm_get", null))).toBe("VALIDATION");
    expect(code(await reg.invoke(ctx(), "x".repeat(500), undefined))).toBe("VALIDATION");
    expect((f.audit.events.at(-1)!.data["tool"] as string).length).toBe(64);
  });

  it("适配器抛普通异常 → UPSTREAM（通用文案，不外泄内部信息）；抛 KaidanError → 对应 code", async () => {
    const { reg, f } = setup();
    f.adapter.failNext = new Error("socket hang up at 10.0.0.1");
    const r = await reg.invoke(ctx(), "crm_search", { type: "account" });
    expect(r).toMatchObject({ ok: false, error: { code: "UPSTREAM" } });
    expect(JSON.stringify(r)).not.toContain("10.0.0.1");
    f.adapter.failNext = new KaidanError(ErrorCode.RATE_LIMITED, "飞书频控");
    expect(await reg.invoke(ctx(), "crm_get", { type: "account", id: "acc_hdjm" })).toMatchObject({
      ok: false,
      error: { code: "RATE_LIMITED", message: "飞书频控" },
    });
  });

  it("审计写入失败也不抛出，照常返回结果", async () => {
    const { reg, f } = setup();
    f.audit.fail = true;
    const r = await reg.invoke(ctx(), "crm_get", { type: "opportunity", id: "opp_1" });
    expect(r.ok).toBe(true);
  });

  it("结果带 ms（非负数）", async () => {
    const { reg } = setup();
    const r = await reg.invoke(ctx(), "crm_get", { type: "opportunity", id: "opp_1" });
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });
});

describe("审计", () => {
  it("每次调用恰好 1 条 tool_call（data 只含 tool / ok / ms / errorCode），无权限额外 1 条 permission_denied", async () => {
    const { reg, f } = setup();
    await reg.invoke(ctx(ZHANG, "t-a"), "pipeline_snapshot", { scope: "me" });
    await reg.invoke(ctx(ZHANG, "t-a"), "calendar_today", {});
    await reg.invoke(ctx(ZHANG, "t-b"), "crm_get", { type: "opportunity", id: "opp_3" });
    expect(f.audit.events.map((e) => [e.traceId, e.type])).toEqual([
      ["t-a", "tool_call"],
      ["t-a", "tool_call"],
      ["t-b", "tool_call"],
      ["t-b", "permission_denied"],
    ]);
    const [a, , c, d] = f.audit.events;
    expect(Object.keys(a!.data).sort()).toEqual(["ms", "ok", "tool"]);
    expect(a).toMatchObject({ tenantId: "demo", actorUserId: "ou_rep_zhang", data: { tool: "pipeline_snapshot", ok: true } });
    expect(c!.data).toMatchObject({ tool: "crm_get", ok: false, errorCode: "PERMISSION_DENIED" });
    expect(d!.data).toEqual({ tool: "crm_get" });
    // 审计里不出现 CRM 正文
    expect(JSON.stringify(f.audit.events)).not.toMatch(/华东|南海|二期/);
  });
});
