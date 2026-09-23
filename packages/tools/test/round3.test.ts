// 第 3 轮 T1（docs/dev-spec-2026-09-23.md §2 R1 registry 半边、R2）：registry 按 ctx.allowedTools 拦截技能边界、
// 自己解析字符串参数，被拒的调用照常写 tool_call；crm_timeline 的跟进记录与待办两个列表都分页。
// 待办 / 跟进记录的额外数据都在本文件里就地加（loadMini() 之后 push），不改 tests/e2e/fixtures（冻结）。
import { describe, expect, it } from "vitest";
import type { Task, ToolContext, ToolInvokeResult } from "@kaidan/contracts";
import { createToolRegistry } from "../src/index.js";
import { ADMIN, NOW, ZHANG, fixture, loadMini, type Fixture } from "./fakes.js";

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ actor: ZHANG, traceId: "t-r3", now: NOW, ...extra });

function setup(f: Fixture = fixture()) {
  return { f, reg: createToolRegistry(f.deps) };
}

function out<T>(r: ToolInvokeResult): T {
  if (!r.ok) throw new Error(`工具失败：${JSON.stringify(r.error)}`);
  return r.output as T;
}

/** 审计里的 tool_call，只取 [tool, ok, errorCode] */
function calls(f: Fixture): unknown[][] {
  return f.audit.events.filter((e) => e.type === "tool_call").map((e) => [e.data["tool"], e.data["ok"], e.data["errorCode"]]);
}

const OUT_OF_SKILL = {
  ref: { type: "opportunity", id: "opp_1" },
  patch: { nextStep: "越界写入" },
  reason: "越界测试",
};
const DAILY_BRIEF = ["pipeline_snapshot", "calendar_today", "crm_get", "crm_timeline"] as const;

interface Timeline {
  activities: { id: string }[];
  tasks: { id: string }[];
  nextCursor?: string;
  tasksNextCursor?: string;
}

function task(id: string, dueDate: string, opportunityId = "opp_2"): Task {
  return {
    type: "task",
    id,
    title: `待办 ${id}`,
    dueDate,
    status: "open",
    opportunityId,
    ownerId: "ou_rep_zhang",
    createdAt: "2026-09-19T16:00:00+08:00",
    updatedAt: "2026-09-19T16:00:00+08:00",
  };
}

describe("第 3 轮 R1 · registry 按 ctx.allowedTools 拦截越出技能的调用", () => {
  it("R1-1 allowedTools 不含 propose_update → VALIDATION「当前技能不允许调用工具 propose_update」，写一条 tool_call，不出提案、不碰适配器", async () => {
    const { reg, f } = setup();
    const r = await reg.invoke(ctx({ allowedTools: DAILY_BRIEF }), "propose_update", OUT_OF_SKILL);
    expect(r).toMatchObject({ ok: false, error: { code: "VALIDATION", message: "当前技能不允许调用工具 propose_update" } });
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(f.audit.events).toHaveLength(1);
    expect(f.audit.events[0]).toMatchObject({ type: "tool_call", traceId: "t-r3", actorUserId: "ou_rep_zhang" });
    const { ms, ...rest } = f.audit.events[0]!.data;
    expect(rest).toEqual({ tool: "propose_update", ok: false, errorCode: "VALIDATION" });
    expect(typeof ms).toBe("number");
    expect(f.proposals.created).toHaveLength(0);
    expect(f.adapter.searchCalls).toHaveLength(0);
    expect(f.adapter.writeCalls).toBe(0);
  });

  it("R1-2 带 allowedTools 时未知工具名也得到同一句文案（先判技能边界、后判未知工具）；不带 allowedTools 时仍是「未知工具」", async () => {
    const { reg, f } = setup();
    expect(await reg.invoke(ctx({ allowedTools: DAILY_BRIEF }), "crm_delete", {})).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", message: "当前技能不允许调用工具 crm_delete" },
    });
    expect(await reg.invoke(ctx(), "crm_delete", {})).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", message: "未知工具：crm_delete" },
    });
    expect(calls(f)).toEqual([
      ["crm_delete", false, "VALIDATION"],
      ["crm_delete", false, "VALIDATION"],
    ]);
  });

  it("R1-3 allowedTools 含该工具 → 照常执行；ctx 不带 allowedTools（MCP 口径）→ 不限技能边界，propose_update 照常出提案", async () => {
    const { reg, f } = setup();
    const got = out<{ item: { id: string } }>(
      await reg.invoke(ctx({ allowedTools: DAILY_BRIEF }), "crm_get", { type: "opportunity", id: "opp_1" }),
    );
    expect(got.item.id).toBe("opp_1");
    const mcp = out<{ status: string }>(await reg.invoke(ctx(), "propose_update", OUT_OF_SKILL));
    expect(mcp.status).toBe("pending");
    expect(f.proposals.created).toHaveLength(1);
    expect(calls(f)).toEqual([
      ["crm_get", true, undefined],
      ["propose_update", true, undefined],
    ]);
  });
});

