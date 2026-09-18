// @kaidan/contracts — governance.ts（冻结）
// 核心原则：模型只能"提案"，永远不能"提交"。提交只发生在人点了同意之后。
import { z } from "zod";
import { Actor, Id, IsoDateTime, RomObjectType } from "./rom.js";
import type { RomAdapter } from "./adapter.js";

export const FieldDiff = z.object({ field: z.string(), before: z.unknown(), after: z.unknown() });
export type FieldDiff = z.infer<typeof FieldDiff>;

export const ProposalStatus = z.enum(["pending", "committed", "rejected", "failed", "expired"]);
export type ProposalStatus = z.infer<typeof ProposalStatus>;

export const Proposal = z.object({
  id: Id,
  tenantId: Id,
  actorUserId: Id,
  kind: z.enum(["update", "create"]),
  objectType: RomObjectType,
  targetId: Id.optional(), // kind=update 时必填
  patch: z.record(z.string(), z.unknown()),
  diff: z.array(FieldDiff),
  reason: z.string(),
  status: ProposalStatus,
  traceId: z.string(),
  skill: z.string().optional(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  decidedAt: IsoDateTime.optional(),
  decidedBy: Id.optional(),
  resultId: Id.optional(), // kind=create 提交后生成的记录 id
  error: z.string().optional(),
});
export type Proposal = z.infer<typeof Proposal>;

export interface NewProposal {
  tenantId: string;
  actorUserId: string;
  kind: "update" | "create";
  objectType: RomObjectType;
  targetId?: string;
  patch: Record<string, unknown>;
  diff: FieldDiff[];
  reason: string;
  traceId: string;
  skill?: string;
  ttlMinutes?: number; // 缺省取 config.governance.proposalTtlMinutes
}

export interface ProposalService {
  create(p: NewProposal): Promise<Proposal>;
  get(id: string): Promise<Proposal | null>;
  listPending(tenantId: string, actorUserId: string): Promise<Proposal[]>;
}

/**
 * approve 规则：
 *  - 允许的审批人：提案人本人；或 admin；或 manager 且 teamIds 包含提案人。否则抛 PERMISSION_DENIED
 *  - pending 且未过期 → 以 approver 身份调用 adapter（idempotencyKey = proposalId）→ committed
 *  - 已 committed → 幂等返回原提案，不再写
 *  - 已过期 → 状态置 expired 并抛 EXPIRED
 *  - rejected / failed / expired → 抛 INVALID_STATE（过期的首次访问抛 EXPIRED）
 *  - update 提交前重读目标记录：若 diff 中任一 before 与当前值不同 → 状态 failed、error 写原因、抛 CONFLICT
 *  - adapter 抛错 → 状态 failed、error 写原因，原错误继续抛出
 */
export interface ApprovalService {
  approve(proposalId: string, approver: Actor): Promise<Proposal>;
  reject(proposalId: string, approver: Actor, note?: string): Promise<Proposal>;
}

export const AuditEventType = z.enum([
  "skill_invoked",
  "llm_call",
  "tool_call",
  "permission_denied",
  "proposal_created",
  "proposal_committed",
  "proposal_rejected",
  "proposal_failed",
  "proposal_expired",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

export const AuditEvent = z.object({
  id: Id,
  at: IsoDateTime,
  tenantId: Id,
  actorUserId: Id,
  type: AuditEventType,
  traceId: z.string(),
  /** 只放元数据（工具名、耗时、提案 id、token 数…），不放 CRM 正文与手机号 */
  data: z.record(z.string(), z.unknown()),
});
export type AuditEvent = z.infer<typeof AuditEvent>;
export type NewAuditEvent = Omit<AuditEvent, "id" | "at"> & { at?: string };

export interface AuditQuery {
  tenantId: string;
  traceId?: string;
  proposalId?: string; // 匹配 data.proposalId
  type?: AuditEventType;
  limit?: number; // 缺省 100，按时间升序
}

export interface AuditLog {
  append(e: NewAuditEvent): Promise<AuditEvent>;
  query(q: AuditQuery): Promise<AuditEvent[]>;
}

export interface Governance {
  proposals: ProposalService;
  approvals: ApprovalService;
  audit: AuditLog;
  close(): Promise<void>;
}

export interface GovernanceDeps {
  adapter: RomAdapter;
  dbPath: string; // ":memory:" 用于测试
  proposalTtlMinutes: number;
  clock?: () => Date;
}
