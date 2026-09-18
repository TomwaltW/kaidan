// 多维表格记录 ⇄ ROM 的双向转换（spec 附录 C）。
import {
  ContactRole,
  DEFAULT_STAGE_LABELS,
  ErrorCode,
  KaidanError,
  OPEN_STAGES,
  type BitableMapping,
  type OpportunityStage,
  type RomObjectType,
  type RomRecord,
} from "@kaidan/contracts";
import { ROM_SCHEMAS } from "../query.js";
import { dateToMs, toDateInZone, toIsoInZone } from "../time.js";
import type { BitableRecord } from "./api.js";

export type ObjectMappingT = BitableMapping["objects"]["account"];

/** 特殊键：原始手机号字段，只输出脱敏值 phoneMasked，不支持写入 */
export const PHONE_KEY = "phone";

type FieldKind = "person" | "link" | "links" | "datetime" | "date" | "number" | "text";

const FIELD_KINDS: Record<string, FieldKind> = {
  ownerId: "person",
  accountId: "link",
  opportunityId: "link",
  contactIds: "links",
  occurredAt: "datetime",
  lastActivityAt: "datetime",
  expectedCloseDate: "date",
  dueDate: "date",
  amount: "number",
  probability: "number",
};

function kindOf(romField: string): FieldKind {
  return FIELD_KINDS[romField] ?? "text";
}

// ---------------------------------------------------------------- 单个值：读

function asText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    const parts = v
      .map((x) => (typeof x === "string" ? x : x && typeof x === "object" && "text" in x ? String((x as { text: unknown }).text ?? "") : ""))
      .filter((s) => s !== "");
    return parts.length > 0 ? parts.join(typeof v[0] === "string" ? "," : "") : undefined;
  }
  if (typeof v === "object" && "text" in v) return String((v as { text: unknown }).text ?? "");
  return undefined;
}

function asPerson(v: unknown): string | undefined {
  if (typeof v === "string") return v || undefined;
  if (Array.isArray(v)) {
    const first = v[0] as { id?: unknown } | string | undefined;
    if (typeof first === "string") return first || undefined;
    if (first && typeof first.id === "string") return first.id || undefined;
  }
  return undefined;
}

/** 关联字段：兼容 ["rec1"]、{link_record_ids:["rec1"]}、[{record_ids:["rec1"]}] 几种返回形态 */
function asLinks(v: unknown): string[] {
  if (typeof v === "string") return v ? [v] : [];
  if (Array.isArray(v)) {
    return v.flatMap((x) => {
      if (typeof x === "string") return [x];
      if (x && typeof x === "object") {
        const o = x as { record_ids?: unknown; id?: unknown };
        if (Array.isArray(o.record_ids)) return o.record_ids.filter((s): s is string => typeof s === "string");
        if (typeof o.id === "string") return [o.id];
      }
      return [];
    });
  }
  if (v && typeof v === "object" && Array.isArray((v as { link_record_ids?: unknown }).link_record_ids)) {
    return ((v as { link_record_ids: unknown[] }).link_record_ids).filter((s): s is string => typeof s === "string");
  }
  return [];
}

function asMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function readValue(romField: string, v: unknown, tz: string): unknown {
  switch (kindOf(romField)) {
    case "person":
      return asPerson(v);
    case "link":
      return asLinks(v)[0];
    case "links": {
      const ids = asLinks(v);
      return ids.length > 0 ? ids : undefined;
    }
    case "datetime": {
      const ms = asMs(v);
      if (ms !== undefined) return toIsoInZone(ms, tz);
      return typeof v === "string" && v ? v : undefined;
    }
    case "date": {
      const ms = asMs(v);
      if (ms !== undefined) return toDateInZone(ms, tz);
      return typeof v === "string" && v ? v.slice(0, 10) : undefined;
    }
    case "number":
      return asNumber(v);
    case "text":
      return asText(v);
  }
}

// ---------------------------------------------------------------- 枚举映射

