// spec 第 6 节 T2 行①：提案生命周期、审批人权限矩阵（本人 / 他人 rep / manager 含与不含 / admin）、幂等、
// 过期（首次 EXPIRED 再次 INVALID_STATE）、乐观并发 CONFLICT、适配器报错 → failed、审计写入与按 traceId / proposalId / type 查询。
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ErrorCode,
  IsoDateTime,
  KaidanError,
  Proposal as ProposalSchema,
  isKaidanError,
  type Governance,
  type NewProposal,
} from "@kaidan/contracts";
import { createGovernance } from "../src/index.js";
import { ADMIN, FakeAdapter, LI, OTHER_MGR, TENANT, WANG, ZHANG, opp } from "./fake-adapter.js";

const START = "2026-09-21T09:00:00+08:00";

class Clock {
  t = Date.parse(START);
  now = (): Date => new Date(this.t);
  advanceMinutes(m: number): void {
    this.t += m * 60_000;
  }
}

const opened: Governance[] = [];
afterEach(async () => {
  for (const g of opened.splice(0)) await g.close();
});

function setup(ttl = 1440) {
  const adapter = new FakeAdapter([
    opp("opp_1", ZHANG.userId, { nextStep: "", expectedCloseDate: "2026-09-30" }),
    opp("opp_2", ZHANG.userId, { nextStep: "等待法务审核合同", qualification: { pain: "效率", budget: "有" } }),
    opp("opp_3", LI.userId),
  ]);
  const clock = new Clock();
  const gov = createGovernance({ adapter, dbPath: ":memory:", proposalTtlMinutes: ttl, clock: clock.now });
  opened.push(gov);
  return { adapter, clock, gov };
}

function updateProposal(over: Partial<NewProposal> = {}): NewProposal {
  return {
    tenantId: TENANT,
    actorUserId: ZHANG.userId,
    kind: "update",
    objectType: "opportunity",
    targetId: "opp_1",
    patch: { stage: "negotiation", nextStep: "9月24日前发送正式报价单" },
    diff: [
      { field: "stage", before: "solution", after: "negotiation" },
      { field: "nextStep", before: "", after: "9月24日前发送正式报价单" },
    ],
    reason: "会后更新",
    traceId: "t-1",
    skill: "post-meeting",
    ...over,
  };
}

async function expectCode(p: Promise<unknown>, code: string): Promise<KaidanError> {
  const e = await p.then(
    () => expect.fail(`期望抛出 ${code}`),
    (err: unknown) => err,
  );
  expect(isKaidanError(e), String(e)).toBe(true);
  expect((e as KaidanError).code).toBe(code);
  return e as KaidanError;
}

