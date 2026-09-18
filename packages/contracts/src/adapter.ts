// @kaidan/contracts — adapter.ts（冻结）
import { z } from "zod";
import { Actor, RomObjectType, RomRecord, RomRef, type RomDataset } from "./rom.js";

export const FilterOp = z.enum(["eq", "neq", "lt", "lte", "gt", "gte", "in", "contains", "is_empty", "not_empty"]);
export const Filter = z.object({ field: z.string().min(1), op: FilterOp, value: z.unknown().optional() });
export type Filter = z.infer<typeof Filter>;

export const RomQuery = z.object({
  type: RomObjectType,
  filters: z.array(Filter).max(10).optional(),
  /** 在 name / subject / title / summary 上做包含匹配 */
  text: z.string().max(100).optional(),
  sort: z.object({ field: z.string().min(1), dir: z.enum(["asc", "desc"]) }).optional(),
  limit: z.number().int().min(1).max(100).optional(), // 缺省 20
  cursor: z.string().optional(),
});
export type RomQuery = z.infer<typeof RomQuery>;

export interface RomPage {
  items: RomRecord[];
  nextCursor?: string;
}

export interface WriteOptions {
  /** = proposalId；同一 key 重复写入必须幂等（不产生第二次写） */
  idempotencyKey: string;
  proposalId: string;
}

export const SchemaInfo = z.object({
  source: z.enum(["mock", "bitable"]),
  tables: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      fields: z.array(z.object({ name: z.string(), kind: z.string(), options: z.array(z.string()).optional() })),
    }),
  ),
});
export type SchemaInfo = z.infer<typeof SchemaInfo>;

/**
 * 可见性规则 V1（在"适配器自行鉴权"的模式下必须实现：mock、bitable tenant 模式）
 *  - admin：全部可见
 *  - manager：ownerId ∈ {自己} ∪ teamIds
 *  - rep：ownerId = 自己
 *  - contact / activity / task 额外规则：若其 accountId 或 opportunityId 指向的记录可见，则它也可见
 * 不可见记录：search 结果中剔除；get/update 抛 KaidanError(PERMISSION_DENIED)
 * 写入：只能改可见记录；create 的 ownerId 强制为 actor.userId
 */
export interface RomAdapter {
  readonly kind: "mock" | "bitable";
  search(actor: Actor, q: RomQuery): Promise<RomPage>;
  /** 不存在 → 返回 null；存在但不可见 → 抛 PERMISSION_DENIED */
  get(actor: Actor, ref: RomRef): Promise<RomRecord | null>;
  create(actor: Actor, type: RomObjectType, data: Record<string, unknown>, opts: WriteOptions): Promise<RomRecord>;
  update(actor: Actor, ref: RomRef, patch: Record<string, unknown>, opts: WriteOptions): Promise<RomRecord>;
  /** 仅 admin；否则 PERMISSION_DENIED */
  inspectSchema(actor: Actor): Promise<SchemaInfo>;
}

export interface MockRomAdapter extends RomAdapter {
  readonly kind: "mock";
  /** writes = 实际发生的写入次数（幂等命中不计） */
  stats(): { writes: number; appliedKeys: string[] };
  snapshot(): RomDataset;
}

/** 多维表格字段映射（每个租户一份 mapping.yaml） */
export const ObjectMapping = z.object({
  tableId: z.string().min(1),
  /** ROM 字段名 → 多维表格字段名，如 { name: "客户名称", ownerId: "负责人" } */
  fields: z.record(z.string(), z.string()),
  /** 仅 opportunity：多维表格阶段选项 → ROM 阶段 */
  stageMap: z.record(z.string(), z.enum(["lead", "qualified", "solution", "negotiation", "won", "lost"])).optional(),
});
export const BitableMapping = z.object({
  version: z.literal(1),
  objects: z.object({
    account: ObjectMapping,
    opportunity: ObjectMapping,
    contact: ObjectMapping.optional(),
    activity: ObjectMapping.optional(),
    task: ObjectMapping.optional(),
  }),
});
export type BitableMapping = z.infer<typeof BitableMapping>;
