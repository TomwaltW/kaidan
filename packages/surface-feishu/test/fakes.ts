// 测试用 fake：不依赖其他 track 的实现（spec 3.4），全部在本包内。
import {
  ErrorCode,
  KaidanConfig,
  KaidanError,
  type Actor,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRuntime,
  type Governance,
  type LarkClientLike,
  type ModelDisclosure,
  type OutboundCard,
  type Proposal,
  type SkillManifest,
} from "@kaidan/contracts";

export const TENANT = "demo";
export const WANG = "ou_mgr_wang";
export const ZHANG = "ou_rep_zhang";
export const LI = "ou_rep_li";
export const ADMIN = "ou_admin";
export const DISCLOSURE: ModelDisclosure = { providerName: "测试", modelName: "scripted" };

export function testConfig(extra: Record<string, unknown> = {}): KaidanConfig {
  return KaidanConfig.parse({
    tenantId: TENANT,
    timezone: "Asia/Shanghai",
    llm: { kind: "scripted", disclosure: { ...DISCLOSURE } },
    adapter: { kind: "mock", mock: { datasetPath: "/dev/null" } },
    governance: { dbPath: ":memory:", proposalTtlMinutes: 1440 },
    risk: { staleDays: 14, stuckDays: 30, soonDays: 7, requiredQualificationKeys: ["pain"] },
    users: [
      { openId: WANG, displayName: "王经理", roles: ["manager"] },
      { openId: ZHANG, displayName: "张三", roles: ["rep"], managerOpenId: WANG, scheduled: true },
      { openId: LI, displayName: "李四", roles: ["rep"], managerOpenId: WANG, scheduled: true },
      { openId: ADMIN, displayName: "管理员", roles: ["admin"] },
    ],
    ...extra,
  });
}

export function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: "prop_1",
    tenantId: TENANT,
    actorUserId: ZHANG,
    kind: "update",
    objectType: "opportunity",
    targetId: "opp_1",
    patch: { stage: "negotiation", nextStep: "9月24日前发送正式报价单" },
    diff: [
      { field: "stage", before: "solution", after: "negotiation" },
      { field: "nextStep", before: "", after: "9月24日前发送正式报价单" },
    ],
    reason: "会后：客户确认方案，进入商务谈判",
    status: "pending",
    traceId: "t-1",
    skill: "post-meeting",
    createdAt: "2026-09-21T09:00:00+08:00",
    expiresAt: "2026-09-22T09:00:00+08:00",
    ...over,
  };
}

export function runResult(over: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    traceId: "t",
    skill: "assistant",
    reply: "好的",
    proposals: [],
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    steps: 1,
    stoppedBy: "final",
    disclosure: { ...DISCLOSURE },
    ...over,
  };
}

type RunImpl = (input: AgentRunInput) => AgentRunResult | Promise<AgentRunResult>;

/** 按顺序返回预设结果；runs 记录每次调用 */
export class FakeAgent implements AgentRuntime {
  readonly runs: AgentRunInput[] = [];
  private queue: RunImpl[];
  constructor(results: (AgentRunResult | RunImpl)[] = []) {
    this.queue = results.map((r) => (typeof r === "function" ? r : () => r));
  }
  async run(input: AgentRunInput): Promise<AgentRunResult> {
    this.runs.push(structuredClone(input));
    const next = this.queue.shift();
    if (!next) throw new Error("FakeAgent: 没有预设结果了");
    return next(input);
  }
  skills(): SkillManifest[] {
    return [];
  }
}

/** 审批规则按契约最小实现：本人 / admin / 上级 manager 可审批；可按提案 id 预设抛错 */
export class FakeGovernance implements Governance {
  readonly calls: { op: "approve" | "reject"; proposalId: string; by: string }[] = [];
  readonly store = new Map<string, Proposal>();
  readonly failWith = new Map<string, unknown>();

  constructor(proposals: Proposal[] = []) {
    for (const p of proposals) this.store.set(p.id, p);
  }

  private decide(proposalId: string, approver: Actor, status: "committed" | "rejected"): Proposal {
    const forced = this.failWith.get(proposalId);
    if (forced) throw forced;
    const p = this.store.get(proposalId);
    if (!p) throw new KaidanError(ErrorCode.NOT_FOUND, "提案不存在");
    const allowed =
      approver.userId === p.actorUserId ||
      approver.roles.includes("admin") ||
      (approver.roles.includes("manager") && (approver.teamIds ?? []).includes(p.actorUserId));
    if (!allowed) throw new KaidanError(ErrorCode.PERMISSION_DENIED, "无权审批");
    if (p.status === status) return p;
    if (p.status !== "pending") throw new KaidanError(ErrorCode.INVALID_STATE, `提案状态为 ${p.status}`);
    const next = { ...p, status, decidedBy: approver.userId };
    this.store.set(p.id, next);
    return next;
  }

  proposals = {
    create: async (): Promise<Proposal> => {
      throw new Error("FakeGovernance.proposals.create 不应被调用");
    },
    get: async (id: string) => this.store.get(id) ?? null,
    listPending: async (_t: string, userId: string) =>
      [...this.store.values()].filter((p) => p.actorUserId === userId && p.status === "pending"),
  };
  approvals = {
    approve: async (proposalId: string, approver: Actor) => {
      this.calls.push({ op: "approve", proposalId, by: approver.userId });
      return this.decide(proposalId, approver, "committed");
    },
    reject: async (proposalId: string, approver: Actor) => {
      this.calls.push({ op: "reject", proposalId, by: approver.userId });
      return this.decide(proposalId, approver, "rejected");
    },
  };
  audit = {
    append: async () => {
      throw new Error("FakeGovernance.audit.append 不应被调用");
    },
    query: async () => [],
  };
  async close(): Promise<void> {}
}

export interface SentCard {
  to: { chatId?: string; openId?: string };
  card: OutboundCard;
  messageId: string;
}

export class RecordingLarkClient implements LarkClientLike {
  readonly sent: SentCard[] = [];
  readonly updated: { messageId: string; card: OutboundCard }[] = [];
  /** 这些 openId 发送时抛错（模拟单个用户发送失败） */
  readonly failFor = new Set<string>();
  async sendCard(to: { chatId?: string; openId?: string }, card: OutboundCard): Promise<{ messageId: string }> {
    if (to.openId && this.failFor.has(to.openId)) throw new Error(`发送给 ${to.openId} 失败`);
    const messageId = `om_fake_${this.sent.length + 1}`;
    this.sent.push({ to: { ...to }, card: structuredClone(card), messageId });
    return { messageId };
  }
  async updateCard(messageId: string, card: OutboundCard): Promise<void> {
    this.updated.push({ messageId, card: structuredClone(card) });
  }
}

export function cardText(card: OutboundCard): string {
  return JSON.stringify(card.json);
}

/** 等待 fire-and-forget 的异步处理跑完 */
export async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}
