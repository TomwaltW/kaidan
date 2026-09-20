// doctor --online 的只读预检：全程用 fake BitableApi（内存表），不联网。
// 这个文件里最重要的一条是「只读断言」：跑完整轮预检后写调用必须为 0。
// 反向可验证 —— 往 runBitablePrecheck 里加任何一次 createRecord/updateRecord，那条用例立刻变红。
import { beforeEach, describe, expect, it } from "vitest";
import type { BitableMapping } from "@kaidan/contracts";
import {
  BitableApiError,
  runBitablePrecheck,
  type BitableApi,
  type BitableField,
  type BitablePage,
  type BitableRecord,
  type PrecheckReport,
} from "../src/index.js";

const ACCOUNT = "tblAccount";
const OPP = "tblOpportunity";
const CONTACT = "tblContact";

const MAPPING: BitableMapping = {
  version: 1,
  objects: {
    account: { tableId: ACCOUNT, fields: { name: "客户名称", ownerId: "负责人" } },
    opportunity: {
      tableId: OPP,
      fields: { name: "商机名称", accountId: "所属客户", stage: "阶段", expectedCloseDate: "预计成交日期", ownerId: "负责人" },
      stageMap: { 方案报价: "solution", 赢单: "won" },
    },
    contact: { tableId: CONTACT, fields: { name: "姓名", accountId: "所属客户", phone: "手机", ownerId: "负责人" } },
  },
};

/** 记录每一次调用；listTables / listFields 也记，否则「只读」无从反证 */
class FakeBitable implements BitableApi {
  calls: { op: string; tableId?: string; pageSize?: number }[] = [];
  tables = new Map<string, string>();
  fields = new Map<string, BitableField[]>();
  records = new Map<string, BitableRecord[]>();
  /** 下一次对应操作抛出的错误 */
  failures = new Map<string, Error>();

  private maybeFail(op: string): void {
    const e = this.failures.get(op);
    if (e) throw e;
  }
  async listTables(): Promise<BitablePage<{ table_id: string; name: string }>> {
    this.calls.push({ op: "listTables" });
    this.maybeFail("listTables");
    return { items: [...this.tables].map(([table_id, name]) => ({ table_id, name })), hasMore: false };
  }
  async listFields(tableId: string): Promise<BitablePage<BitableField>> {
    this.calls.push({ op: "listFields", tableId });
    this.maybeFail("listFields");
    return { items: this.fields.get(tableId) ?? [], hasMore: false };
  }
  async listRecords(tableId: string, _pageToken?: string, pageSize?: number): Promise<BitablePage<BitableRecord>> {
    const call: { op: string; tableId: string; pageSize?: number } = { op: "listRecords", tableId };
    if (pageSize !== undefined) call.pageSize = pageSize;
    this.calls.push(call);
    this.maybeFail("listRecords");
    const rows = this.records.get(tableId) ?? [];
    return { items: structuredClone(rows.slice(0, pageSize ?? rows.length)), hasMore: false };
  }
  async createRecord(tableId: string): Promise<BitableRecord> {
    this.calls.push({ op: "createRecord", tableId });
    throw new Error("预检不允许写入");
  }
  async updateRecord(tableId: string): Promise<BitableRecord> {
    this.calls.push({ op: "updateRecord", tableId });
    throw new Error("预检不允许写入");
  }
  /** 写调用次数：只数真正的写操作，不靠「不是 list 就算写」 */
  writes(): number {
    return this.calls.filter((c) => c.op === "createRecord" || c.op === "updateRecord").length;
  }
}

const person = (name: string): BitableField => ({ field_name: name, ui_type: "User" });
const text = (name: string): BitableField => ({ field_name: name, ui_type: "Text" });
const link = (name: string): BitableField => ({ field_name: name, ui_type: "SingleLink" });
const date = (name: string): BitableField => ({ field_name: name, ui_type: "DateTime" });
const phone = (name: string): BitableField => ({ field_name: name, ui_type: "Phone" });
const select = (name: string, options: string[]): BitableField => ({
  field_name: name,
  ui_type: "SingleSelect",
  property: { options: options.map((n) => ({ name: n })) },
});

let api: FakeBitable;
let probeCalls: number;
let env: Record<string, string | undefined>;

