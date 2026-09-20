// doctor --online 的多维表格侧只读预检：凭证 → appToken → 表 → 字段 → 抽样读 → 汇总。
//
// 三条铁规矩（改这个文件时先读一遍）：
//   1. 只读。这里只允许调用 BitableApi 的 listTables / listFields / listRecords；
//      一旦写进 createRecord / updateRecord，precheck.test.ts 的「只读断言」会立刻变红。
//   2. 不打印字段值。字段名、表名、选项名（这些是表结构）可以进输出；记录正文、手机号、联系人姓名一律不进。
//   3. 不抛异常。预期内的失败（没凭证、读不到表、字段对不上）都收进 CheckLine，由 CLI 决定退出码。
import {
  ErrorCode,
  KaidanError,
  type BitableMapping,
  type RomObjectType,
} from "@kaidan/contracts";
import { describeBitableError, type BitableApi, type BitableField, type BitablePage } from "./api.js";
import { fromBitable, kindOf, stageMapOf, PHONE_KEY, type FieldKind, type ObjectMappingT } from "./convert.js";

/** ok=通过；warn=能跑但有隐患（不影响退出码）；fail=必须修；skip=前一项没过，这项没得查 */
export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckLine {
  /** 1..6，与派单里的检查顺序一一对应 */
  no: number;
  title: string;
  status: CheckStatus;
  detail: string;
  /** 一句可执行的修法；status 为 ok/skip 时没有 */
  fixes?: string[];
}

export interface PrecheckReport {
  /** 没有 fail 才算过；warn 不影响 */
  ok: boolean;
  lines: CheckLine[];
}

/** 换取 tenant_access_token；真实实现走飞书 SDK，测试注入 fake。只回有效期，绝不回 token 本身 */
export type TenantTokenProbe = () => Promise<{ expireSeconds?: number }>;

export interface BitablePrecheckOptions {
  mapping: BitableMapping;
  api: BitableApi;
  timezone: string;
  appToken: string;
  /** 配置里写的环境变量名（feishu.appIdEnv / appSecretEnv），用来报「缺哪个」 */
  credentials: { appIdEnv: string; appSecretEnv: string };
  probeTenantToken: TenantTokenProbe;
  /** 缺省 process.env；测试注入 */
  env?: Record<string, string | undefined>;
}

const OBJECT_LABELS: Record<RomObjectType, string> = {
  account: "客户",
  opportunity: "商机",
  contact: "联系人",
  activity: "跟进记录",
  task: "待办",
};

/** ROM 字段类别 → 可接受的多维表格 ui_type（空数组 = 不校验类型） */
const UI_TYPES_BY_KIND: Record<FieldKind, string[]> = {
  person: ["User", "CreatedUser", "ModifiedUser"],
  link: ["SingleLink", "DuplexLink"],
  links: ["SingleLink", "DuplexLink"],
  datetime: ["DateTime", "CreatedTime", "ModifiedTime"],
  date: ["DateTime", "CreatedTime", "ModifiedTime"],
  number: [],
  text: [],
};

const KIND_LABELS: Record<FieldKind, string> = {
  person: "人员",
  link: "关联",
  links: "关联",
  datetime: "日期",
  date: "日期",
  number: "数字",
  text: "文本",
};

/** ui_type 是这些时不判类型：公式的实际返回类型取决于引用源，离线判不了。
 *  SDK 1.74.0 的 ui_type 联合类型里只有 Formula（没有 Lookup），Lookup 留作向前兼容 */
const OPAQUE_UI_TYPES = new Set(["Formula", "Lookup"]);

type CheckNo = 1 | 2 | 3 | 4 | 5 | 6;

const TITLES = {
  1: "凭证",
  2: "appToken 可达",
  3: "表齐不齐",
  4: "字段齐不齐",
  5: "抽样读",
  6: "汇总",
} as const satisfies Record<CheckNo, string>;

type ObjectEntry = { type: RomObjectType; m: ObjectMappingT };

