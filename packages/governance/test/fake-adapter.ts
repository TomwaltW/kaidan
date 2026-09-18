// 测试用内存版 RomAdapter：只实现治理层用到的 get / update / create，带可见性（ownerId / teamIds / admin）与幂等计数。
import {
  ErrorCode,
  KaidanError,
  type Actor,
  type Opportunity,
  type RomAdapter,
  type RomObjectType,
  type RomPage,
  type RomRecord,
  type RomRef,
  type SchemaInfo,
  type WriteOptions,
} from "@kaidan/contracts";

export const TENANT = "demo";

export const ZHANG: Actor = { tenantId: TENANT, userId: "ou_rep_zhang", displayName: "张三", roles: ["rep"], managerId: "ou_mgr_wang" };
export const LI: Actor = { tenantId: TENANT, userId: "ou_rep_li", displayName: "李四", roles: ["rep"], managerId: "ou_mgr_wang" };
export const WANG: Actor = {
  tenantId: TENANT,
  userId: "ou_mgr_wang",
  displayName: "王经理",
  roles: ["manager"],
  teamIds: ["ou_rep_zhang", "ou_rep_li"],
};
export const OTHER_MGR: Actor = { tenantId: TENANT, userId: "ou_mgr_other", displayName: "赵经理", roles: ["manager"], teamIds: ["ou_rep_zhao"] };
export const ADMIN: Actor = { tenantId: TENANT, userId: "ou_admin", displayName: "管理员", roles: ["admin"] };

const T0 = "2026-09-01T09:00:00+08:00";

export function opp(id: string, ownerId: string, extra: Partial<Opportunity> = {}): Opportunity {
  return {
    id,
    ownerId,
    createdAt: T0,
    updatedAt: T0,
    type: "opportunity",
    accountId: "acc_1",
    name: `商机 ${id}（虚构）`,
    stage: "solution",
    rawStage: "方案报价",
    amount: 100000,
    ...extra,
  };
}

export class FakeAdapter implements RomAdapter {
  readonly kind = "mock" as const;
  readonly records = new Map<string, RomRecord>();
  readonly applied = new Set<string>();
  writes = 0;
  seq = 0;
  /** 设置后，下一次写入抛出该错误 */
  failNextWrite: Error | null = null;

  constructor(records: RomRecord[]) {
    for (const r of records) this.records.set(r.id, structuredClone(r));
  }

  private visible(actor: Actor, r: RomRecord): boolean {
    if (actor.roles.includes("admin")) return true;
    if (r.ownerId === actor.userId) return true;
    return actor.roles.includes("manager") && (actor.teamIds ?? []).includes(r.ownerId);
  }

  async search(): Promise<RomPage> {
    throw new Error("fake：search 不应被治理层调用");
  }

  async get(actor: Actor, ref: RomRef): Promise<RomRecord | null> {
    const r = this.records.get(ref.id);
    if (!r || r.type !== ref.type) return null;
    if (!this.visible(actor, r)) throw new KaidanError(ErrorCode.PERMISSION_DENIED, "无权限访问该记录");
    return structuredClone(r);
  }

  async update(actor: Actor, ref: RomRef, patch: Record<string, unknown>, opts: WriteOptions): Promise<RomRecord> {
    const current = await this.get(actor, ref);
    if (!current) throw new KaidanError(ErrorCode.NOT_FOUND, "记录不存在");
    if (this.applied.has(opts.idempotencyKey)) return current;
    this.throwIfFailing();
    const next = { ...current, ...patch } as RomRecord;
    this.records.set(ref.id, next);
    this.applied.add(opts.idempotencyKey);
    this.writes++;
    return structuredClone(next);
  }

  async create(actor: Actor, type: RomObjectType, data: Record<string, unknown>, opts: WriteOptions): Promise<RomRecord> {
    this.throwIfFailing();
    const id = `${type}_new_${++this.seq}`;
    const rec = { id, ownerId: actor.userId, createdAt: T0, updatedAt: T0, type, ...data } as RomRecord;
    this.records.set(id, rec);
    this.applied.add(opts.idempotencyKey);
    this.writes++;
    return structuredClone(rec);
  }

  async inspectSchema(): Promise<SchemaInfo> {
    return { source: "mock", tables: [] };
  }

  private throwIfFailing(): void {
    const e = this.failNextWrite;
    if (e) {
      this.failNextWrite = null;
      throw e;
    }
  }
}