/** 一张健康的表：字段齐、类型对、每张表有 1 条能解析的记录 */
function seedHealthy(): void {
  api.tables.set(ACCOUNT, "客户");
  api.tables.set(OPP, "商机");
  api.tables.set(CONTACT, "联系人");
  api.fields.set(ACCOUNT, [text("客户名称"), person("负责人")]);
  api.fields.set(OPP, [
    text("商机名称"),
    link("所属客户"),
    select("阶段", ["方案报价", "赢单"]),
    date("预计成交日期"),
    person("负责人"),
  ]);
  api.fields.set(CONTACT, [text("姓名"), link("所属客户"), phone("手机"), person("负责人")]);
  api.records.set(ACCOUNT, [
    { record_id: "rec_a1", fields: { 客户名称: "长风科技（虚构）", 负责人: [{ id: "ou_rep_zhang" }] }, created_time: 1758412800000 },
  ]);
  api.records.set(OPP, [
    {
      record_id: "rec_o1",
      fields: {
        商机名称: "长风科技二期（虚构）",
        所属客户: ["rec_a1"],
        阶段: "方案报价",
        预计成交日期: 1759536000000,
        负责人: [{ id: "ou_rep_zhang" }],
      },
      created_time: 1758412800000,
    },
  ]);
  api.records.set(CONTACT, [
    {
      record_id: "rec_c1",
      fields: { 姓名: "周敏", 所属客户: ["rec_a1"], 手机: "13800138000", 负责人: [{ id: "ou_rep_zhang" }] },
      created_time: 1758412800000,
    },
  ]);
}

function run(overrides: { probe?: () => Promise<{ expireSeconds?: number }>; mapping?: BitableMapping } = {}): Promise<PrecheckReport> {
  return runBitablePrecheck({
    mapping: overrides.mapping ?? MAPPING,
    api,
    timezone: "Asia/Shanghai",
    appToken: "bascnDemo",
    credentials: { appIdEnv: "FEISHU_APP_ID", appSecretEnv: "FEISHU_APP_SECRET" },
    probeTenantToken:
      overrides.probe ??
      (async () => {
        probeCalls++;
        return { expireSeconds: 7200 };
      }),
    env,
  });
}

/** 把整份报告拍平成一段文本，方便断言「某句话出现过」「某个值没出现过」 */
function render(r: PrecheckReport): string {
  return r.lines.map((l) => `${l.status} ${l.no}. ${l.title}：${l.detail}\n${(l.fixes ?? []).join("\n")}`).join("\n");
}

function line(r: PrecheckReport, no: number) {
  const l = r.lines.find((x) => x.no === no);
  if (!l) throw new Error(`报告里没有第 ${no} 项`);
  return l;
}

beforeEach(() => {
  api = new FakeBitable();
  probeCalls = 0;
  env = { FEISHU_APP_ID: "cli_demo", FEISHU_APP_SECRET: "secret_demo" };
});

describe("doctor --online：凭证", () => {
  it("环境变量缺失 → 第 1 项 fail、点名缺哪个，后面 4 项跳过，并且一个请求都没发", async () => {
    delete env["FEISHU_APP_ID"];
    const r = await run();

    expect(r.ok).toBe(false);
    expect(line(r, 1).status).toBe("fail");
    expect(line(r, 1).detail).toContain("FEISHU_APP_ID");
    expect(line(r, 1).detail).not.toContain("FEISHU_APP_SECRET");
    expect(line(r, 1).fixes?.[0]).toContain("在运行环境里设置 FEISHU_APP_ID");
    for (const no of [2, 3, 4, 5]) expect(line(r, no).status).toBe("skip");
    expect(line(r, 6).status).toBe("fail");
    // 没凭证就不该去碰网络
    expect(probeCalls).toBe(0);
    expect(api.calls).toEqual([]);
  });

  it("两个都缺 → 两个名字都报出来", async () => {
    env = {};
    const r = await run();
    expect(line(r, 1).detail).toContain("FEISHU_APP_ID");
    expect(line(r, 1).detail).toContain("FEISHU_APP_SECRET");
    expect(line(r, 1).fixes).toHaveLength(2);
  });

  it("换 token 失败 → 带上 code / log_id；频控码翻译成人话", async () => {
    const r = await run({
      probe: async () => {
        throw new BitableApiError("换取 tenant_access_token 失败：too many request（code 99991400）", 99991400, 429, "log_abc123");
      },
    });

    expect(r.ok).toBe(false);
    expect(line(r, 1).status).toBe("fail");
    expect(line(r, 1).detail).toContain("触发频控，稍后重试");
    expect(line(r, 1).detail).toContain("code 99991400");
    expect(line(r, 1).detail).toContain("log_id log_abc123");
    for (const no of [2, 3, 4, 5]) expect(line(r, no).status).toBe("skip");
  });

  it("token 有效期只报秒数，不报 token 本身", async () => {
    seedHealthy();
    const r = await run({ probe: async () => ({ expireSeconds: 7200 }) });
    expect(line(r, 1).detail).toContain("有效期 7200 秒");
    expect(render(r)).not.toContain("tenant_access_token 值");
  });
});

