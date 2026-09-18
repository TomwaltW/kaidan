// 飞书多维表格适配器（tenant 模式）：应用身份读写，按可见性规则 V1 自行过滤。
// 读：整表分页拉取 → 转 ROM → 与 Mock 共用的内存查询引擎；写：ROM patch → 多维表格 fields。
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import {
  BitableMapping,
  ErrorCode,
  KaidanError,
  type Actor,
  type OpportunityStage,
  type RomAdapter,
  type RomObjectType,
  type RomRecord,
  type RomRef,
  type SchemaInfo,
} from "@kaidan/contracts";
import {
  applyQuery,
  assertWritable,
  denied,
  isVisible,
  mergePatch,
  validateRecord,
  withCreateDefaults,
  type RefLookup,
} from "../query.js";
import { withRetry, type BitableApi, type BitablePage } from "./api.js";
import { fromBitable, rawStageOf, toBitable, type ObjectMappingT } from "./convert.js";

/** 读取并校验 mapping.yaml；文件缺失 / YAML 语法错 / 结构不合法 → CONFIG（message 含路径） */
export async function loadBitableMapping(path: string): Promise<BitableMapping> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new KaidanError(ErrorCode.CONFIG, `无法读取字段映射文件 ${path}：${(e as Error).message}`, { cause: e });
  }
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    throw new KaidanError(ErrorCode.CONFIG, `字段映射文件 ${path} 不是合法的 YAML：${(e as Error).message}`, { cause: e });
  }
  const r = BitableMapping.safeParse(doc);
  if (!r.success) {
    const where = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new KaidanError(ErrorCode.CONFIG, `字段映射文件 ${path} 无效：${where}`);
  }
  return r.data;
}

export interface BitableAdapterOptions {
  mapping: BitableMapping;
  api: BitableApi;
  timezone: string;
  /** 转换失败 / 阶段映射不到时的告警；缺省写 stderr（MCP stdio 模式下 stdout 只允许协议消息） */
  warn?: (msg: string) => void;
  /** 频控退避用的 sleep；测试注入立即返回的实现 */
  sleep?: (ms: number) => Promise<void>;
}