function objectEntries(mapping: BitableMapping): ObjectEntry[] {
  return (Object.entries(mapping.objects) as [RomObjectType, ObjectMappingT | undefined][])
    .filter((e): e is [RomObjectType, ObjectMappingT] => e[1] !== undefined)
    .map(([type, m]) => ({ type, m }));
}

function label(type: RomObjectType, m: ObjectMappingT): string {
  return `${m.tableId}（${OBJECT_LABELS[type]}）`;
}

function describe(e: unknown): string {
  if (e instanceof KaidanError) return e.message;
  return describeBitableError(e);
}

async function pageAll<T>(fetch: (token?: string) => Promise<BitablePage<T>>): Promise<T[]> {
  const out: T[] = [];
  let token: string | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await fetch(token);
    out.push(...page.items);
    if (!page.hasMore || !page.pageToken) break;
    token = page.pageToken;
  }
  return out;
}

/**
 * 跑一轮只读预检。永远返回 6 行结果：前一项失败时后面的行是 skip，而不是不打印
 * —— 少一行比写着「已跳过」更容易被看漏。
 */
export async function runBitablePrecheck(opts: BitablePrecheckOptions): Promise<PrecheckReport> {
  const { mapping, api, timezone, appToken, credentials } = opts;
  const env = opts.env ?? process.env;
  const lines: CheckLine[] = [];
  const entries = objectEntries(mapping);
  const skipRest = (from: CheckNo, why: string): PrecheckReport => {
    for (const no of [2, 3, 4, 5] as const) {
      if (no >= from) lines.push({ no, title: TITLES[no], status: "skip", detail: why });
    }
    return summarize(lines);
  };

  // 1. 凭证
  const missing = [credentials.appIdEnv, credentials.appSecretEnv].filter((name) => !env[name]);
  if (missing.length > 0) {
    lines.push({
      no: 1,
      title: TITLES[1],
      status: "fail",
      detail: `环境变量 ${missing.join("、")} 未设置`,
      fixes: missing.map((name) => `在运行环境里设置 ${name}（配置里的 feishu.${name === credentials.appIdEnv ? "appIdEnv" : "appSecretEnv"} 指向它），再重跑 doctor --online`),
    });
    return skipRest(2, "依赖第 1 项（凭证），已跳过");
  }
  try {
    const { expireSeconds } = await opts.probeTenantToken();
    lines.push({
      no: 1,
      title: TITLES[1],
      status: "ok",
      detail: `${credentials.appIdEnv} / ${credentials.appSecretEnv} 已设置；tenant_access_token 换取成功${expireSeconds ? `（有效期 ${expireSeconds} 秒）` : ""}`,
    });
  } catch (e) {
    lines.push({
      no: 1,
      title: TITLES[1],
      status: "fail",
      detail: `换取 tenant_access_token 失败：${describe(e)}`,
      fixes: [`核对 ${credentials.appIdEnv} / ${credentials.appSecretEnv} 是否属于同一个自建应用，并确认应用已在开发者后台发布`],
    });
    return skipRest(2, "依赖第 1 项（凭证），已跳过");
  }

  // 2. appToken 可达
  let tables: { table_id: string; name: string }[];
  try {
    tables = await pageAll((t) => api.listTables(t));
  } catch (e) {
    lines.push({
      no: 2,
      title: TITLES[2],
      status: "fail",
      detail: `读取 appToken ${appToken} 的数据表列表失败：${describe(e)}`,
      fixes: [
        `把应用加为这张多维表格的协作者（在多维表格右上角「…→ 更多 → 添加文档应用」里加），并确认 adapter.bitable.appToken 是表格 URL 里 /base/ 后面那一段`,
      ],
    });
    return skipRest(3, "依赖第 2 项（appToken 可达），已跳过");
  }
  lines.push({
    no: 2,
    title: TITLES[2],
    status: "ok",
    detail: `appToken ${appToken} 可读，共 ${tables.length} 张数据表`,
  });

  // 3. 表齐不齐
  const byId = new Map(tables.map((t) => [t.table_id, t.name]));
  const present = entries.filter((e) => byId.has(e.m.tableId));
  const absent = entries.filter((e) => !byId.has(e.m.tableId));
  if (absent.length > 0) {
    lines.push({
      no: 3,
      title: TITLES[3],
      status: "fail",
      detail: `mapping.yaml 里 ${entries.length} 张表，有 ${absent.length} 张在这个多维表格里找不到：${absent.map((e) => label(e.type, e.m)).join("、")}`,
      fixes: absent.map(
        (e) => `找不到表 ${label(e.type, e.m)}：请核对表格 URL 里 table= 后面的 tableId，或改 mapping.yaml 的 objects.${e.type}.tableId`,
      ),
    });
  } else {
    lines.push({
      no: 3,
      title: TITLES[3],
      status: "ok",
      detail: `mapping.yaml 里 ${entries.length} 张表全部存在：${entries.map((e) => label(e.type, e.m)).join("、")}`,
    });
  }

  // 4. 字段齐不齐（只查存在的表）
  lines.push(await checkFields(api, present));

  // 5. 抽样读（只读 1 条，只打印条数与字段名）
  lines.push(await sampleRead(api, present, timezone));

  return summarize(lines);
}

