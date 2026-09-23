// B7 第 3 轮验收（docs/dev-spec-2026-09-23.md §2 R1–R3、§4）：契约由 T0 定好，实现分在 T1（tools）/ T2（agent）。
// T0 交付时本文件必须是红的：7 条用例都能被收集、都因断言失败（AssertionError）而红；T1 + T2 合流后由 TΩ 跑绿。
// 本文件只用 harness.ts 已有的导出，不改 harness。重新下锁后本文件冻结（tests/e2e/**），改它要再开一次锁。
import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext, ToolInvokeResult } from "@kaidan/contracts";
import {
  ADMIN,
  TENANT,
  ZHANG,
  actor,
  auditOf,
  mockAdapter,
  okOutput,
  request,
  setup,
  teardown,
  toolCtx,
  toolMessage,
  type GetOut,
  type SchemaOut,
  type ToolMessage,
} from "./harness.js";

afterEach(teardown);

interface TimelineOut {
  activities: { id: string; subject: string }[];
  tasks: { id: string; title: string }[];
  nextCursor?: string;
  tasksNextCursor?: string;
}

/** 断言工具失败并取出 error（成功时直接判红，带上输出便于排查） */
function failure(r: ToolInvokeResult | ToolMessage): { code: string; message: string } {
  const body = "body" in r ? r.body : r;
  if (body.ok) return expect.fail(`工具应失败，实际成功：${JSON.stringify(body.output)}`);
  return body.error;
}

const OUT_OF_SKILL_UPDATE = {
  ref: { type: "opportunity", id: "opp_1" },
  patch: { nextStep: "越界写入（b7）" },
  reason: "b7 越界测试",
};

describe("B7 第 3 轮 · R1 越出技能的工具调用在 ToolRegistry 里拦，被拒的调用也写 tool_call 审计", () => {
  it("R1a 张三 /晨报（daily-brief 不含 propose_update）脚本硬塞一次 propose_update → VALIDATION、恰有一条 tool_call 审计、不写入不出提案", async () => {
    const h = await setup([
      { toolCalls: [{ name: "propose_update", arguments: OUT_OF_SKILL_UPDATE }] },
      { content: "晨报（测试）" },
    ]);
    const zhang = await actor(h, ZHANG);
    const result = await h.app.agent.run({
      actor: zhang,
      text: "/晨报",
      skill: "daily-brief",
      channel: "cli",
      traceId: "t-b7-r1a",
    });

    // 模型看到的文案与第 2 轮逐字一致
    expect(failure(toolMessage(h.provider, "propose_update"))).toEqual({
      code: "VALIDATION",
      message: "当前技能不允许调用工具 propose_update",
    });
    // 被拒的调用进了 registry：恰有一条 tool_call 审计
    const calls = await auditOf(h, { traceId: "t-b7-r1a", type: "tool_call" });
    expect(calls).toHaveLength(1);
    const { ms, ...rest } = calls[0]!.data;
    expect(rest).toEqual({ tool: "propose_update", ok: false, errorCode: "VALIDATION" });
    expect(typeof ms).toBe("number");
    // 不写入、不出提案
    expect(result.toolCalls.map((c) => [c.name, c.ok, c.errorCode])).toEqual([["propose_update", false, "VALIDATION"]]);
    expect(result.proposals).toHaveLength(0);
    expect(mockAdapter(h).stats().writes).toBe(0);
    expect(await h.app.governance.proposals.listPending(TENANT, ZHANG)).toEqual([]);
  });

  it("R1b registry 按 ctx.allowedTools 拦截：越界与未知工具名给同一句文案并写 tool_call；ctx 不带 allowedTools（MCP）不受影响", async () => {
    const h = await setup();
    const zhang = await actor(h, ZHANG);
    const gated: ToolContext = { ...toolCtx(h, zhang, "t-b7-r1b"), allowedTools: ["crm_get", "crm_timeline"] };

    expect(failure(await h.app.tools.invoke(gated, "propose_update", OUT_OF_SKILL_UPDATE))).toEqual({
      code: "VALIDATION",
      message: "当前技能不允许调用工具 propose_update",
    });
    expect(failure(await h.app.tools.invoke(gated, "crm_delete", {}))).toEqual({
      code: "VALIDATION",
      message: "当前技能不允许调用工具 crm_delete",
    });
    const got = okOutput<GetOut>(await h.app.tools.invoke(gated, "crm_get", { type: "opportunity", id: "opp_1" }));
    expect(got.item?.id).toBe("opp_1");

    const audits = await auditOf(h, { traceId: "t-b7-r1b", type: "tool_call" });
    expect(audits.map((e) => [e.data["tool"], e.data["ok"], e.data["errorCode"]])).toEqual([
      ["propose_update", false, "VALIDATION"],
      ["crm_delete", false, "VALIDATION"],
      ["crm_get", true, undefined],
    ]);
    expect(mockAdapter(h).stats().writes).toBe(0);
    expect(await h.app.governance.proposals.listPending(TENANT, ZHANG)).toEqual([]);

    // MCP 口径：ctx 不带 allowedTools = 不限技能边界，propose_update 照常生成提案
    const mcp = await h.app.tools.invoke(toolCtx(h, zhang, "t-b7-r1b-mcp"), "propose_update", OUT_OF_SKILL_UPDATE);
    expect(mcp.ok).toBe(true);
  });

  it("R1c registry 自己解析字符串参数：合法 JSON 照常执行、空串视为 {}、非法 JSON → VALIDATION，三次都写 tool_call", async () => {
    const h = await setup();
    const zhang = await actor(h, ZHANG);
    const admin = await actor(h, ADMIN);

    const got = okOutput<GetOut>(
      await h.app.tools.invoke(toolCtx(h, zhang, "t-b7-r1c"), "crm_get", '{"type":"opportunity","id":"opp_2"}'),
    );
    expect(got.item?.id).toBe("opp_2");
    const schema = okOutput<SchemaOut>(await h.app.tools.invoke(toolCtx(h, admin, "t-b7-r1c"), "schema_inspect", ""));
    expect(schema.schema.source).toBe("mock");
    expect(failure(await h.app.tools.invoke(toolCtx(h, zhang, "t-b7-r1c"), "crm_get", "{不是 JSON"))).toEqual({
      code: "VALIDATION",
      message: "工具 crm_get 的参数不是合法 JSON",
    });

    const audits = await auditOf(h, { traceId: "t-b7-r1c", type: "tool_call" });
    expect(audits.map((e) => [e.data["tool"], e.data["ok"], e.data["errorCode"]])).toEqual([
      ["crm_get", true, undefined],
      ["schema_inspect", true, undefined],
      ["crm_get", false, "VALIDATION"],
    ]);
  });
});