describe("doctor --online：appToken 与表", () => {
  it("appToken 读不到 → 第 2 项 fail，修法提示加协作者", async () => {
    api.failures.set("listTables", new BitableApiError("列出数据表 失败：Forbidden（code 91403）", 91403, 403, "log_x"));
    const r = await run();

    expect(r.ok).toBe(false);
    expect(line(r, 2).status).toBe("fail");
    expect(line(r, 2).detail).toContain("code 91403");
    expect(line(r, 2).fixes?.[0]).toContain("协作者");
    for (const no of [3, 4, 5]) expect(line(r, no).status).toBe("skip");
  });

  it("表缺失 → 报出是哪张表，并给出改 mapping 的那句话", async () => {
    seedHealthy();
    api.tables.delete(OPP);
    const r = await run();

    expect(r.ok).toBe(false);
    const l = line(r, 3);
    expect(l.status).toBe("fail");
    expect(l.detail).toContain("tblOpportunity（商机）");
    expect(l.fixes?.[0]).toContain("找不到表 tblOpportunity（商机）");
    expect(l.fixes?.[0]).toContain("mapping.yaml 的 objects.opportunity.tableId");
    // 剩下两张表照查不误
    expect(line(r, 4).status).toBe("ok");
    expect(line(r, 5).detail).not.toContain("tblOpportunity");
  });
});

describe("doctor --online：字段", () => {
  it("字段缺失 → 报出是哪张表哪个字段，并给出修法", async () => {
    seedHealthy();
    api.fields.set(ACCOUNT, [person("负责人")]); // 少了「客户名称」
    const r = await run();

    expect(r.ok).toBe(false);
    const l = line(r, 4);
    expect(l.status).toBe("fail");
    expect(l.fixes?.some((f) => f.includes("表 tblAccount（客户）找不到字段「客户名称」"))).toBe(true);
    expect(l.fixes?.some((f) => f.includes("mapping.yaml 的 objects.account.fields.name"))).toBe(true);
  });

  it("类型对不上（人员字段写成文本）→ fail，并说清期望什么类型", async () => {
    seedHealthy();
    api.fields.set(ACCOUNT, [text("客户名称"), text("负责人")]);
    const r = await run();

    expect(r.ok).toBe(false);
    const fixes = line(r, 4).fixes ?? [];
    expect(fixes.some((f) => f.includes("字段「负责人」是 Text，期望人员字段（User / CreatedUser / ModifiedUser）"))).toBe(true);
  });

  it("关联与日期字段类型对不上也能查出来", async () => {
    seedHealthy();
    api.fields.set(OPP, [
      text("商机名称"),
      text("所属客户"),
      select("阶段", ["方案报价", "赢单"]),
      text("预计成交日期"),
      person("负责人"),
    ]);
    const r = await run();
    const fixes = (line(r, 4).fixes ?? []).join("\n");
    expect(fixes).toContain("字段「所属客户」是 Text，期望关联字段");
    expect(fixes).toContain("字段「预计成交日期」是 Text，期望日期字段");
  });

  it("公式字段与缺 ui_type 的字段不判类型，只提醒（不影响退出码）", async () => {
    seedHealthy();
    api.fields.set(ACCOUNT, [text("客户名称"), { field_name: "负责人", ui_type: "Formula" }]);
    api.fields.set(CONTACT, [text("姓名"), link("所属客户"), phone("手机"), { field_name: "负责人", type: 11 }]);
    const r = await run();

    expect(r.ok).toBe(true);
    expect(line(r, 4).status).toBe("warn");
    const notes = (line(r, 4).fixes ?? []).join("\n");
    expect(notes).toContain("是 Formula，实际类型取决于引用源，类型未校验");
    expect(notes).toContain("没有返回 ui_type，类型未校验");
  });

  it("stageMap 写了表里没有的选项 → fail 并指向 stageMap", async () => {
    seedHealthy();
    api.fields.set(OPP, [
      text("商机名称"),
      link("所属客户"),
      select("阶段", ["方案报价"]), // 少了「赢单」
      date("预计成交日期"),
      person("负责人"),
    ]);
    const r = await run();

    expect(r.ok).toBe(false);
    const fixes = (line(r, 4).fixes ?? []).join("\n");
    expect(fixes).toContain("阶段字段「阶段」里没有选项「赢单」");
    expect(fixes).toContain("mapping.yaml 的 objects.opportunity.stageMap");
  });

  it("表里多出的阶段选项 → 只提醒（这些商机会被整条跳过），不改退出码", async () => {
    seedHealthy();
    api.fields.set(OPP, [
      text("商机名称"),
      link("所属客户"),
      select("阶段", ["方案报价", "赢单", "暂缓"]),
      date("预计成交日期"),
      person("负责人"),
    ]);
    const r = await run();

    expect(r.ok).toBe(true);
    expect(line(r, 4).status).toBe("warn");
    expect((line(r, 4).fixes ?? []).join("\n")).toContain("「暂缓」没写进 stageMap");
    expect(line(r, 6).status).toBe("ok");
    expect(line(r, 6).detail).toContain("1 项提醒");
  });
});

