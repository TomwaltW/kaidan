// @kaidan/governance —— 提案 / 审批 / 审计（spec 3.1 governance.ts、3.2 第 1、9 条）。
// 存储用 Node 内置 node:sqlite；时间一律取 deps.clock。
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ErrorCode,
  KaidanError,
  isKaidanError,
  type Actor,
  type ApprovalService,
  type AuditEvent,
  type AuditLog,
  type AuditQuery,
  type CreateGovernance,
  type GovernanceDeps,
  type NewAuditEvent,
  type NewProposal,
  type Proposal,
  type ProposalService,
  type RomRecord,
} from "@kaidan/contracts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS proposals (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_ms INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_pending ON proposals (tenant_id, actor_user_id, status);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  at TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  proposal_id TEXT,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_trace ON audit (tenant_id, trace_id);
CREATE INDEX IF NOT EXISTS audit_proposal ON audit (tenant_id, proposal_id);
`;

export const createGovernance: CreateGovernance = (deps: GovernanceDeps) => {
  const clock = deps.clock ?? (() => new Date());
  if (deps.dbPath !== ":memory:") mkdirSync(dirname(deps.dbPath), { recursive: true });
  const db = new DatabaseSync(deps.dbPath);
  db.exec(SCHEMA);
  let closed = false;

  // ------------------------------------------------------------------ audit

  const insertAudit = db.prepare(
    `INSERT INTO audit (id, at, at_ms, tenant_id, actor_user_id, type, trace_id, proposal_id, data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const audit: AuditLog = {
    async append(e: NewAuditEvent): Promise<AuditEvent> {
      const at = e.at ?? clock().toISOString();
      const atMs = Date.parse(at);
      if (Number.isNaN(atMs)) throw new KaidanError(ErrorCode.VALIDATION, `审计时间不合法：${at}`);
      const event: AuditEvent = {
        id: `aud_${randomUUID()}`,
        at,
        tenantId: e.tenantId,
        actorUserId: e.actorUserId,
        type: e.type,
        traceId: e.traceId,
        data: { ...e.data },
      };
      const pid = event.data["proposalId"];
      insertAudit.run(
        event.id,
        event.at,
        atMs,
        event.tenantId,
        event.actorUserId,
        event.type,
        event.traceId,
        typeof pid === "string" ? pid : null,
        JSON.stringify(event.data),
      );
      return event;
    },
    async query(q: AuditQuery): Promise<AuditEvent[]> {
      const where = ["tenant_id = ?"];
      const args: (string | number)[] = [q.tenantId];
      if (q.traceId !== undefined) {
        where.push("trace_id = ?");
        args.push(q.traceId);
      }
      if (q.proposalId !== undefined) {
        where.push("proposal_id = ?");
        args.push(q.proposalId);
      }
      if (q.type !== undefined) {
        where.push("type = ?");
        args.push(q.type);
      }
      args.push(q.limit ?? 100);
      const rows = db
        .prepare(`SELECT * FROM audit WHERE ${where.join(" AND ")} ORDER BY at_ms ASC, seq ASC LIMIT ?`)
        .all(...args) as unknown as AuditRow[];
      return rows.map((r) => ({
        id: r.id,
        at: r.at,
        tenantId: r.tenant_id,
        actorUserId: r.actor_user_id,
        type: r.type as AuditEvent["type"],
        traceId: r.trace_id,
        data: JSON.parse(r.data) as Record<string, unknown>,
      }));
    },
  };

  // ------------------------------------------------------------------ proposals

  const insertProposal = db.prepare(
    `INSERT INTO proposals (id, tenant_id, actor_user_id, status, expires_ms, body) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const updateProposal = db.prepare(`UPDATE proposals SET status = ?, body = ? WHERE id = ?`);
  const selectProposal = db.prepare(`SELECT body FROM proposals WHERE id = ?`);
  const selectPending = db.prepare(
    `SELECT body FROM proposals WHERE tenant_id = ? AND actor_user_id = ? AND status = 'pending' ORDER BY seq ASC`,
  );

  function load(id: string): Proposal | null {
    const row = selectProposal.get(id) as { body: string } | undefined;
    return row ? (JSON.parse(row.body) as Proposal) : null;
  }

  function save(p: Proposal): Proposal {
    updateProposal.run(p.status, JSON.stringify(p), p.id);
    return p;
  }

  const proposals: ProposalService = {
    async create(input: NewProposal): Promise<Proposal> {
      if (input.kind === "update" && !input.targetId) {
        throw new KaidanError(ErrorCode.VALIDATION, "更新提案必须指定 targetId");
      }
      const ttl = input.ttlMinutes ?? deps.proposalTtlMinutes;
      if (!(ttl > 0)) throw new KaidanError(ErrorCode.VALIDATION, `提案有效期不合法：${ttl}`);
      const now = clock();
      const expires = new Date(now.getTime() + ttl * 60_000);
      const p: Proposal = {
        id: `prop_${randomUUID()}`,
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        kind: input.kind,
        objectType: input.objectType,
        ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
        patch: structuredClone(input.patch),
        diff: structuredClone(input.diff),
        reason: input.reason,
        status: "pending",
        traceId: input.traceId,
        ...(input.skill !== undefined ? { skill: input.skill } : {}),
        createdAt: now.toISOString(),
        expiresAt: expires.toISOString(),
      };
      insertProposal.run(p.id, p.tenantId, p.actorUserId, p.status, expires.getTime(), JSON.stringify(p));
      await audit.append({
        tenantId: p.tenantId,
        actorUserId: p.actorUserId,
        type: "proposal_created",
        traceId: p.traceId,
        data: { proposalId: p.id, objectType: p.objectType, kind: p.kind },
      });
      return p;
    },
    async get(id: string): Promise<Proposal | null> {
      return load(id);
    },
    async listPending(tenantId: string, actorUserId: string): Promise<Proposal[]> {
      // 只按状态筛选：过期的状态迁移只发生在 approve/reject 的首次访问（spec 3.3）
      const rows = selectPending.all(tenantId, actorUserId) as unknown as { body: string }[];
      return rows.map((r) => JSON.parse(r.body) as Proposal);
    },
  };

  // ------------------------------------------------------------------ approvals

  // 同一提案的审批串行执行，避免并发双击导致重复提交
  const locks = new Map<string, Promise<unknown>>();
  function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(id) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    locks.set(id, tail);
    void tail.then(() => {
      if (locks.get(id) === tail) locks.delete(id);
    });
    return next;
  }

  /** 取提案并检查审批人权限（先于任何状态变更） */
  async function loadForDecision(proposalId: string, approver: Actor): Promise<Proposal> {
    const p = load(proposalId);
    if (!p) throw new KaidanError(ErrorCode.NOT_FOUND, `提案不存在：${proposalId}`);
    if (!canDecide(p, approver)) throw new KaidanError(ErrorCode.PERMISSION_DENIED, "你无权审批该提案");
    return p;
  }

  /** pending 且已过期 → 置 expired、写审计、抛 EXPIRED */
  async function expireIfDue(p: Proposal, approver: Actor): Promise<void> {
    const now = clock();
    if (p.status !== "pending" || now.getTime() < Date.parse(p.expiresAt)) return;
    save({ ...p, status: "expired", decidedAt: now.toISOString() });
    await audit.append({
      tenantId: p.tenantId,
      actorUserId: approver.userId,
      type: "proposal_expired",
      traceId: p.traceId,
      data: { proposalId: p.id, by: approver.userId },
    });
    throw new KaidanError(ErrorCode.EXPIRED, "提案已过期");
  }

  async function fail(p: Proposal, approver: Actor, error: string): Promise<void> {
    save({ ...p, status: "failed", decidedAt: clock().toISOString(), decidedBy: approver.userId, error });
    await audit.append({
      tenantId: p.tenantId,
      actorUserId: approver.userId,
      type: "proposal_failed",
      traceId: p.traceId,
      data: { proposalId: p.id, by: approver.userId, error },
    });
  }

  const approvals: ApprovalService = {
    approve(proposalId: string, approver: Actor): Promise<Proposal> {
      return serialized(proposalId, async () => {
        const p = await loadForDecision(proposalId, approver);
        if (p.status === "committed") return p; // 幂等：不再写
        await expireIfDue(p, approver);
        if (p.status !== "pending") throw invalidState(p);

        const opts = { idempotencyKey: p.id, proposalId: p.id };
        let resultId: string | undefined;
        if (p.kind === "update") {
          const ref = { type: p.objectType, id: p.targetId ?? "" };
          let current: RomRecord | null;
          try {
            current = await deps.adapter.get(approver, ref);
          } catch (e) {
            await fail(p, approver, `提交前读取目标记录失败：${errorMessage(e)}`);
            throw e;
          }
          const conflict = current === null ? "目标记录已不存在" : findConflict(p, current);
          if (conflict) {
            await fail(p, approver, conflict);
            throw new KaidanError(ErrorCode.CONFLICT, `记录已被他人修改，请重新生成（${conflict}）`, {
              details: { proposalId: p.id },
            });
          }
          try {
            await deps.adapter.update(approver, ref, structuredClone(p.patch), opts);
          } catch (e) {
            await fail(p, approver, `写入失败：${errorMessage(e)}`);
            throw e;
          }
        } else {
          try {
            const created = await deps.adapter.create(approver, p.objectType, structuredClone(p.patch), opts);
            resultId = created.id;
          } catch (e) {
            await fail(p, approver, `写入失败：${errorMessage(e)}`);
            throw e;
          }
        }

        const committed = save({
          ...p,
          status: "committed",
          decidedAt: clock().toISOString(),
          decidedBy: approver.userId,
          ...(resultId !== undefined ? { resultId } : {}),
        });
        await audit.append({
          tenantId: p.tenantId,
          actorUserId: approver.userId,
          type: "proposal_committed",
          traceId: p.traceId,
          data: { proposalId: p.id, by: approver.userId },
        });
        return committed;
      });
    },

    reject(proposalId: string, approver: Actor, _note?: string): Promise<Proposal> {
      return serialized(proposalId, async () => {
        const p = await loadForDecision(proposalId, approver);
        await expireIfDue(p, approver);
        if (p.status !== "pending") throw invalidState(p);
        const rejected = save({ ...p, status: "rejected", decidedAt: clock().toISOString(), decidedBy: approver.userId });
        // note 是用户自由文本，不进审计（审计只记元数据）
        await audit.append({
          tenantId: p.tenantId,
          actorUserId: approver.userId,
          type: "proposal_rejected",
          traceId: p.traceId,
          data: { proposalId: p.id, by: approver.userId },
        });
        return rejected;
      });
    },
  };

  return {
    proposals,
    approvals,
    audit,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
};

interface AuditRow {
  id: string;
  at: string;
  tenant_id: string;
  actor_user_id: string;
  type: string;
  trace_id: string;
  data: string;
}

/** 允许的审批人：提案人本人；或 admin；或 manager 且 teamIds 包含提案人（同一租户内） */
function canDecide(p: Proposal, approver: Actor): boolean {
  if (approver.tenantId !== p.tenantId) return false;
  if (approver.userId === p.actorUserId) return true;
  if (approver.roles.includes("admin")) return true;
  return approver.roles.includes("manager") && (approver.teamIds ?? []).includes(p.actorUserId);
}

function invalidState(p: Proposal): KaidanError {
  return new KaidanError(ErrorCode.INVALID_STATE, `提案状态为 ${p.status}，不能再审批`, {
    details: { proposalId: p.id, status: p.status },
  });
}

/** diff 中任一 before 与当前值不同 → 返回原因；before 为 null 与字段不存在视为相等 */
function findConflict(p: Proposal, current: RomRecord): string | null {
  const record = current as unknown as Record<string, unknown>;
  const changed = p.diff.filter((d) => !sameValue(d.before, record[d.field])).map((d) => d.field);
  return changed.length ? `字段已变化：${changed.join("、")}` : null;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  return stableJson(a) === stableJson(b);
}

function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val !== null && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : val,
  );
}

function errorMessage(e: unknown): string {
  if (isKaidanError(e)) return `${e.code} ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