const ACTIVITY_KIND: Record<string, string> = {
  电话: "call",
  拜访: "visit",
  会议: "meeting",
  微信: "message",
  消息: "message",
  邮件: "email",
  其他: "note",
};
const ACTIVITY_KIND_BACK: Record<string, string> = {
  call: "电话",
  visit: "拜访",
  meeting: "会议",
  message: "微信",
  email: "邮件",
  note: "其他",
};
const TASK_STATUS: Record<string, string> = { 未开始: "open", 进行中: "open", 已完成: "done", 已取消: "canceled" };
const TASK_STATUS_BACK: Record<string, string> = { open: "进行中", done: "已完成", canceled: "已取消" };
const CONTACT_ROLE: Record<string, string> = {
  决策人: "decision_maker",
  拥护者: "champion",
  影响者: "influencer",
  使用者: "user",
  采购: "procurement",
};

function mapActivityKind(text: string | undefined): string {
  if (!text) return "note";
  if (ACTIVITY_KIND_BACK[text]) return text; // 已是 ROM 值
  return ACTIVITY_KIND[text] ?? "note";
}

function mapTaskStatus(text: string | undefined): string {
  if (!text) return "open";
  if (TASK_STATUS_BACK[text]) return text;
  return TASK_STATUS[text] ?? "open";
}

function mapContactRole(text: string | undefined): string | undefined {
  if (!text) return undefined;
  if ((ContactRole.options as readonly string[]).includes(text)) return text;
  return CONTACT_ROLE[text] ?? "unknown";
}

function stageMapOf(m: ObjectMappingT): Record<string, OpportunityStage> {
  if (m.stageMap) return m.stageMap;
  // 未配置 stageMap 时按默认中文阶段名映射
  return Object.fromEntries(OPEN_STAGES.concat(["won", "lost"]).map((s) => [DEFAULT_STAGE_LABELS[s], s]));
}

/** 手机号脱敏：保留前 3 位与后 4 位，中间 4 个 * */
export function maskPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  const local = digits.length > 11 && digits.startsWith("86") ? digits.slice(digits.length - 11) : digits;
  if (local.length < 7) return "****";
  return `${local.slice(0, 3)}****${local.slice(-4)}`;
}

// ---------------------------------------------------------------- 记录：读

export type FromResult = { ok: true; record: RomRecord } | { ok: false; warning: string };

export function fromBitable(type: RomObjectType, rec: BitableRecord, m: ObjectMappingT, tz: string): FromResult {
  const out: Record<string, unknown> = { type, id: rec.record_id };
  const raw: Record<string, unknown> = { ...rec.fields };
  const qualification: Record<string, string> = {};

  for (const [romField, bitField] of Object.entries(m.fields)) {
    const v = rec.fields[bitField];
    if (romField === PHONE_KEY) {
      delete raw[bitField]; // 完整号码永远不进入 ROM（包括 raw）
      const text = asText(v);
      if (type === "contact" && text) out["phoneMasked"] = maskPhone(text);
      continue;
    }
    if (romField.startsWith("qualification.")) {
      const text = asText(v);
      if (text) qualification[romField.slice("qualification.".length)] = text;
      continue;
    }
    if (type === "opportunity" && romField === "stage") {
      const text = asText(v);
      const stage = text ? stageMapOf(m)[text] : undefined;
      if (!stage) return { ok: false, warning: `商机 ${rec.record_id} 的阶段「${text ?? ""}」不在 stageMap 中，已跳过` };
      out["stage"] = stage;
      out["rawStage"] = text;
      continue;
    }
    if (type === "activity" && romField === "kind") {
      out["kind"] = mapActivityKind(asText(v));
      continue;
    }
    if (type === "task" && romField === "status") {
      out["status"] = mapTaskStatus(asText(v));
      continue;
    }
    if (type === "contact" && romField === "role") {
      const role = mapContactRole(asText(v));
      if (role) out["role"] = role;
      continue;
    }
    const value = readValue(romField, v, tz);
    if (value !== undefined) out[romField] = value;
  }
  if (Object.keys(qualification).length > 0) out["qualification"] = qualification;
  if (type === "activity" && out["kind"] === undefined) out["kind"] = "note";
  if (type === "task" && out["status"] === undefined) out["status"] = "open";
  if (type === "account" && !["A", "B", "C"].includes(String(out["tier"]))) delete out["tier"];
  if (type === "activity") out["source"] = "crm"; // 来源由适配器决定：多维表格里的跟进记录统一记为 crm

  const created = rec.created_time ?? rec.last_modified_time ?? 0;
  out["createdAt"] = toIsoInZone(created, tz);
  out["updatedAt"] = toIsoInZone(rec.last_modified_time ?? created, tz);
  out["raw"] = raw;

  const parsed = ROM_SCHEMAS[type].safeParse(out);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    return { ok: false, warning: `${type} ${rec.record_id} 无法转换为 ROM，已跳过：${where}` };
  }
  return { ok: true, record: parsed.data };
}