describe("B7 第 3 轮 · R2 crm_timeline 的跟进记录和待办两个列表都分页", () => {
  it("R2a 待办分页：opp_2 共 3 条待办，tasksLimit 2 → 前 2 条 + tasksNextCursor；带 tasksCursor 取下一页 → 最后 1 条、没有 tasksNextCursor", async () => {
    const h = await setup();
    const zhang = await actor(h, ZHANG);
    for (const [i, dueDate] of ["2026-09-24", "2026-09-25"].entries()) {
      await h.app.adapter.create(
        zhang,
        "task",
        { title: `b7 待办 ${i + 1}`, dueDate, status: "open", opportunityId: "opp_2" },
        { idempotencyKey: `b7-task-${i + 1}`, proposalId: `b7-task-${i + 1}` },
      );
    }
    const ctx = toolCtx(h, zhang, "t-b7-r2a");

    const page1 = okOutput<TimelineOut>(
      await h.app.tools.invoke(ctx, "crm_timeline", { opportunityId: "opp_2", tasksLimit: 2 }),
    );
    expect(page1.tasks.map((t) => t.title)).toEqual(["跟进法务审核意见", "b7 待办 1"]);
    expect(page1.tasksNextCursor).toEqual(expect.any(String));

    const page2 = okOutput<TimelineOut>(
      await h.app.tools.invoke(ctx, "crm_timeline", {
        opportunityId: "opp_2",
        tasksLimit: 2,
        tasksCursor: page1.tasksNextCursor,
      }),
    );
    expect(page2.tasks.map((t) => t.title)).toEqual(["b7 待办 2"]);
    expect("tasksNextCursor" in page2).toBe(false);
  });

  it("R2b 跟进记录分页：opp_2 共 2 条跟进，limit 1 → 最新 1 条 + nextCursor；带 cursor 取下一页 → 较早 1 条、没有 nextCursor；不带新参数时输出只有 activities / tasks 两个键", async () => {
    const h = await setup();
    const zhang = await actor(h, ZHANG);
    await h.app.adapter.create(
      zhang,
      "activity",
      { kind: "call", subject: "b7 跟进", occurredAt: "2026-09-20T10:00:00+08:00", opportunityId: "opp_2" },
      { idempotencyKey: "b7-act-1", proposalId: "b7-act-1" },
    );
    const ctx = toolCtx(h, zhang, "t-b7-r2b");

    const page1 = okOutput<TimelineOut>(
      await h.app.tools.invoke(ctx, "crm_timeline", { opportunityId: "opp_2", limit: 1 }),
    );
    expect(page1.activities.map((a) => a.subject)).toEqual(["b7 跟进"]);
    expect(page1.nextCursor).toEqual(expect.any(String));

    const page2 = okOutput<TimelineOut>(
      await h.app.tools.invoke(ctx, "crm_timeline", { opportunityId: "opp_2", limit: 1, cursor: page1.nextCursor }),
    );
    expect(page2.activities.map((a) => a.subject)).toEqual(["合同条款确认"]);
    expect("nextCursor" in page2).toBe(false);

    const plain = okOutput<TimelineOut>(await h.app.tools.invoke(ctx, "crm_timeline", { opportunityId: "opp_2" }));
    expect(Object.keys(plain).sort()).toEqual(["activities", "tasks"]);
    expect(plain.activities.map((a) => a.subject)).toEqual(["b7 跟进", "合同条款确认"]);
    expect(plain.tasks.map((t) => t.title)).toEqual(["跟进法务审核意见"]);
  });
});

