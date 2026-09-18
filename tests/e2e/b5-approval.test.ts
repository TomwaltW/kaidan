// B5 审批规则（spec 2.2）：① 审批人权限 ② 过期 ③ 乐观并发冲突。
import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN,
  LI,
  WANG,
  ZHANG,
  actor,
  expectKaidanError,
  opportunity,
  proposeUpdate,
  setup,
  teardown,
} from "./harness.js";

afterEach(teardown);

describe("B5 审批规则", () => {
  it("① 张三的提案：李四审批 → PERMISSION_DENIED 且仍 pending；王经理（上级）审批 → committed", async () => {
    const h = await setup();
    const zhang = await actor(h, ZHANG);
    const li = await actor(h, LI);
    const wang = await actor(h, WANG);
    const pid = await proposeUpdate(h, zhang, "opp_2", { nextStep: "法务已回复，准备签约" });

    await expectKaidanError(h.app.governance.approvals.approve(pid, li), "PERMISSION_DENIED");
    expect((await h.app.governance.proposals.get(pid))?.status).toBe("pending");

    const p = await h.app.governance.approvals.approve(pid, wang);
    expect(p.status).toBe("committed");
  });

  it("② 时钟前进 25 小时后审批：第一次 EXPIRED 并置 expired，第二次 INVALID_STATE", async () => {
    const h = await setup();
    const zhang = await actor(h, ZHANG);
    const pid = await proposeUpdate(h, zhang, "opp_1", { probability: 60 });

    h.clock.advanceHours(25);

    await expectKaidanError(h.app.governance.approvals.approve(pid, zhang), "EXPIRED");
    expect((await h.app.governance.proposals.get(pid))?.status).toBe("expired");
    await expectKaidanError(h.app.governance.approvals.approve(pid, zhang), "INVALID_STATE");
  });

  it("③ 提交前记录已被他人修改 → CONFLICT，提案 failed 且 error 非空，不覆盖他人修改", async () => {
    const h = await setup();
    const zhang = await actor(h, ZHANG);
    const admin = await actor(h, ADMIN);
    const pid = await proposeUpdate(h, zhang, "opp_2", { nextStep: "X" });

    await h.app.adapter.update(
      admin,
      { type: "opportunity", id: "opp_2" },
      { nextStep: "被人改了" },
      { idempotencyKey: "manual-1", proposalId: "manual-1" },
    );

    await expectKaidanError(h.app.governance.approvals.approve(pid, zhang), "CONFLICT");
    const failed = await h.app.governance.proposals.get(pid);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBeTruthy();
    expect(opportunity(h, "opp_2").nextStep).toBe("被人改了");
  });
});