async function checkFields(api: BitableApi, entries: ObjectEntry[]): Promise<CheckLine> {
  if (entries.length === 0) {
    return { no: 4, title: TITLES[4], status: "skip", detail: "没有可检查的表（见第 3 项）" };
  }
  const fixes: string[] = [];
  const notes: string[] = [];
  let checked = 0;
  let warned = false;

  for (const { type, m } of entries) {
    let fields: BitableField[];
    try {
      fields = await pageAll((t) => api.listFields(m.tableId, t));
    } catch (e) {
      fixes.push(`表 ${label(type, m)}的字段列表读不到：${describe(e)}；请确认应用对这张表有阅读权限`);
      continue;
    }
    const byName = new Map(fields.map((f) => [f.field_name, f]));

    for (const [romField, bitField] of Object.entries(m.fields)) {
      checked++;
      const f = byName.get(bitField);
      if (!f) {
        fixes.push(
          `表 ${label(type, m)}找不到字段「${bitField}」：请在多维表格里核对字段名，或改 mapping.yaml 的 objects.${type}.fields.${romField}`,
        );
        continue;
      }
      // 阶段是单选，其余按 ROM 字段类别判；手机号单独放行 Phone
      const expected =
        type === "opportunity" && romField === "stage"
          ? { uiTypes: ["SingleSelect"], what: "单选" }
          : romField === PHONE_KEY
            ? { uiTypes: ["Phone", "Text"], what: "手机号（电话或文本）" }
            : { uiTypes: UI_TYPES_BY_KIND[kindOf(romField)], what: KIND_LABELS[kindOf(romField)] };
      if (expected.uiTypes.length === 0) continue;
      if (f.ui_type === undefined) {
        notes.push(`表 ${label(type, m)}的字段「${bitField}」没有返回 ui_type，类型未校验`);
        warned = true;
        continue;
      }
      if (OPAQUE_UI_TYPES.has(f.ui_type)) {
        notes.push(`表 ${label(type, m)}的字段「${bitField}」是 ${f.ui_type}，实际类型取决于引用源，类型未校验`);
        warned = true;
        continue;
      }
      if (!expected.uiTypes.includes(f.ui_type)) {
        fixes.push(
          `表 ${label(type, m)}的字段「${bitField}」是 ${f.ui_type}，期望${expected.what}字段（${expected.uiTypes.join(" / ")}）：请在多维表格里把它改成对应类型，或把 mapping.yaml 的 objects.${type}.fields.${romField} 指向正确的字段`,
        );
      }
    }

    // 阶段选项 ⇄ stageMap：缺的会让整条商机记录被跳过，是真机上最容易踩的一个坑
    if (type === "opportunity") {
      const stageField = m.fields["stage"];
      const f = stageField ? byName.get(stageField) : undefined;
      const options = (f?.property?.options ?? []).map((o) => o.name).filter((n): n is string => !!n);
      if (f && options.length > 0) {
        const map = stageMapOf(m);
        const missingOptions = Object.keys(map).filter((name) => !options.includes(name));
        const unmapped = options.filter((name) => !(name in map));
        for (const name of missingOptions) {
          fixes.push(
            `商机表的阶段字段「${stageField}」里没有选项「${name}」：请核对阶段字段的选项名，或改 mapping.yaml 的 objects.opportunity.stageMap`,
          );
        }
        if (unmapped.length > 0) {
          notes.push(
            `阶段字段「${stageField}」的选项${unmapped.map((n) => `「${n}」`).join("、")}没写进 stageMap，这些商机会被整条跳过：建议补进 mapping.yaml 的 objects.opportunity.stageMap`,
          );
          warned = true;
        }
      }
    }
  }

  const summary = `共检查 ${entries.length} 张表的 ${checked} 个字段`;
  if (fixes.length > 0) {
    return { no: 4, title: TITLES[4], status: "fail", detail: `${summary}，${fixes.length} 处对不上`, fixes: [...fixes, ...notes] };
  }
  if (warned) return { no: 4, title: TITLES[4], status: "warn", detail: `${summary}，字段名全部命中`, fixes: notes };
  return { no: 4, title: TITLES[4], status: "ok", detail: `${summary}，字段名与类型全部命中` };
}

