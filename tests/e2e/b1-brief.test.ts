// B1 晨报（spec 2.2）：张三 daily-brief；脚本第 1 步同时调用 pipeline_snapshot 与 calendar_today，第 2 步给出正文。
import { afterEach, describe, expect, it } from "vitest";
import { SECURITY_PREAMBLE } from "@kaidan/contracts";
import {
  ZHANG,
  actor,
  auditOf,
  countTypes,
  okOutput,
  request,
  setup,
  systemText,
  teardown,
  toolMessage,
  type CalendarOut,
  type PipelineOut,
} from "./harness.js";

afterEach(teardown);

describe("B1 晨报", () => {
  it("张三 /晨报：两次工具调用均成功，数值、系统提示、工具列表与审计符合预期", async () => {
    const h = await setup([
      {
        toolCalls: [
          { name: "pipeline_snapshot", arguments: { scope: "me", closingWithinDays: 30 } },
          { name: "calendar_today", arguments: {} },
        ],
      },
      { content: "晨报（测试）" },
    ]);
    const zhang = await actor(h, ZHANG);

    const result = await h.app.agent.run({
      actor: zhang,
      text: "/晨报",
      skill: "daily-brief",
      channel: "schedule",
      traceId: "t-b1",
    });

    expect(result.stoppedBy).toBe("final");
    expect(result.skill).toBe("daily-brief");
    expect(result.steps).toBe(2);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((c) => c.name).sort()).toEqual(["calendar_today", "pipeline_snapshot"]);
    expect(result.toolCalls.every((c) => c.ok)).toBe(true);

    // pipeline 工具消息
    const pipeline = toolMessage(h.provider, "pipeline_snapshot");
    const snap = okOutput<PipelineOut>(pipeline);
    expect(snap.closingSoon.map((o) => o.id)).toEqual(["opp_2", "opp_1"]);
    expect(snap.atRisk).toEqual([
      { opportunityId: "opp_1", name: "华东精密-二期产线", reasons: ["stale_activity", "missing_qualification"] },
    ]);
    expect(snap.openAmount).toBe(600000);
    expect(snap.byStage).toHaveLength(4);
    expect(snap.byStage.find((s) => s.stage === "solution")).toEqual({ stage: "solution", count: 1, amount: 480000 });
    expect(snap.byStage.find((s) => s.stage === "negotiation")).toEqual({
      stage: "negotiation",
      count: 1,
      amount: 120000,
    });
    expect(pipeline.content).not.toContain("opp_3");

    // calendar 工具消息
    const calendar = okOutput<CalendarOut>(toolMessage(h.provider, "calendar_today"));
    expect(calendar.events.map((e) => e.id)).toEqual(["ev_1"]);

    // 模型第 1 次请求：系统提示含安全段落全文；只暴露 daily-brief 的 4 个工具
    const first = request(h.provider, 0);
    expect(systemText(first)).toContain(SECURITY_PREAMBLE);
    expect((first.tools ?? []).map((t) => t.name).sort()).toEqual([
      "calendar_today",
      "crm_get",
      "crm_timeline",
      "pipeline_snapshot",
    ]);

    // 审计
    const counts = countTypes(await auditOf(h, { traceId: "t-b1" }));
    expect(counts.skill_invoked).toBe(1);
    expect(counts.llm_call).toBe(2);
    expect(counts.tool_call).toBe(2);
  });
});