describe("doctor --online：抽样读", () => {
  it("每张表只读 1 条，只打印条数与字段名，绝不打印字段值", async () => {
    seedHealthy();
    const r = await run();

    expect(r.ok).toBe(true);
    const l = line(r, 5);
    expect(l.status).toBe("ok");
    expect(l.detail).toContain("tblAccount（客户） 1 条，字段：客户名称、负责人");
    // 只读 1 条：page_size 必须是 1，不能把整表拉下来
    for (const c of api.calls.filter((c) => c.op === "listRecords")) expect(c.pageSize).toBe(1);

    const rendered = render(r);
    for (const value of ["长风科技（虚构）", "13800138000", "138****8000", "周敏", "ou_rep_zhang", "rec_a1"]) {
      expect(rendered).not.toContain(value);
    }
  });

  it("空表 → 记 0 条，不当成失败", async () => {
    seedHealthy();
    api.records.set(ACCOUNT, []);
    const r = await run();

    expect(r.ok).toBe(true);
    expect(line(r, 5).detail).toContain("tblAccount（客户） 0 条（空表，未验证解析）");
  });

  it("记录解析不了 → fail，并指回第 4 项", async () => {
    seedHealthy();
    // 阶段值不在 stageMap 里：fromBitable 会整条跳过
    api.records.set(OPP, [{ record_id: "rec_o9", fields: { 商机名称: "某商机（虚构）", 阶段: "已搁置" }, created_time: 1758412800000 }]);
    const r = await run();

    expect(r.ok).toBe(false);
    expect(line(r, 5).status).toBe("fail");
    expect((line(r, 5).fixes ?? []).join("\n")).toContain("第 1 条记录解析失败");
    // 出错路径同样不许带出记录正文：失败提示里只该有 record_id 之外的结构信息
    expect(render(r)).not.toContain("某商机（虚构）");
  });
});

describe("doctor --online：汇总与只读", () => {
  it("全部通过 → ok=true，6 项都在，汇总说「检查全部通过」", async () => {
    seedHealthy();
    const r = await run();

    expect(r.ok).toBe(true);
    expect(r.lines.map((l) => l.no)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.lines.every((l) => l.status === "ok")).toBe(true);
    expect(line(r, 6).detail).toBe("检查全部通过");
  });

  it("只读断言：整轮预检跑完，写调用必须为 0", async () => {
    seedHealthy();
    await run();
    expect(api.writes()).toBe(0);
    expect(api.calls.map((c) => c.op).filter((op) => op !== "listTables" && op !== "listFields" && op !== "listRecords")).toEqual([]);
  });

  it("只读断言：出错路径上同样一条写调用都没有", async () => {
    seedHealthy();
    api.tables.delete(ACCOUNT);
    api.fields.set(OPP, [text("商机名称")]);
    const r = await run();

    expect(r.ok).toBe(false);
    expect(api.writes()).toBe(0);
  });
});