async function sampleRead(api: BitableApi, entries: ObjectEntry[], timezone: string): Promise<CheckLine> {
  if (entries.length === 0) {
    return { no: 5, title: TITLES[5], status: "skip", detail: "没有可检查的表（见第 3 项）" };
  }
  const parts: string[] = [];
  const fixes: string[] = [];
  for (const { type, m } of entries) {
    let page: BitablePage<{ record_id: string; fields: Record<string, unknown> }>;
    try {
      page = await api.listRecords(m.tableId, undefined, 1);
    } catch (e) {
      fixes.push(`表 ${label(type, m)}读记录失败：${describe(e)}；请确认应用对这张表有阅读权限`);
      continue;
    }
    const row = page.items[0];
    if (!row) {
      parts.push(`${label(type, m)} 0 条（空表，未验证解析）`);
      continue;
    }
    // 只列字段名，绝不列值
    const names = Object.keys(row.fields);
    const r = fromBitable(type, row, m, timezone);
    if (r.ok) {
      parts.push(`${label(type, m)} 1 条，字段：${names.join("、")}`);
    } else {
      // 警告里只有 record_id、字段路径与校验原因，没有记录正文
      fixes.push(`表 ${label(type, m)}的第 1 条记录解析失败：${r.warning}；请按上面第 4 项的提示核对字段名与类型`);
    }
  }
  if (fixes.length > 0) {
    return { no: 5, title: TITLES[5], status: "fail", detail: `${fixes.length} 张表抽样读不通过`, fixes };
  }
  return { no: 5, title: TITLES[5], status: "ok", detail: parts.join("；") };
}

function summarize(lines: CheckLine[]): PrecheckReport {
  const failed = lines.filter((l) => l.status === "fail");
  const warned = lines.filter((l) => l.status === "warn");
  const ok = failed.length === 0;
  const detail = ok
    ? warned.length > 0
      ? `检查全部通过，有 ${warned.length} 项提醒（不影响使用）`
      : "检查全部通过"
    : `${failed.length} 项没过：${failed.map((l) => `第 ${l.no} 项（${l.title}）`).join("、")}；请按上面的修法逐条处理后重跑`;
  lines.push({ no: 6, title: TITLES[6], status: ok ? "ok" : "fail", detail });
  return { ok, lines };
}

/** 凭据缺失时抛 CONFIG（与 createAdapter 的行为一致），便于上层区分「配错了」和「上游挂了」 */
export function missingEnvError(name: string, which: "appIdEnv" | "appSecretEnv"): KaidanError {
  return new KaidanError(ErrorCode.CONFIG, `环境变量 ${name} 未设置（feishu.${which}）`);
}