export function createBitableAdapter(opts: BitableAdapterOptions): RomAdapter {
  const { mapping, api, timezone } = opts;
  const warn = opts.warn ?? ((m: string) => process.stderr.write(`[bitable] ${m}\n`));
  const retry = <T>(fn: () => Promise<T>) => withRetry(fn, opts.sleep);
  /** idempotencyKey → 已写入的记录（进程内；重启后依赖提案状态机防重） */
  const applied = new Map<string, RomRef>();

  const mappingOf = (type: RomObjectType): ObjectMappingT | undefined => mapping.objects[type];
  const requireMapping = (type: RomObjectType): ObjectMappingT => {
    const m = mappingOf(type);
    if (!m) throw new KaidanError(ErrorCode.VALIDATION, `对象 ${type} 未在 mapping.yaml 中配置`);
    return m;
  };

  async function pageAll<T>(fetch: (token?: string) => Promise<BitablePage<T>>): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    for (let guard = 0; guard < 1000; guard++) {
      const page = await retry(() => fetch(token));
      out.push(...page.items);
      if (!page.hasMore || !page.pageToken) break;
      token = page.pageToken;
    }
    return out;
  }

  async function loadAll(type: RomObjectType): Promise<RomRecord[]> {
    const m = mappingOf(type);
    if (!m) return [];
    const rows = await pageAll((t) => api.listRecords(m.tableId, t));
    const out: RomRecord[] = [];
    for (const row of rows) {
      const r = fromBitable(type, row, m, timezone);
      if (r.ok) out.push(r.record);
      else warn(r.warning);
    }
    return out;
  }

  /** contact / activity / task 的可见性依赖客户与商机的负责人 */
  async function refLookup(type: RomObjectType): Promise<RefLookup> {
    if (type === "account" || type === "opportunity") return { account: () => undefined, opportunity: () => undefined };
    const [accounts, opps] = await Promise.all([loadAll("account"), loadAll("opportunity")]);
    const acc = new Map(accounts.map((r) => [r.id, r]));
    const opp = new Map(opps.map((r) => [r.id, r]));
    return { account: (id) => acc.get(id), opportunity: (id) => opp.get(id) };
  }

  async function findRecord(type: RomObjectType, id: string): Promise<RomRecord | undefined> {
    return (await loadAll(type)).find((r) => r.id === id);
  }

  async function getVisible(actor: Actor, ref: RomRef): Promise<RomRecord | null> {
    const rec = await findRecord(ref.type, ref.id);
    if (!rec) return null;
    if (!isVisible(actor, rec, await refLookup(ref.type))) throw denied();
    return rec;
  }

  async function assertRefs(actor: Actor, rec: Record<string, unknown>): Promise<void> {
    const check = async (type: RomObjectType, id: unknown) => {
      if (typeof id !== "string") return;
      const target = await findRecord(type, id);
      if (!target) throw new KaidanError(ErrorCode.VALIDATION, `引用的 ${type} 不存在：${id}`);
      if (!isVisible(actor, target, await refLookup(type))) throw denied();
    };
    await check("account", rec["accountId"]);
    await check("opportunity", rec["opportunityId"]);
    const contactIds = rec["contactIds"];
    if (Array.isArray(contactIds)) for (const c of contactIds) await check("contact", c);
  }

  function convertBack(type: RomObjectType, row: Parameters<typeof fromBitable>[1]): RomRecord {
    const r = fromBitable(type, row, requireMapping(type), timezone);
    if (!r.ok) throw new KaidanError(ErrorCode.UPSTREAM, r.warning);
    return r.record;
  }

  return {
    kind: "bitable",

    async search(actor, q) {
      const [rows, refs] = await Promise.all([loadAll(q.type), refLookup(q.type)]);
      return applyQuery(
        rows.filter((r) => isVisible(actor, r, refs)),
        q,
      );
    },

    async get(actor, ref) {
      return getVisible(actor, ref);
    },

    async create(actor, type, input, opts) {
      const done = applied.get(opts.idempotencyKey);
      if (done) {
        const rec = await findRecord(done.type, done.id);
        if (rec) return rec;
      }
      const m = requireMapping(type);
      assertWritable(type, input);
      const fields = withCreateDefaults(type, input);
      await assertRefs(actor, fields);
      // 先按 ROM schema 预校验（id / 时间用占位值），不合法 → VALIDATION，不发请求
      const placeholder = new Date().toISOString();
      const candidate: Record<string, unknown> = {
        ...fields,
        id: "pending",
        type,
        ownerId: actor.userId,
        createdAt: placeholder,
        updatedAt: placeholder,
      };
      if (type === "opportunity" && typeof fields["stage"] === "string") {
        candidate["rawStage"] = rawStageOf(m, fields["stage"] as OpportunityStage) ?? fields["stage"];
      }
      validateRecord(type, candidate);
      const bitFields = toBitable(type, { ...fields, ownerId: actor.userId }, m, timezone);
      const row = await retry(() => api.createRecord(m.tableId, bitFields));
      const rec = convertBack(type, row);
      applied.set(opts.idempotencyKey, { type, id: rec.id });
      return rec;
    },

    async update(actor, ref, patch, opts) {
      const done = applied.get(opts.idempotencyKey);
      if (done) {
        const rec = await findRecord(done.type, done.id);
        if (rec) return rec;
      }
      const m = requireMapping(ref.type);
      const current = await getVisible(actor, ref);
      if (!current) throw new KaidanError(ErrorCode.NOT_FOUND, `记录不存在：${ref.type}/${ref.id}`);
      assertWritable(ref.type, patch);
      await assertRefs(actor, patch);
      const merged: Record<string, unknown> = mergePatch(current as Record<string, unknown>, patch);
      if (ref.type === "opportunity" && typeof patch["stage"] === "string") {
        merged["rawStage"] = rawStageOf(m, patch["stage"] as OpportunityStage) ?? patch["stage"];
      }
      validateRecord(ref.type, merged);
      const bitFields = toBitable(ref.type, patch, m, timezone);
      const row = await retry(() => api.updateRecord(m.tableId, ref.id, bitFields));
      const rec = convertBack(ref.type, row);
      applied.set(opts.idempotencyKey, { type: ref.type, id: rec.id });
      return rec;
    },

    async inspectSchema(actor): Promise<SchemaInfo> {
      if (!actor.roles.includes("admin")) throw new KaidanError(ErrorCode.PERMISSION_DENIED, "仅管理员可查看表结构");
      const tables = await pageAll((t) => api.listTables(t));
      const out: SchemaInfo["tables"] = [];
      for (const t of tables) {
        const fields = await pageAll((tok) => api.listFields(t.table_id, tok));
        out.push({
          id: t.table_id,
          name: t.name,
          fields: fields.map((f) => {
            const options = (f.property?.options ?? []).map((o) => o.name).filter((n): n is string => !!n);
            return {
              name: f.field_name,
              kind: f.ui_type ?? (f.type !== undefined ? `type_${f.type}` : "unknown"),
              ...(options.length > 0 ? { options } : {}),
            };
          }),
        });
      }
      return { source: "bitable", tables: out };
    },
  };
}
