// 测试用内存 fake：RomAdapter（可见性规则 V1）、ProposalService、AuditLog、ContextProvider。
// 不依赖 @kaidan/adapters 与 @kaidan/governance（T2 并行实现；spec 3.4 对本包不可见）。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ErrorCode,
  KaidanError,
  RomDataset,
  type Actor,
  type AuditEvent,
  type AuditLog,
  type ContextProvider,
  type NewProposal,
  type Proposal,
  type ProposalService,
  type RiskConfig,
  type RomAdapter,
  type RomObjectType,
  type RomRecord,
  type ToolDeps,
} from "@kaidan/contracts";

export const MINI_PATH = fileURLToPath(new URL("../../../tests/e2e/fixtures/mini.json", import.meta.url));
export const NOW = new Date("2026-09-21T09:00:00+08:00");
export const RISK: RiskConfig = {
  staleDays: 14,
  stuckDays: 30,
  soonDays: 7,
  requiredQualificationKeys: ["pain", "decision_maker", "budget", "timeline"],
};

export function loadMini(): RomDataset {
  return RomDataset.parse(JSON.parse(readFileSync(MINI_PATH, "utf8")));
}

const base = { tenantId: "demo" };
export const ZHANG: Actor = { ...base, userId: "ou_rep_zhang", displayName: "张三", roles: ["rep"], managerId: "ou_mgr_wang" };
export const LI: Actor = { ...base, userId: "ou_rep_li", displayName: "李四", roles: ["rep"], managerId: "ou_mgr_wang" };
export const WANG: Actor = {
  ...base,
  userId: "ou_mgr_wang",
  displayName: "王经理",
  roles: ["manager"],
  teamIds: ["ou_rep_zhang", "ou_rep_li"],
};
export const ADMIN: Actor = { ...base, userId: "ou_admin", displayName: "管理员", roles: ["admin"] };

const COLLECTION = {
  account: "accounts",
  contact: "contacts",
  opportunity: "opportunities",
  activity: "activities",
  task: "tasks",
} as const;

/** 最小可用的内存适配器：可见性 V1 + eq / text / sort / cursor；写方法记录调用（工具层绝不应调用它们） */
export class FakeAdapter implements RomAdapter {
  readonly kind = "mock" as const;
  readonly data: RomDataset;
  writeCalls = 0;
  searchCalls: unknown[] = [];
  /** 下一次调用 search / get 时抛出的错误 */
  failNext: Error | undefined;

  constructor(ds: RomDataset = loadMini()) {
    this.data = structuredClone(ds);
  }

  private all(type: RomObjectType): RomRecord[] {
    return this.data[COLLECTION[type]] as RomRecord[];
  }
  private ownerOk(a: Actor, ownerId: string): boolean {
    return a.roles.includes("admin") || ownerId === a.userId || (a.roles.includes("manager") && (a.teamIds ?? []).includes(ownerId));
  }
  visible(a: Actor, r: RomRecord): boolean {
    if (this.ownerOk(a, r.ownerId)) return true;
    if (r.type === "account" || r.type === "opportunity") return false;
    const acc = "accountId" in r && r.accountId ? this.all("account").find((x) => x.id === r.accountId) : undefined;
    const opp = "opportunityId" in r && r.opportunityId ? this.all("opportunity").find((x) => x.id === r.opportunityId) : undefined;
    return (!!acc && this.ownerOk(a, acc.ownerId)) || (!!opp && this.ownerOk(a, opp.ownerId));
  }
  private boom(): void {
    const e = this.failNext;
    this.failNext = undefined;
    if (e) throw e;
  }

  async search(actor: Actor, q: Parameters<RomAdapter["search"]>[1]) {
    this.boom();
    this.searchCalls.push(structuredClone(q));
    let rows = this.all(q.type).filter((r) => this.visible(actor, r));
    for (const f of q.filters ?? []) {
      if (f.op !== "eq") throw new Error(`fake 只支持 eq：${f.op}`);
      rows = rows.filter((r) => (r as Record<string, unknown>)[f.field] === f.value);
    }
    if (q.text) {
      rows = rows.filter((r) =>
        ["name", "subject", "title", "summary"].some((k) => String((r as Record<string, unknown>)[k] ?? "").includes(q.text!)),
      );
    }
    const field = q.sort?.field ?? "id";
    const dir = q.sort?.dir === "desc" ? -1 : 1;
    rows = [...rows].sort((a, b) => {
      const va = String((a as Record<string, unknown>)[field] ?? "￿");
      const vb = String((b as Record<string, unknown>)[field] ?? "￿");
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir || (a.id < b.id ? -1 : 1);
    });
    const offset = Number(q.cursor ?? 0);
    const limit = q.limit ?? 20;
    const items = structuredClone(rows.slice(offset, offset + limit));
    return offset + limit < rows.length ? { items, nextCursor: String(offset + limit) } : { items };
  }