describe("第 3 轮 R1 · registry 自己解析字符串参数", () => {
  it("R1-4 合法 JSON 照常执行、空串视为 {}、非法 JSON → VALIDATION「工具 crm_get 的参数不是合法 JSON」，三次都写 tool_call", async () => {
    const { reg, f } = setup();
    const got = out<{ item: { id: string } }>(await reg.invoke(ctx(), "crm_get", '{"type":"opportunity","id":"opp_2"}'));
    expect(got.item.id).toBe("opp_2");
    const schema = out<{ schema: { source: string } }>(await reg.invoke(ctx({ actor: ADMIN }), "schema_inspect", ""));
    expect(schema.schema.source).toBe("mock");
    expect(await reg.invoke(ctx(), "crm_get", "{不是 JSON")).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", message: "工具 crm_get 的参数不是合法 JSON" },
    });
    expect(calls(f)).toEqual([
      ["crm_get", true, undefined],
      ["schema_inspect", true, undefined],
      ["crm_get", false, "VALIDATION"],
    ]);
  });

  it("R1-5 纯空白串也视为 {}；解析出来不是对象 → 照常走 zod（参数不合法）；越出技能先于解析（非法 JSON 也给越权文案）", async () => {
    const { reg, f } = setup();
    expect(out<{ events: unknown[] }>(await reg.invoke(ctx(), "calendar_today", "  \n")).events).toEqual(expect.any(Array));
    const num = await reg.invoke(ctx(), "crm_get", "42");
    expect(num.ok).toBe(false);
    if (!num.ok) {
      expect(num.error.code).toBe("VALIDATION");
      expect(num.error.message).toMatch(/^工具 crm_get 的参数不合法：/);
    }
    expect(await reg.invoke(ctx({ allowedTools: DAILY_BRIEF }), "propose_update", "{不是 JSON")).toMatchObject({
      ok: false,
      error: { code: "VALIDATION", message: "当前技能不允许调用工具 propose_update" },
    });
    expect(calls(f)).toEqual([
      ["calendar_today", true, undefined],
      ["crm_get", false, "VALIDATION"],
      ["propose_update", false, "VALIDATION"],
    ]);
  });
});

describe("第 3 轮 R2 · crm_timeline 的跟进记录和待办两个列表都分页", () => {
  it("R2-1 待办分页：opp_2 共 3 条待办，tasksLimit 2 → 前 2 条 + tasksNextCursor \"2\"；带 tasksCursor 取下一页 → 最后 1 条、没有 tasksNextCursor", async () => {
    const ds = loadMini();
    ds.tasks.push(task("task_8", "2026-09-24"), task("task_9", "2026-09-25"));
    const { reg } = setup(fixture({ dataset: ds }));
    const p1 = out<Timeline>(await reg.invoke(ctx(), "crm_timeline", { opportunityId: "opp_2", tasksLimit: 2 }));
    expect(p1.tasks.map((t) => t.id)).toEqual(["task_1", "task_8"]);
    expect(p1.tasksNextCursor).toBe("2");
    expect("nextCursor" in p1).toBe(false);
    const p2 = out<Timeline>(
      await reg.invoke(ctx(), "crm_timeline", { opportunityId: "opp_2", tasksLimit: 2, tasksCursor: p1.tasksNextCursor }),
    );
    expect(p2.tasks.map((t) => t.id)).toEqual(["task_9"]);
    expect("tasksNextCursor" in p2).toBe(false);
    // 翻待办不影响跟进记录：两页的跟进记录相同
    expect(p2.activities.map((a) => a.id)).toEqual(p1.activities.map((a) => a.id));
  });

  it("R2-2 跟进记录分页：limit 1 → 最新 1 条 + nextCursor \"1\"；带 cursor 取下一页 → 较早 1 条、没有 nextCursor；待办不受影响", async () => {
    const ds = loadMini();
    ds.activities.push({ ...ds.activities[2]!, id: "act_9", occurredAt: "2026-09-20T10:00:00+08:00" });
    const { reg } = setup(fixture({ dataset: ds }));
    const p1 = out<Timeline>(await reg.invoke(ctx(), "crm_timeline", { opportunityId: "opp_2", limit: 1 }));
    expect(p1.activities.map((a) => a.id)).toEqual(["act_9"]);
    expect(p1.nextCursor).toBe("1");
    expect("tasksNextCursor" in p1).toBe(false);
    const p2 = out<Timeline>(
      await reg.invoke(ctx(), "crm_timeline", { opportunityId: "opp_2", limit: 1, cursor: p1.nextCursor }),
    );
    expect(p2.activities.map((a) => a.id)).toEqual(["act_3"]);
    expect("nextCursor" in p2).toBe(false);
    expect(p2.tasks.map((t) => t.id)).toEqual(["task_1"]);
  });

  it("R2-3 不带新参数：只有一页时输出只有 activities / tasks 两个键；待办缺省每页 50（第 51 条不再静默丢掉，给 tasksNextCursor \"50\"）", async () => {
    const plain = out<Timeline>(await setup().reg.invoke(ctx(), "crm_timeline", { opportunityId: "opp_2" }));
    expect(Object.keys(plain).sort()).toEqual(["activities", "tasks"]);
    expect(plain.activities.map((a) => a.id)).toEqual(["act_3"]);
    expect(plain.tasks.map((t) => t.id)).toEqual(["task_1"]);

    const ds = loadMini();
    for (let i = 10; i < 60; i++) ds.tasks.push(task(`task_${i}`, "2026-10-01")); // 加上 task_1 共 51 条
    const { reg, f } = setup(fixture({ dataset: ds }));
    const p1 = out<Timeline>(await reg.invoke(ctx(), "crm_timeline", { opportunityId: "opp_2" }));
    expect(p1.tasks).toHaveLength(50);
    expect(p1.tasksNextCursor).toBe("50");
    expect(f.adapter.searchCalls.at(-1)).toMatchObject({ type: "task", limit: 50 });
    const p2 = out<Timeline>(await reg.invoke(ctx(), "crm_timeline", { opportunityId: "opp_2", tasksCursor: "50" }));
    expect(p2.tasks).toHaveLength(1);
    expect("tasksNextCursor" in p2).toBe(false);
  });
});