// ---------------------------------------------------------------- 记录：写

function writeValue(romField: string, v: unknown, tz: string): unknown {
  switch (kindOf(romField)) {
    case "person":
      return [{ id: String(v) }];
    case "link":
      return [String(v)];
    case "links":
      return Array.isArray(v) ? v.map(String) : [String(v)];
    case "datetime":
      return Date.parse(String(v));
    case "date":
      return dateToMs(String(v), tz);
    case "number":
      return typeof v === "number" ? v : Number(v);
    case "text":
      return String(v);
  }
}

function unmapped(type: RomObjectType, field: string): KaidanError {
  return new KaidanError(ErrorCode.VALIDATION, `${type}.${field} 未在 mapping.yaml 中映射，无法写入`);
}

/** ROM patch / data → 多维表格 fields。值为 null 表示清空 */
export function toBitable(
  type: RomObjectType,
  patch: Record<string, unknown>,
  m: ObjectMappingT,
  tz: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [romField, value] of Object.entries(patch)) {
    if (romField === PHONE_KEY || romField === "phoneMasked") {
      throw new KaidanError(ErrorCode.VALIDATION, "手机号不支持写入");
    }
    if (romField === "qualification") {
      for (const [k, v] of Object.entries((value ?? {}) as Record<string, unknown>)) {
        const bit = m.fields[`qualification.${k}`];
        if (!bit) throw unmapped(type, `qualification.${k}`);
        out[bit] = v === null || v === undefined ? null : String(v);
      }
      continue;
    }
    const bit = m.fields[romField];
    if (!bit) throw unmapped(type, romField);
    if (value === null || value === undefined) {
      out[bit] = null;
      continue;
    }
    if (type === "opportunity" && romField === "stage") {
      const entries = Object.entries(stageMapOf(m)).filter(([, s]) => s === value);
      if (entries.length === 0) throw new KaidanError(ErrorCode.VALIDATION, `阶段 ${String(value)} 在 stageMap 中没有对应选项`);
      const preferred = entries.find(([label]) => label === DEFAULT_STAGE_LABELS[value as OpportunityStage]);
      out[bit] = (preferred ?? entries[0]!)[0];
      continue;
    }
    if (type === "activity" && romField === "kind") {
      out[bit] = ACTIVITY_KIND_BACK[String(value)] ?? "其他";
      continue;
    }
    if (type === "task" && romField === "status") {
      out[bit] = TASK_STATUS_BACK[String(value)] ?? "进行中";
      continue;
    }
    out[bit] = writeValue(romField, value, tz);
  }
  return out;
}

/** 商机阶段 → 该租户的原始阶段名（写入后回填 rawStage 用） */
export function rawStageOf(m: ObjectMappingT, stage: OpportunityStage): string | undefined {
  const entries = Object.entries(stageMapOf(m)).filter(([, s]) => s === stage);
  return (entries.find(([label]) => label === DEFAULT_STAGE_LABELS[stage]) ?? entries[0])?.[0];
}
