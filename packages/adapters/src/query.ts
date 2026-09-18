// 与具体数据源无关的查询引擎：可见性规则 V1 + filters / text / sort / cursor / limit。
// Mock 与多维表格适配器共用（多维表格先整表拉取、转成 ROM，再走同一套内存查询）。
import {
  Account,
  Activity,
  Contact,
  ErrorCode,
  KaidanError,
  Opportunity,
  Task,
  WRITABLE_FIELDS,
  type Actor,
  type Filter,
  type RomObjectType,
  type RomPage,
  type RomQuery,
  type RomRecord,
} from "@kaidan/contracts";
import type { z } from "zod";

/** 拒绝访问时的固定文案：不带任何记录内容 */
export const DENIED_MESSAGE = "无权限访问该记录";

export function denied(): KaidanError {
  return new KaidanError(ErrorCode.PERMISSION_DENIED, DENIED_MESSAGE);
}

export const ROM_SCHEMAS: Readonly<Record<RomObjectType, z.ZodType<RomRecord>>> = {
  account: Account as z.ZodType<RomRecord>,
  contact: Contact as z.ZodType<RomRecord>,
  opportunity: Opportunity as z.ZodType<RomRecord>,
  activity: Activity as z.ZodType<RomRecord>,
  task: Task as z.ZodType<RomRecord>,
};

export const DEFAULT_LIMIT = 20;

/** 按 ownerId 判断：admin 全部；manager 自己 + teamIds；rep 只有自己 */
export function ownerVisible(actor: Actor, ownerId: string): boolean {
  if (actor.roles.includes("admin")) return true;
  if (ownerId === actor.userId) return true;
  if (actor.roles.includes("manager") && (actor.teamIds ?? []).includes(ownerId)) return true;
  return false;
}

/** 查找被引用的客户 / 商机（用于 contact / activity / task 的额外可见性规则） */
export interface RefLookup {
  account(id: string): RomRecord | undefined;
  opportunity(id: string): RomRecord | undefined;
}

/**
 * 可见性规则 V1：
 *  - account / opportunity：只看 ownerId
 *  - contact / activity / task：ownerId 可见，或其 accountId / opportunityId 指向的记录可见
 */
export function isVisible(actor: Actor, rec: RomRecord, refs: RefLookup): boolean {
  if (ownerVisible(actor, rec.ownerId)) return true;
  if (rec.type === "account" || rec.type === "opportunity") return false;
  const accountId = "accountId" in rec ? rec.accountId : undefined;
  const opportunityId = "opportunityId" in rec ? rec.opportunityId : undefined;
  if (accountId) {
    const acc = refs.account(accountId);
    if (acc && ownerVisible(actor, acc.ownerId)) return true;
  }
  if (opportunityId) {
    const opp = refs.opportunity(opportunityId);
    if (opp && ownerVisible(actor, opp.ownerId)) return true;
  }
  return false;
}

// ---------------------------------------------------------------- filters

function fieldValue(rec: RomRecord, field: string): unknown {
  let cur: unknown = rec;
  for (const part of field.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v).length === 0;
  return false;
}

/** 数字按数值、字符串按字典序（日期字符串因此可直接比较）；类型不一致 → 不可比 */
function compare(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return null;
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a)) return a.some((x) => sameValue(x, b));
  return a === b;
}

export function matchFilter(rec: RomRecord, f: Filter): boolean {
  const v = fieldValue(rec, f.field);
  switch (f.op) {
    case "eq":
      return sameValue(v, f.value);
    case "neq":
      return !sameValue(v, f.value);
    case "lt":
    case "lte":
    case "gt":
    case "gte": {
      if (v === undefined || v === null) return false;
      const c = compare(v, f.value);
      if (c === null) return false;
      return f.op === "lt" ? c < 0 : f.op === "lte" ? c <= 0 : f.op === "gt" ? c > 0 : c >= 0;
    }
    case "in": {
      if (!Array.isArray(f.value)) throw new KaidanError(ErrorCode.VALIDATION, `过滤条件 ${f.field} in 的 value 必须是数组`);
      const list = f.value as unknown[];
      return list.some((x) => sameValue(v, x));
    }
    case "contains": {
      if (typeof v === "string") return typeof f.value === "string" && v.includes(f.value);
      if (Array.isArray(v)) return v.includes(f.value);
      return false;
    }
    case "is_empty":
      return isEmpty(v);
    case "not_empty":
      return !isEmpty(v);
  }
}

const TEXT_FIELDS = ["name", "subject", "title", "summary"] as const;

export function matchText(rec: RomRecord, text: string): boolean {
  const needle = text.trim();
  if (!needle) return true;
  return TEXT_FIELDS.some((k) => {
    const v = (rec as Record<string, unknown>)[k];
    return typeof v === "string" && v.includes(needle);
  });
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) throw new KaidanError(ErrorCode.VALIDATION, `cursor 不合法：${cursor}`);
  return Number(cursor);
}

/** records 须已按类型与可见性过滤 */
export function applyQuery(records: RomRecord[], q: RomQuery): RomPage {
  let rows = records.filter((r) => r.type === q.type);
  for (const f of q.filters ?? []) rows = rows.filter((r) => matchFilter(r, f));
  if (q.text) rows = rows.filter((r) => matchText(r, q.text!));

  const sortField = q.sort?.field ?? "id";
  const dir = q.sort?.dir === "desc" ? -1 : 1;
  rows = [...rows].sort((a, b) => {
    const va = fieldValue(a, sortField);
    const vb = fieldValue(b, sortField);
    // 缺值永远排在最后
    const ea = va === undefined || va === null;
    const eb = vb === undefined || vb === null;
    if (ea !== eb) return ea ? 1 : -1;
    const c = ea ? 0 : (compare(va, vb) ?? 0);
    if (c !== 0) return c * dir;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const offset = parseCursor(q.cursor);
  const limit = q.limit ?? DEFAULT_LIMIT;
  const items = rows.slice(offset, offset + limit);
  const next = offset + limit;
  return next < rows.length ? { items, nextCursor: String(next) } : { items };
}

// ---------------------------------------------------------------- 写入校验

/** 只允许 WRITABLE_FIELDS[type] 中的字段 */
export function assertWritable(type: RomObjectType, data: Record<string, unknown>): void {
  const allowed = WRITABLE_FIELDS[type];
  const bad = Object.keys(data).filter((k) => !allowed.includes(k));
  if (bad.length > 0) {
    throw new KaidanError(ErrorCode.VALIDATION, `${type} 不允许写入字段：${bad.join(", ")}`);
  }
}

/** 合并 patch：值为 null 视为清空该字段；改 stage 时由调用方同步 rawStage */
export function mergePatch<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

/** create 时补齐的缺省值（工具层做预校验时也用同一份） */
export function withCreateDefaults(type: RomObjectType, data: Record<string, unknown>): Record<string, unknown> {
  if (type === "task" && data["status"] === undefined) return { ...data, status: "open" };
  return data;
}

export function validateRecord(type: RomObjectType, candidate: unknown): RomRecord {
  const r = ROM_SCHEMAS[type].safeParse(candidate);
  if (!r.success) {
    const where = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new KaidanError(ErrorCode.VALIDATION, `${type} 记录不合法：${where}`);
  }
  return r.data;
}