  async get(actor: Actor, ref: { type: RomObjectType; id: string }) {
    this.boom();
    const r = this.all(ref.type).find((x) => x.id === ref.id);
    if (!r) return null;
    if (!this.visible(actor, r)) throw new KaidanError(ErrorCode.PERMISSION_DENIED, "无权限访问该记录");
    return structuredClone(r);
  }

  async create(): Promise<RomRecord> {
    this.writeCalls++;
    throw new Error("工具层不应直接写入");
  }
  async update(): Promise<RomRecord> {
    this.writeCalls++;
    throw new Error("工具层不应直接写入");
  }
  async inspectSchema(actor: Actor) {
    if (!actor.roles.includes("admin")) throw new KaidanError(ErrorCode.PERMISSION_DENIED, "仅管理员");
    return { source: "mock" as const, tables: [{ id: "opportunity", name: "商机", fields: [{ name: "stage", kind: "enum" }] }] };
  }
}

export class FakeProposals implements ProposalService {
  readonly items: Proposal[] = [];
  created: NewProposal[] = [];
  constructor(private readonly now: () => Date = () => NOW) {}
  async create(p: NewProposal): Promise<Proposal> {
    this.created.push(structuredClone(p));
    const createdAt = this.now();
    const ttl = p.ttlMinutes ?? 1440;
    const proposal: Proposal = {
      id: `prop_${this.items.length + 1}`,
      tenantId: p.tenantId,
      actorUserId: p.actorUserId,
      kind: p.kind,
      objectType: p.objectType,
      ...(p.targetId ? { targetId: p.targetId } : {}),
      patch: p.patch,
      diff: p.diff,
      reason: p.reason,
      status: "pending",
      traceId: p.traceId,
      ...(p.skill ? { skill: p.skill } : {}),
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttl * 60_000).toISOString(),
    };
    this.items.push(proposal);
    return structuredClone(proposal);
  }
  async get(id: string) {
    return this.items.find((p) => p.id === id) ?? null;
  }
  async listPending(tenantId: string, actorUserId: string) {
    return this.items.filter((p) => p.tenantId === tenantId && p.actorUserId === actorUserId && p.status === "pending");
  }
}

export class FakeAudit implements AuditLog {
  readonly events: AuditEvent[] = [];
  fail = false;
  async append(e: Parameters<AuditLog["append"]>[0]): Promise<AuditEvent> {
    if (this.fail) throw new Error("审计库不可用");
    const ev: AuditEvent = { ...e, id: `aud_${this.events.length + 1}`, at: e.at ?? NOW.toISOString() };
    this.events.push(ev);
    return ev;
  }
  async query(q: Parameters<AuditLog["query"]>[0]) {
    return this.events.filter(
      (e) =>
        e.tenantId === q.tenantId &&
        (!q.traceId || e.traceId === q.traceId) &&
        (!q.type || e.type === q.type) &&
        (!q.proposalId || e.data["proposalId"] === q.proposalId),
    );
  }
}

export class FakeContext implements ContextProvider {
  dates: string[] = [];
  constructor(private readonly ds: RomDataset = loadMini()) {}
  async calendarToday(actor: Actor, date: string) {
    this.dates.push(date);
    return this.ds.calendar.filter((e) => e.ownerId === actor.userId && e.start.startsWith(date));
  }
}

export interface Fixture {
  deps: ToolDeps;
  adapter: FakeAdapter;
  proposals: FakeProposals;
  audit: FakeAudit;
  context: FakeContext;
}

export function fixture(opts: { dataset?: RomDataset; clock?: () => Date } = {}): Fixture {
  const ds = opts.dataset ?? loadMini();
  const adapter = new FakeAdapter(ds);
  const proposals = new FakeProposals(opts.clock);
  const audit = new FakeAudit();
  const context = new FakeContext(ds);
  const deps: ToolDeps = {
    adapter,
    proposals,
    audit,
    context,
    risk: RISK,
    timezone: "Asia/Shanghai",
    proposalTtlMinutes: 1440,
    clock: opts.clock ?? (() => NOW),
  };
  return { deps, adapter, proposals, audit, context };
}
