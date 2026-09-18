// B3 会后更新（spec 2.2）：张三 post-meeting 生成提案 → 批准两次（幂等）→ 待办提案被拒绝。
import { afterEach, describe, expect, it } from "vitest";
import {
  ZHANG,
  actor,
  auditOf,
  hasKeyDeep,
  mockAdapter,
  okOutput,
  opportunity,
  postMeetingScript,
  setup,
  teardown,
  toolCtx,
  toolMessage,
  toolMessages,
  type ProposeOut,
  type SearchOut,
} from "./harness.js";

afterEach(teardown);

describe("B3 会后更新", () => {
  it("张三 post-meeting：提案 → 批准前不写入 → 首次批准提交 → 再次批准幂等 → 待办提案拒绝", async () => {
    const h = await setup(postMeetingScript());
    const zhang = await actor(h, ZHANG);

    const result = await h.app.agent.run({
      actor: zhang,
      text: "今天和华东精密开会，对方确认方案，要求周三前出报价",
      skill: "post-meeting",
      channel: "cli",
      traceId: "t-b3",
    });

    // 工具消息：搜索只命中 opp_1；任何工具消息里都不出现键 raw
    const search = okOutput<SearchOut>(toolMessage(h.provider, "crm_search"));
    expect(search.items.map((i) => i.id)).toEqual(["opp_1"]);
    const messages = toolMessages(h.provider);
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) expect(hasKeyDeep(m.body, "raw"), `${m.name} 的工具消息里出现了键 raw`).toBe(false);

    // 本次运行产生 1 个 pending 提案
    expect(result.proposals).toHaveLength(1);
    const p = result.proposals[0]!;
    expect(p.status).toBe("pending");
    expect(p.kind).toBe("update");
    expect(p.targetId).toBe("opp_1");
    expect(p.diff).toEqual([
      { field: "stage", before: "solution", after: "negotiation" },
      { field: "nextStep", before: "", after: "9月24日前发送正式报价单" },
      { field: "expectedCloseDate", before: "2026-09-30", after: "2026-10-15" },
    ]);
    expect(Date.parse(p.expiresAt)).toBe(Date.parse("2026-09-22T09:00:00+08:00"));

    // 批准前：CRM 未变、零写入
    expect(opportunity(h, "opp_1").stage).toBe("solution");
    expect(mockAdapter(h).stats().writes).toBe(0);

    // 第一次批准 → committed
    const committed = await h.app.governance.approvals.approve(p.id, zhang);
    expect(committed.status).toBe("committed");
    expect(committed.decidedBy).toBe(ZHANG);
    const opp1 = opportunity(h, "opp_1");
    expect(opp1.stage).toBe("negotiation");
    expect(opp1.rawStage).toBe("商务谈判");
    expect(opp1.nextStep).toBe("9月24日前发送正式报价单");
    expect(opp1.expectedCloseDate).toBe("2026-10-15");
    expect(mockAdapter(h).stats().writes).toBe(1);

    // 第二次批准 → 仍 committed，不再写
    const again = await h.app.governance.approvals.approve(p.id, zhang);
    expect(again.status).toBe("committed");
    expect(mockAdapter(h).stats().writes).toBe(1);

    // 审计：proposal_created 与 proposal_committed（data.proposalId = pid）
    const events = await auditOf(h, { proposalId: p.id });
    const typesFor = events.filter((e) => e.data["proposalId"] === p.id).map((e) => e.type);
    expect(typesFor).toContain("proposal_created");
    expect(typesFor).toContain("proposal_committed");

    // 待办提案 → 拒绝：rejected，写入次数不变
    const task = await h.app.tools.invoke(toolCtx(h, zhang, "t-b3-task"), "propose_create", {
      objectType: "task",
      data: { title: "发送报价单", dueDate: "2026-09-24", opportunityId: "opp_1" },
      reason: "会后待办",
    });
    const taskPid = okOutput<ProposeOut>(task).proposalId;
    const rejected = await h.app.governance.approvals.reject(taskPid, zhang);
    expect(rejected.status).toBe("rejected");
    expect(mockAdapter(h).stats().writes).toBe(1);
  });
});
