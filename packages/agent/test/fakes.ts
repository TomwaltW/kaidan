// 测试用 fake：ToolRegistry / AuditLog / ProposalService 与技能清单（不依赖 T1 / T3 的实现）。
// @kaidan/agent 不依赖 @kaidan/governance（package.json 冻结），所以这里全部用 fake。
import {
  CalendarTodayInput,
  CrmGetInput,
  CrmSearchInput,
  CrmTimelineInput,
  ErrorCode,
  PipelineSnapshotInput,
  ProposeCreateInput,
  ProposeUpdateInput,
  SchemaInspectInput,
  type Actor,
  type AuditEvent,
  type AuditLog,
  type AuditQuery,
  type NewAuditEvent,
  type NewProposal,
  type Proposal,
  type ProposalService,
  type SkillManifest,
  type ToolContext,
  type ToolDef,
  type ToolInvokeResult,
  type ToolName,
  type ToolRegistry,
} from "@kaidan/contracts";
import { z } from "zod";

export const TENANT = "demo";
export const START = "2026-09-21T09:00:00+08:00";

export const ZHANG: Actor = { tenantId: TENANT, userId: "ou_rep_zhang", displayName: "张三", roles: ["rep"], managerId: "ou_mgr_wang" };
export const ADMIN: Actor = { tenantId: TENANT, userId: "ou_admin", displayName: "管理员", roles: ["admin"] };

const INPUTS: Record<ToolName, z.ZodType> = {
  crm_search: CrmSearchInput,
  crm_get: CrmGetInput,
  crm_timeline: CrmTimelineInput,
  pipeline_snapshot: PipelineSnapshotInput,
  propose_update: ProposeUpdateInput,
  propose_create: ProposeCreateInput,
  calendar_today: CalendarTodayInput,
  schema_inspect: SchemaInspectInput,
};

export type Handler = (ctx: ToolContext, input: unknown) => ToolInvokeResult | Promise<ToolInvokeResult>;

/** 按 ToolName 顺序列出 8 个工具；invoke 记录调用并交给可替换的 handler */
export class FakeRegistry implements ToolRegistry {
  readonly calls: { ctx: ToolContext; name: string; input: unknown }[] = [];
  readonly handlers = new Map<string, Handler>();
  private readonly defs: ToolDef[] = (Object.keys(INPUTS) as ToolName[]).map((name) => ({
    name,
    description: `${name} 的说明`,
    input: INPUTS[name] as z.ZodType<unknown>,
    output: z.unknown(),
    readOnly: !name.startsWith("propose_"),
    handler: async () => ({}),
  }));

  list(filter?: { names?: readonly ToolName[] }): ToolDef[] {
    return filter?.names ? this.defs.filter((d) => filter.names!.includes(d.name)) : [...this.defs];
  }
  get(name: ToolName): ToolDef | undefined {
    return this.defs.find((d) => d.name === name);
  }
  async invoke(ctx: ToolContext, name: string, rawInput: unknown): Promise<ToolInvokeResult> {
    this.calls.push({ ctx, name, input: rawInput });
    const h = this.handlers.get(name);
    if (h) return h(ctx, rawInput);
    if (!this.get(name as ToolName)) {
      return { ok: false, error: { code: ErrorCode.VALIDATION, message: `未知工具 ${name}` }, ms: 0 };
    }
    return { ok: true, output: { echo: rawInput }, ms: 1 };
  }
}

export class FakeAudit implements AuditLog {
  readonly events: AuditEvent[] = [];
  async append(e: NewAuditEvent): Promise<AuditEvent> {
    const ev: AuditEvent = { id: `aud_${this.events.length + 1}`, at: e.at ?? START, ...e };
    this.events.push(ev);
    return ev;
  }
  async query(q: AuditQuery): Promise<AuditEvent[]> {
    return this.events.filter(
      (e) => e.tenantId === q.tenantId && (q.traceId === undefined || e.traceId === q.traceId) && (q.type === undefined || e.type === q.type),
    );
  }
  types(): string[] {
    return this.events.map((e) => e.type);
  }
}

export class FakeProposals implements ProposalService {
  readonly store = new Map<string, Proposal>();
  private n = 0;
  async create(p: NewProposal): Promise<Proposal> {
    const proposal: Proposal = {
      id: `prop_${++this.n}`,
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
      createdAt: START,
      expiresAt: "2026-09-22T09:00:00+08:00",
    };
    this.store.set(proposal.id, proposal);
    return proposal;
  }
  async get(id: string): Promise<Proposal | null> {
    return this.store.get(id) ?? null;
  }
  async listPending(): Promise<Proposal[]> {
    return [...this.store.values()].filter((p) => p.status === "pending");
  }
}

function skill(name: SkillManifest["name"], allowedTools: ToolName[], extra: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name,
    description: `${name} 技能的说明文字`,
    allowedTools,
    body: `## 何时使用\n${name} 正文标记 BODY_${name}`,
    path: `/fake/${name}/SKILL.md`,
    ...extra,
  };
}

/** 与 spec 附录 B 一致的 7 个技能清单（正文为占位） */
export function skillSet(): SkillManifest[] {
  return [
    skill("assistant", ["crm_search", "crm_get", "crm_timeline", "pipeline_snapshot", "calendar_today", "propose_update", "propose_create"]),
    skill("call-prep", ["calendar_today", "crm_search", "crm_get", "crm_timeline", "propose_create"], { command: "/会前" }),
    skill("daily-brief", ["pipeline_snapshot", "calendar_today", "crm_get", "crm_timeline"], {
      command: "/晨报",
      schedule: "daily_brief",
    }),
    skill("deal-review", ["crm_search", "crm_get", "crm_timeline", "propose_update", "propose_create"], { command: "/商机体检" }),
    skill("post-meeting", ["crm_search", "crm_get", "crm_timeline", "propose_update", "propose_create"], { command: "/会后" }),
    skill("setup", ["schema_inspect"], { command: "/初始化", roles: ["admin"] }),
    skill("weekly-review", ["pipeline_snapshot", "crm_search", "crm_timeline"], { command: "/周报", schedule: "weekly_review" }),
  ];
}
