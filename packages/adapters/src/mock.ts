// Mock 适配器：内存中的 RomDataset，实现可见性规则 V1、查询、写入校验与幂等（spec 3.2 行为约定第 2 条）。
import {
  Account,
  Activity,
  Contact,
  DEFAULT_STAGE_LABELS,
  ErrorCode,
  KaidanError,
  Opportunity,
  Task,
  type Actor,
  type CreateMockAdapter,
  type MockRomAdapter,
  type OpportunityStage,
  type RomDataset,
  type RomObjectType,
  type RomPage,
  type RomQuery,
  type RomRecord,
  type RomRef,
  type SchemaInfo,
  type WriteOptions,
} from "@kaidan/contracts";
import type { z } from "zod";
import {
  applyQuery,
  assertWritable,
  denied,
  isVisible,
  mergePatch,
  validateRecord,
  withCreateDefaults,
  type RefLookup,
} from "./query.js";

const COLLECTION = {
  account: "accounts",
  contact: "contacts",
  opportunity: "opportunities",
  activity: "activities",
  task: "tasks",
} as const satisfies Record<RomObjectType, keyof RomDataset>;

function nowIso(): string {
  // spec：写入时 updatedAt 取真实当前时间（测试不对其断言）
  return new Date().toISOString();
}

export const createMockAdapter: CreateMockAdapter = (dataset) => {
  const data: RomDataset = structuredClone(dataset);
  const applied = new Map<string, RomRef>(); // idempotencyKey → 写入的记录
  let writes = 0;
  let seq = 0;

  const list = (type: RomObjectType): RomRecord[] => data[COLLECTION[type]] as RomRecord[];
  const find = (type: RomObjectType, id: string): RomRecord | undefined => list(type).find((r) => r.id === id);
  const refs: RefLookup = {
    account: (id) => find("account", id),
    opportunity: (id) => find("opportunity", id),
  };

  function replace(rec: RomRecord): void {
    const arr = list(rec.type);
    const i = arr.findIndex((r) => r.id === rec.id);
    if (i >= 0) arr[i] = rec;
    else arr.push(rec);
  }

  /** 被引用的客户 / 商机 / 联系人必须存在且对 actor 可见 */
  function assertRefs(actor: Actor, rec: Record<string, unknown>): void {
    const check = (type: RomObjectType, id: unknown) => {
      if (typeof id !== "string") return;
      const target = find(type, id);
      if (!target) throw new KaidanError(ErrorCode.VALIDATION, `引用的 ${type} 不存在：${id}`);
      if (!isVisible(actor, target, refs)) throw denied();
    };
    check("account", rec["accountId"]);
    check("opportunity", rec["opportunityId"]);
    const contactIds = rec["contactIds"];
    if (Array.isArray(contactIds)) for (const c of contactIds) check("contact", c);
  }

  function getVisible(actor: Actor, ref: RomRef): RomRecord | null {
    const rec = find(ref.type, ref.id);
    if (!rec) return null;
    if (!isVisible(actor, rec, refs)) throw denied();
    return rec;
  }

  const adapter: MockRomAdapter = {
    kind: "mock",

    async search(actor: Actor, q: RomQuery): Promise<RomPage> {
      const visible = list(q.type).filter((r) => isVisible(actor, r, refs));
      return structuredClone(applyQuery(visible, q));
    },

    async get(actor, ref) {
      const rec = getVisible(actor, ref);
      return rec ? structuredClone(rec) : null;
    },

    async create(actor, type, input, opts: WriteOptions) {
      const done = applied.get(opts.idempotencyKey);
      if (done) {
        const rec = find(done.type, done.id);
        if (rec) return structuredClone(rec);
      }
      assertWritable(type, input);
      const fields = withCreateDefaults(type, input);
      assertRefs(actor, fields);
      const now = nowIso();
      const candidate: Record<string, unknown> = {
        ...fields,
        id: `${type}_new_${++seq}`,
        type,
        ownerId: actor.userId, // create 的 ownerId 强制为 actor
        createdAt: now,
        updatedAt: now,
      };
      if (type === "opportunity" && typeof fields["stage"] === "string") {
        candidate["rawStage"] = DEFAULT_STAGE_LABELS[fields["stage"] as OpportunityStage] ?? fields["stage"];
      }
      const rec = validateRecord(type, candidate);
      replace(rec);
      applied.set(opts.idempotencyKey, { type, id: rec.id });
      writes++;
      return structuredClone(rec);
    },

    async update(actor, ref, patch, opts: WriteOptions) {
      const done = applied.get(opts.idempotencyKey);
      if (done) {
        const rec = find(done.type, done.id);
        if (rec) return structuredClone(rec);
      }
      const current = getVisible(actor, ref);
      if (!current) throw new KaidanError(ErrorCode.NOT_FOUND, `记录不存在：${ref.type}/${ref.id}`);
      assertWritable(ref.type, patch);
      assertRefs(actor, patch);
      const merged: Record<string, unknown> = mergePatch(current as Record<string, unknown>, patch);
      if (ref.type === "opportunity" && typeof patch["stage"] === "string") {
        merged["rawStage"] = DEFAULT_STAGE_LABELS[patch["stage"] as OpportunityStage] ?? patch["stage"];
      }
      merged["updatedAt"] = nowIso();
      const rec = validateRecord(ref.type, merged);
      replace(rec);
      applied.set(opts.idempotencyKey, { type: rec.type, id: rec.id });
      writes++;
      return structuredClone(rec);
    },

    async inspectSchema(actor) {
      if (!actor.roles.includes("admin")) throw new KaidanError(ErrorCode.PERMISSION_DENIED, "仅管理员可查看表结构");
      return mockSchema();
    },

    stats() {
      return { writes, appliedKeys: [...applied.keys()] };
    },

    snapshot() {
      return structuredClone(data);
    },
  };
  return adapter;
};

// ---------------------------------------------------------------- schema_inspect（mock）

interface ZodLike {
  def: { type: string; innerType?: ZodLike };
  options?: readonly unknown[];
}

function describeField(s: ZodLike): { kind: string; options?: string[] } {
  let cur = s;
  while ((cur.def.type === "optional" || cur.def.type === "nullable" || cur.def.type === "default") && cur.def.innerType) {
    cur = cur.def.innerType;
  }
  if (cur.def.type === "enum" && cur.options) return { kind: "enum", options: cur.options.map(String) };
  return { kind: cur.def.type };
}

function tableOf(id: RomObjectType, name: string, schema: z.ZodObject): SchemaInfo["tables"][number] {
  const fields = Object.entries(schema.shape)
    .filter(([k]) => k !== "raw")
    .map(([fieldName, s]) => ({ name: fieldName, ...describeField(s as unknown as ZodLike) }));
  return { id, name, fields };
}

function mockSchema(): SchemaInfo {
  return {
    source: "mock",
    tables: [
      tableOf("account", "客户", Account),
      tableOf("contact", "联系人", Contact),
      tableOf("opportunity", "商机", Opportunity),
      tableOf("activity", "跟进记录", Activity),
      tableOf("task", "待办", Task),
    ],
  };
}