describe("ProposalService", () => {
  it("create：pending、prop_ 前缀、expiresAt = 现在 + TTL、符合 Proposal schema，并写 proposal_created", async () => {
    const { gov } = setup();
    const p = await gov.proposals.create(updateProposal());
    expect(p.id).toMatch(/^prop_[0-9a-f-]{36}$/);
    expect(p.status).toBe("pending");
    expect(ProposalSchema.safeParse(p).success).toBe(true);
    expect(IsoDateTime.safeParse(p.createdAt).success).toBe(true);
    expect(Date.parse(p.createdAt)).toBe(Date.parse(START));
    expect(Date.parse(p.expiresAt)).toBe(Date.parse("2026-09-22T09:00:00+08:00"));
    expect(p.skill).toBe("post-meeting");

    const events = await gov.audit.query({ tenantId: TENANT, type: "proposal_created" });
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ proposalId: p.id, objectType: "opportunity", kind: "update" });
    expect(events[0]!.actorUserId).toBe(ZHANG.userId);
    expect(events[0]!.traceId).toBe("t-1");
  });

  it("create：ttlMinutes 覆盖缺省值；kind=update 缺 targetId → VALIDATION", async () => {
    const { gov } = setup();
    const p = await gov.proposals.create(updateProposal({ ttlMinutes: 30 }));
    expect(Date.parse(p.expiresAt) - Date.parse(p.createdAt)).toBe(30 * 60_000);
    await expectCode(gov.proposals.create(updateProposal({ targetId: undefined })), ErrorCode.VALIDATION);
  });

  it("get：取回与 create 返回相同的提案；不存在 → null", async () => {
    const { gov } = setup();
    const p = await gov.proposals.create(updateProposal());
    expect(await gov.proposals.get(p.id)).toEqual(p);
    expect(await gov.proposals.get("prop_nope")).toBeNull();
  });

  it("listPending：只列该租户该提案人 status=pending 的提案，按创建顺序；过期提案在首次审批访问后才离开列表", async () => {
    const { gov, clock } = setup();
    const a = await gov.proposals.create(updateProposal());
    const b = await gov.proposals.create(updateProposal({ targetId: "opp_2", diff: [], patch: { nextStep: "X" } }));
    await gov.proposals.create(updateProposal({ actorUserId: LI.userId, targetId: "opp_3" }));
    const shortLived = await gov.proposals.create(updateProposal({ ttlMinutes: 10 }));
    await gov.approvals.reject(b.id, ZHANG);

    expect((await gov.proposals.listPending(TENANT, ZHANG.userId)).map((p) => p.id)).toEqual([a.id, shortLived.id]);
    clock.advanceMinutes(11);
    expect((await gov.proposals.listPending(TENANT, ZHANG.userId)).map((p) => p.id)).toEqual([a.id, shortLived.id]);
    await expectCode(gov.approvals.approve(shortLived.id, ZHANG), ErrorCode.EXPIRED);
    expect((await gov.proposals.listPending(TENANT, ZHANG.userId)).map((p) => p.id)).toEqual([a.id]);
    expect(await gov.proposals.listPending("other-tenant", ZHANG.userId)).toEqual([]);
  });

  it("dbPath 为文件路径时自动创建父目录，close() 可重复调用", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kaidan-gov-"));
    try {
      const dbPath = join(dir, "a", "b", "gov.db");
      const gov = createGovernance({ adapter: new FakeAdapter([]), dbPath, proposalTtlMinutes: 60 });
      const p = await gov.proposals.create(updateProposal());
      await gov.close();
      await gov.close();
      expect(existsSync(dbPath)).toBe(true);

      const again = createGovernance({ adapter: new FakeAdapter([]), dbPath, proposalTtlMinutes: 60 });
      expect((await again.proposals.get(p.id))?.status).toBe("pending");
      await again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ApprovalService.approve", () => {
  it("生命周期：本人批准 → committed、decidedBy/decidedAt、以 approver 身份写入、idempotencyKey=proposalId", async () => {
    const { gov, adapter } = setup();
    const p = await gov.proposals.create(updateProposal());
    expect(adapter.writes).toBe(0);

    const done = await gov.approvals.approve(p.id, ZHANG);
    expect(done.status).toBe("committed");
    expect(done.decidedBy).toBe(ZHANG.userId);
    expect(Date.parse(done.decidedAt!)).toBe(Date.parse(START));
    expect(adapter.writes).toBe(1);
    expect([...adapter.applied]).toEqual([p.id]);
    expect(adapter.records.get("opp_1")).toMatchObject({ stage: "negotiation", nextStep: "9月24日前发送正式报价单" });
    expect(await gov.proposals.get(p.id)).toEqual(done);
  });

  it("幂等：已 committed 再批准 → 原样返回，不再写", async () => {
    const { gov, adapter } = setup();
    const p = await gov.proposals.create(updateProposal());
    const first = await gov.approvals.approve(p.id, ZHANG);
    const second = await gov.approvals.approve(p.id, ZHANG);
    expect(second).toEqual(first);
    expect(adapter.writes).toBe(1);
    expect(await gov.audit.query({ tenantId: TENANT, type: "proposal_committed" })).toHaveLength(1);
  });

  it("并发双击：两次同时批准只写一次", async () => {
    const { gov, adapter } = setup();
    const p = await gov.proposals.create(updateProposal());
    const [a, b] = await Promise.all([gov.approvals.approve(p.id, ZHANG), gov.approvals.approve(p.id, ZHANG)]);
    expect(a.status).toBe("committed");
    expect(b.status).toBe("committed");
    expect(adapter.writes).toBe(1);
  });

  it("权限矩阵：他人 rep / 非本组 manager → PERMISSION_DENIED 且仍 pending；本组 manager 与 admin 可批准", async () => {
    const { gov, adapter } = setup();
    const p1 = await gov.proposals.create(updateProposal());
    await expectCode(gov.approvals.approve(p1.id, LI), ErrorCode.PERMISSION_DENIED);
    await expectCode(gov.approvals.approve(p1.id, OTHER_MGR), ErrorCode.PERMISSION_DENIED);
    await expectCode(gov.approvals.reject(p1.id, LI), ErrorCode.PERMISSION_DENIED);
    expect((await gov.proposals.get(p1.id))?.status).toBe("pending");
    expect(adapter.writes).toBe(0);

    const byManager = await gov.approvals.approve(p1.id, WANG);
    expect(byManager).toMatchObject({ status: "committed", decidedBy: WANG.userId });

    const p2 = await gov.proposals.create(
      updateProposal({ targetId: "opp_2", patch: { nextStep: "法务已回复" }, diff: [{ field: "nextStep", before: "等待法务审核合同", after: "法务已回复" }] }),
    );
    expect(await gov.approvals.approve(p2.id, ADMIN)).toMatchObject({ status: "committed", decidedBy: ADMIN.userId });
  });

  it("权限矩阵：manager 的 teamIds 不含提案人 / 其他租户的 admin → PERMISSION_DENIED", async () => {
    const { gov } = setup();
    const p = await gov.proposals.create(updateProposal());
    await expectCode(gov.approvals.approve(p.id, { ...WANG, teamIds: [] }), ErrorCode.PERMISSION_DENIED);
    await expectCode(gov.approvals.approve(p.id, { ...ADMIN, tenantId: "other" }), ErrorCode.PERMISSION_DENIED);
    expect((await gov.proposals.get(p.id))?.status).toBe("pending");
  });

  it("过期：首次访问抛 EXPIRED 并置 expired，之后抛 INVALID_STATE，均不写", async () => {
    const { gov, adapter, clock } = setup();
    const p = await gov.proposals.create(updateProposal());
    clock.advanceMinutes(25 * 60);
    await expectCode(gov.approvals.approve(p.id, ZHANG), ErrorCode.EXPIRED);
    expect((await gov.proposals.get(p.id))?.status).toBe("expired");
    await expectCode(gov.approvals.approve(p.id, ZHANG), ErrorCode.INVALID_STATE);
    await expectCode(gov.approvals.reject(p.id, ZHANG), ErrorCode.INVALID_STATE);
    expect(adapter.writes).toBe(0);
    const expired = await gov.audit.query({ tenantId: TENANT, proposalId: p.id, type: "proposal_expired" });
    expect(expired).toHaveLength(1);
  });

  it("过期：无权者访问过期提案仍抛 PERMISSION_DENIED，不改状态", async () => {
    const { gov, clock } = setup();
    const p = await gov.proposals.create(updateProposal());
    clock.advanceMinutes(25 * 60);
    await expectCode(gov.approvals.approve(p.id, LI), ErrorCode.PERMISSION_DENIED);
    expect((await gov.proposals.get(p.id))?.status).toBe("pending");
  });

  it("乐观并发：before 与当前值不同 → CONFLICT，提案 failed 且 error 非空，不覆盖他人修改", async () => {
    const { gov, adapter } = setup();
    const p = await gov.proposals.create(updateProposal());
    await adapter.update(ADMIN, { type: "opportunity", id: "opp_1" }, { nextStep: "被人改了" }, { idempotencyKey: "manual-1", proposalId: "manual-1" });

    const e = await expectCode(gov.approvals.approve(p.id, ZHANG), ErrorCode.CONFLICT);
    expect(e.message).toContain("nextStep");
    const failed = await gov.proposals.get(p.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBeTruthy();
    expect(adapter.records.get("opp_1")).toMatchObject({ nextStep: "被人改了", stage: "solution" });
    expect(adapter.writes).toBe(1);
    await expectCode(gov.approvals.approve(p.id, ZHANG), ErrorCode.INVALID_STATE);
    expect(await gov.audit.query({ tenantId: TENANT, proposalId: p.id, type: "proposal_failed" })).toHaveLength(1);
  });

  it("乐观并发：before 为 null 与字段不存在视为相等；对象字段按值比较（键顺序无关）", async () => {
    const { gov } = setup();
    const p = await gov.proposals.create(
      updateProposal({
        targetId: "opp_2",
        patch: { probability: 60, qualification: { pain: "效率", budget: "有", timeline: "Q4" } },
        diff: [
          { field: "probability", before: null, after: 60 },
          { field: "qualification", before: { budget: "有", pain: "效率" }, after: { pain: "效率", budget: "有", timeline: "Q4" } },
        ],
      }),
    );
    expect((await gov.approvals.approve(p.id, ZHANG)).status).toBe("committed");
  });

  it("目标记录已不存在 → CONFLICT 并置 failed", async () => {
    const { gov, adapter } = setup();
    const p = await gov.proposals.create(updateProposal());
    adapter.records.delete("opp_1");
    await expectCode(gov.approvals.approve(p.id, ZHANG), ErrorCode.CONFLICT);
    expect((await gov.proposals.get(p.id))?.status).toBe("failed");
  });

  it("适配器写入报错 → 提案 failed、error 写原因，原错误继续抛出", async () => {
    const { gov, adapter } = setup();
    const p = await gov.proposals.create(updateProposal());
    const boom = new KaidanError(ErrorCode.UPSTREAM, "多维表格接口 500", { retryable: true });
    adapter.failNextWrite = boom;
    const thrown = await gov.approvals.approve(p.id, ZHANG).catch((e: unknown) => e);
    expect(thrown).toBe(boom);
    const failed = await gov.proposals.get(p.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toContain("多维表格接口 500");
    const ev = await gov.audit.query({ tenantId: TENANT, proposalId: p.id, type: "proposal_failed" });
    expect(ev[0]?.data).toMatchObject({ proposalId: p.id, by: ZHANG.userId });
  });

  it("create 提案：以 approver 身份创建记录，resultId = 新记录 id", async () => {
    const { gov, adapter } = setup();
    const p = await gov.proposals.create({
      tenantId: TENANT,
      actorUserId: ZHANG.userId,
      kind: "create",
      objectType: "task",
      patch: { title: "发送报价单", dueDate: "2026-09-24", status: "open", opportunityId: "opp_1" },
      diff: [{ field: "title", before: null, after: "发送报价单" }],
      reason: "会后待办",
      traceId: "t-create",
    });
    const done = await gov.approvals.approve(p.id, ZHANG);
    expect(done.status).toBe("committed");
    expect(done.resultId).toBe("task_new_1");
    expect(adapter.records.get("task_new_1")).toMatchObject({ title: "发送报价单", ownerId: ZHANG.userId });
    expect([...adapter.applied]).toEqual([p.id]);
  });

  it("不存在的提案 → NOT_FOUND", async () => {
    const { gov } = setup();
    await expectCode(gov.approvals.approve("prop_missing", ZHANG), ErrorCode.NOT_FOUND);
  });
});

describe("ApprovalService.reject", () => {
  it("pending → rejected，不写；已 rejected / committed 再操作 → INVALID_STATE", async () => {
    const { gov, adapter } = setup();
    const p = await gov.proposals.create(updateProposal());
    const r = await gov.approvals.reject(p.id, WANG, "不需要");
    expect(r).toMatchObject({ status: "rejected", decidedBy: WANG.userId });
    expect(adapter.writes).toBe(0);
    await expectCode(gov.approvals.approve(p.id, ZHANG), ErrorCode.INVALID_STATE);
    await expectCode(gov.approvals.reject(p.id, ZHANG), ErrorCode.INVALID_STATE);

    const q = await gov.proposals.create(updateProposal());
    await gov.approvals.approve(q.id, ZHANG);
    await expectCode(gov.approvals.reject(q.id, ZHANG), ErrorCode.INVALID_STATE);

    const ev = await gov.audit.query({ tenantId: TENANT, proposalId: p.id, type: "proposal_rejected" });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.data).toEqual({ proposalId: p.id, by: WANG.userId });
  });

  it("过期提案 reject：首次 EXPIRED", async () => {
    const { gov, clock } = setup(60);
    const p = await gov.proposals.create(updateProposal());
    clock.advanceMinutes(60);
    await expectCode(gov.approvals.reject(p.id, ZHANG), ErrorCode.EXPIRED);
    expect((await gov.proposals.get(p.id))?.status).toBe("expired");
  });
});

describe("AuditLog", () => {
  it("append：aud_ 前缀、at 缺省取 clock，data 原样保存", async () => {
    const { gov } = setup();
    const e = await gov.audit.append({
      tenantId: TENANT,
      actorUserId: ZHANG.userId,
      type: "tool_call",
      traceId: "t-a",
      data: { tool: "crm_search", ok: true, ms: 3 },
    });
    expect(e.id).toMatch(/^aud_[0-9a-f-]{36}$/);
    expect(Date.parse(e.at)).toBe(Date.parse(START));
    const [back] = await gov.audit.query({ tenantId: TENANT, traceId: "t-a" });
    expect(back).toEqual(e);
  });

  it("query：按 traceId / proposalId（匹配 data.proposalId）/ type 过滤，按时间升序，同一时刻按写入顺序，limit 生效", async () => {
    const { gov, clock } = setup();
    const p = await gov.proposals.create(updateProposal({ traceId: "t-x" }));
    await gov.audit.append({ tenantId: TENANT, actorUserId: ZHANG.userId, type: "skill_invoked", traceId: "t-x", data: { skill: "post-meeting", channel: "cli" } });
    await gov.audit.append({ tenantId: TENANT, actorUserId: ZHANG.userId, type: "llm_call", traceId: "t-x", data: { provider: "scripted" } });
    await gov.audit.append({ tenantId: TENANT, actorUserId: LI.userId, type: "tool_call", traceId: "t-y", data: { tool: "crm_get" } });
    await gov.audit.append({ tenantId: "other", actorUserId: LI.userId, type: "tool_call", traceId: "t-x", data: {} });
    // 显式给更早的 at：应排到最前
    await gov.audit.append({ tenantId: TENANT, actorUserId: ZHANG.userId, type: "permission_denied", traceId: "t-x", data: { tool: "crm_get" }, at: "2026-09-21T08:00:00+08:00" });
    clock.advanceMinutes(5);
    await gov.approvals.approve(p.id, ZHANG);

    const byTrace = await gov.audit.query({ tenantId: TENANT, traceId: "t-x" });
    expect(byTrace.map((e) => e.type)).toEqual([
      "permission_denied",
      "proposal_created",
      "skill_invoked",
      "llm_call",
      "proposal_committed",
    ]);
    const byProposal = await gov.audit.query({ tenantId: TENANT, proposalId: p.id });
    expect(byProposal.map((e) => e.type)).toEqual(["proposal_created", "proposal_committed"]);
    const byType = await gov.audit.query({ tenantId: TENANT, type: "tool_call" });
    expect(byType.map((e) => e.traceId)).toEqual(["t-y"]);
    expect(await gov.audit.query({ tenantId: TENANT, traceId: "t-x", limit: 2 })).toHaveLength(2);
  });

  it("query：limit 缺省 100", async () => {
    const { gov } = setup();
    for (let i = 0; i < 105; i++) {
      await gov.audit.append({ tenantId: TENANT, actorUserId: ZHANG.userId, type: "llm_call", traceId: "t-many", data: { i } });
    }
    const got = await gov.audit.query({ tenantId: TENANT, traceId: "t-many" });
    expect(got).toHaveLength(100);
    expect(got[0]!.data).toEqual({ i: 0 });
  });

  it("审批审计只含元数据：不含 patch 正文与 reason", async () => {
    const { gov } = setup();
    const p = await gov.proposals.create(updateProposal({ reason: "客户手机号 13800000001 已确认" }));
    await gov.approvals.approve(p.id, ZHANG);
    const all = JSON.stringify(await gov.audit.query({ tenantId: TENANT, proposalId: p.id }));
    expect(all).not.toContain("13800000001");
    expect(all).not.toContain("9月24日前发送正式报价单");
  });
});