describe("B7 第 3 轮 · R3 补救追问：说了「已生成提案」却没调写入工具 → 带 toolChoice 追问一次", () => {
  it('R3a 张三 /会后：第一次只回「已生成提案」→ 追问一次（toolChoice = "required"）→ 得到 1 个提案', async () => {
    const h = await setup([
      { content: "已生成提案" },
      {
        toolCalls: [
          {
            name: "propose_update",
            arguments: {
              ref: { type: "opportunity", id: "opp_1" },
              patch: { nextStep: "9月24日前发送正式报价单" },
              reason: "会后：客户要求周三前出报价",
            },
          },
        ],
      },
      { content: "好了" },
    ]);
    const zhang = await actor(h, ZHANG);
    const result = await h.app.agent.run({
      actor: zhang,
      text: "今天和华东精密开会，对方要求周三前出报价",
      skill: "post-meeting",
      channel: "cli",
      traceId: "t-b7-r3a",
    });

    expect(h.provider.requests).toHaveLength(3);
    expect(request(h.provider, 0).toolChoice).toBeUndefined();
    expect(request(h.provider, 1).toolChoice).toBe("required");
    expect(request(h.provider, 1).messages.at(-1)?.role).toBe("user");
    expect(request(h.provider, 2).toolChoice).toBeUndefined();
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.targetId).toBe("opp_1");
    expect(result.stoppedBy).toBe("final");
    expect(result.steps).toBe(3);
    expect(result.reply).toBe("好了");
  });

  it("R3b 追问后仍没有提案 → 如实回复「这次没有生成提案」；没有触发词、或技能不含写入工具时不追问", async () => {
    const h = await setup([{ content: "已记录会议要点" }, { content: "好的" }]);
    const zhang = await actor(h, ZHANG);
    const result = await h.app.agent.run({
      actor: zhang,
      text: "今天和华东精密开会，对方要求周三前出报价",
      skill: "post-meeting",
      channel: "cli",
      traceId: "t-b7-r3b",
    });
    expect(h.provider.requests).toHaveLength(2);
    expect(request(h.provider, 1).toolChoice).toBe("required");
    expect(result.proposals).toHaveLength(0);
    expect(result.stoppedBy).toBe("final");
    expect(result.reply).toContain("这次没有生成提案");

    // 没有触发词 → 不追问
    const h2 = await setup([{ content: "今天没有要改的" }]);
    const r2 = await h2.app.agent.run({
      actor: await actor(h2, ZHANG),
      text: "今天和华东精密开会，只是寒暄",
      skill: "post-meeting",
      channel: "cli",
      traceId: "t-b7-r3b-2",
    });
    expect(h2.provider.requests).toHaveLength(1);
    expect(request(h2.provider, 0).toolChoice).toBeUndefined();
    expect(r2.reply).toBe("今天没有要改的");

    // daily-brief 不含 propose_* → 即使回复里有触发词也不追问
    const h3 = await setup([{ content: "已生成晨报" }]);
    const r3 = await h3.app.agent.run({
      actor: await actor(h3, ZHANG),
      text: "/晨报",
      skill: "daily-brief",
      channel: "cli",
      traceId: "t-b7-r3b-3",
    });
    expect(h3.provider.requests).toHaveLength(1);
    expect(r3.reply).toBe("已生成晨报");
  });
});
