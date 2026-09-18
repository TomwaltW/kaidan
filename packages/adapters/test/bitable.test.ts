// 多维表格适配器：用 fake BitableApi（内存表），不联网。
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { KaidanError, type BitableMapping } from "@kaidan/contracts";
import {
  BitableApiError,
  createBitableAdapter,
  loadBitableMapping,
  maskPhone,
  type BitableApi,
  type BitableField,
  type BitablePage,
  type BitableRecord,
} from "../src/index.js";
import { ADMIN, LI, W, WANG, ZHANG } from "./helpers.js";

const EXAMPLE_MAPPING = fileURLToPath(new URL("../../../config/mapping.example.yaml", import.meta.url));
const ms = (iso: string) => Date.parse(iso);
const person = (id: string) => [{ id, name: "某人" }];

class FakeBitable implements BitableApi {
  tables = new Map<string, BitableRecord[]>();
  names = new Map<string, string>();
  fields = new Map<string, BitableField[]>();
  calls: { op: string; tableId: string; recordId?: string; fields?: Record<string, unknown> }[] = [];
  /** 接下来 n 次调用抛出的错误 */
  failures: Error[] = [];
  pageSize = 2;
  seq = 0;

  private maybeFail(): void {
    const e = this.failures.shift();
    if (e) throw e;
  }
  private page<T>(items: T[], token?: string): BitablePage<T> {
    const start = token ? Number(token) : 0;
    const slice = items.slice(start, start + this.pageSize);
    const next = start + this.pageSize;
    return next < items.length ? { items: slice, hasMore: true, pageToken: String(next) } : { items: slice, hasMore: false };
  }
  async listRecords(tableId: string, pageToken?: string) {
    this.maybeFail();
    this.calls.push({ op: "list", tableId });
    return this.page(structuredClone(this.tables.get(tableId) ?? []), pageToken);
  }
  async createRecord(tableId: string, fields: Record<string, unknown>) {
    this.maybeFail();
    this.calls.push({ op: "create", tableId, fields });
    const rec: BitableRecord = { record_id: `rec_new_${++this.seq}`, fields, created_time: ms("2026-09-21T09:00:00+08:00") };
    this.tables.set(tableId, [...(this.tables.get(tableId) ?? []), rec]);
    return structuredClone(rec);
  }
  async updateRecord(tableId: string, recordId: string, fields: Record<string, unknown>) {
    this.maybeFail();
    this.calls.push({ op: "update", tableId, recordId, fields });
    const rows = this.tables.get(tableId) ?? [];
    const rec = rows.find((r) => r.record_id === recordId);
    if (!rec) throw new BitableApiError("RecordIdNotFound", 1254043);
    rec.fields = { ...rec.fields, ...fields };
    rec.last_modified_time = ms("2026-09-21T09:30:00+08:00");
    return structuredClone(rec);
  }
  async listTables(pageToken?: string) {
    this.maybeFail();
    return this.page([...this.names].map(([table_id, name]) => ({ table_id, name })), pageToken);
  }
  async listFields(tableId: string, pageToken?: string) {
    this.maybeFail();
    return this.page(this.fields.get(tableId) ?? [], pageToken);
  }
  writes(): number {
    return this.calls.filter((c) => c.op !== "list").length;
  }
}

let mapping: BitableMapping;
let api: FakeBitable;
let warnings: string[];
let sleeps: number[];

function adapter() {
  return createBitableAdapter({
    mapping,
    api,
    timezone: "Asia/Shanghai",
    warn: (m) => warnings.push(m),
    sleep: async (d) => {
      sleeps.push(d);
    },
  });
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(KaidanError);
    return (e as KaidanError).code;
  }
}

beforeEach(async () => {
  mapping = await loadBitableMapping(EXAMPLE_MAPPING);
  mapping.objects.opportunity.fields["qualification.pain"] = "痛点";
  api = new FakeBitable();
  warnings = [];
  sleeps = [];
  const t = mapping.objects;
  api.tables.set(t.account.tableId, [
    {
      record_id: "rec_acc1",
      fields: { 客户名称: "华东精密机械（虚构）", 行业: "制造业", 客户等级: "A", 负责人: person("ou_rep_zhang") },
      created_time: ms("2026-06-01T10:00:00+08:00"),
      last_modified_time: ms("2026-09-01T10:00:00+08:00"),
    },
    {
      record_id: "rec_acc2",
      fields: { 客户名称: [{ text: "南海外贸", type: "text" }, { text: "集团（虚构）", type: "text" }], 客户等级: "S", 负责人: person("ou_rep_li") },
      created_time: ms("2026-04-03T10:00:00+08:00"),
    },
  ]);
  api.tables.set(t.opportunity.tableId, [
    {
      record_id: "rec_opp1",
      fields: {
        商机名称: "华东精密-二期产线",
        所属客户: { link_record_ids: ["rec_acc1"] },
        阶段: "方案报价",
        预计金额: 480000,
        预计成交日期: ms("2026-09-30T00:00:00+08:00"),
        最近跟进时间: ms("2026-09-01T10:00:00+08:00"),
        负责人: person("ou_rep_zhang"),
        痛点: "交期",
      },
      created_time: ms("2026-06-05T10:00:00+08:00"),
      last_modified_time: ms("2026-09-01T10:00:00+08:00"),
    },
    {
      record_id: "rec_opp2",
      fields: { 商机名称: "南海外贸-CRM集成", 所属客户: ["rec_acc2"], 阶段: "需求确认", 预计金额: "260000", 负责人: person("ou_rep_li") },
      created_time: ms("2026-04-10T10:00:00+08:00"),
    },
    {
      record_id: "rec_opp_bad",
      fields: { 商机名称: "阶段未知", 阶段: "神秘阶段", 负责人: person("ou_rep_zhang") },
      created_time: ms("2026-04-10T10:00:00+08:00"),
    },
  ]);
  api.tables.set(t.contact!.tableId, [
    {
      record_id: "rec_con1",
      fields: { 姓名: "陈工", 所属客户: ["rec_acc1"], 职位: "采购经理", 手机: "+86 138-0000-0001", 负责人: person("ou_rep_li") },
      created_time: ms("2026-06-01T10:00:00+08:00"),
    },
  ]);
  api.tables.set(t.activity!.tableId, [
    {
      record_id: "rec_act1",
      fields: { 主题: "电话沟通", 跟进方式: "电话", 跟进时间: ms("2026-08-20T10:00:00+08:00"), 商机: [{ record_ids: ["rec_opp2"] }], 跟进人: person("ou_rep_li") },
      created_time: ms("2026-08-20T10:00:00+08:00"),
    },
    {
      record_id: "rec_act2",
      fields: { 主题: "上门拜访", 跟进方式: "拜访", 跟进时间: ms("2026-09-01T10:00:00+08:00"), 客户: ["rec_acc1"], 跟进人: person("ou_rep_zhang") },
      created_time: ms("2026-09-01T10:00:00+08:00"),
    },
    {
      record_id: "rec_act3",
      fields: { 主题: "微信跟进", 跟进方式: "微信", 跟进时间: ms("2026-09-02T10:00:00+08:00"), 跟进人: person("ou_rep_zhang") },
      created_time: ms("2026-09-02T10:00:00+08:00"),
    },
    {
      record_id: "rec_act4",
      fields: { 主题: "其他", 跟进方式: "飞鸽传书", 跟进时间: ms("2026-09-03T10:00:00+08:00"), 跟进人: person("ou_rep_zhang") },
      created_time: ms("2026-09-03T10:00:00+08:00"),
    },
  ]);
  api.tables.set(t.task!.tableId, [
    {
      record_id: "rec_task1",
      fields: { 待办事项: "发报价", 截止日期: ms("2026-09-24T00:00:00+08:00"), 状态: "已完成", 商机: ["rec_opp1"], 负责人: person("ou_rep_zhang") },
      created_time: ms("2026-09-19T16:00:00+08:00"),
    },
    {
      record_id: "rec_task2",
      fields: { 待办事项: "约时间", 状态: "未开始", 负责人: person("ou_rep_zhang") },
      created_time: ms("2026-09-19T16:00:00+08:00"),
    },
  ]);
});

describe("多维表格记录 → ROM", () => {
  it("人员 / 关联 / 日期 / 数字 / 阶段映射 / 资格字段 / raw", async () => {
    const opp = await adapter().get(ADMIN, { type: "opportunity", id: "rec_opp1" });
    expect(opp).toMatchObject({
      type: "opportunity",
      id: "rec_opp1",
      ownerId: "ou_rep_zhang",
      accountId: "rec_acc1",
      name: "华东精密-二期产线",
      stage: "solution",
      rawStage: "方案报价",
      amount: 480000,
      expectedCloseDate: "2026-09-30",
      lastActivityAt: "2026-09-01T10:00:00+08:00",
      qualification: { pain: "交期" },
      createdAt: "2026-06-05T10:00:00+08:00",
      updatedAt: "2026-09-01T10:00:00+08:00",
    });
    expect(opp?.raw?.["阶段"]).toBe("方案报价");
    const opp2 = await adapter().get(ADMIN, { type: "opportunity", id: "rec_opp2" });
    expect(opp2).toMatchObject({ accountId: "rec_acc2", amount: 260000, stage: "qualified" });
  });

  it("单选 / 富文本 / 非法等级被丢弃；未映射的阶段 → 跳过记录并告警", async () => {
    const accs = await adapter().search(ADMIN, { type: "account" });
    expect(accs.items.map((a) => [a.id, (a as { name: string }).name, (a as { tier?: string }).tier])).toEqual([
      ["rec_acc1", "华东精密机械（虚构）", "A"],
      ["rec_acc2", "南海外贸集团（虚构）", undefined],
    ]);
    const opps = await adapter().search(ADMIN, { type: "opportunity" });
    expect(opps.items.map((o) => o.id)).toEqual(["rec_opp1", "rec_opp2"]);
    expect(warnings.some((w) => w.includes("rec_opp_bad") && w.includes("神秘阶段"))).toBe(true);
  });

  it("手机号：只输出脱敏值 phoneMasked，raw 里也没有完整号码", async () => {
    const con = await adapter().get(ADMIN, { type: "contact", id: "rec_con1" });
    expect((con as { phoneMasked?: string }).phoneMasked).toBe("138****0001");
    expect(JSON.stringify(con)).not.toMatch(/13800000001|138-0000-0001/);
    expect(maskPhone("13912345678")).toBe("139****5678");
    expect(maskPhone("123")).toBe("****");
  });

  it("活动方式与任务状态映射", async () => {
    const acts = await adapter().search(ADMIN, { type: "activity" });
    expect(acts.items.map((a) => [a.id, (a as { kind: string }).kind])).toEqual([
      ["rec_act1", "call"],
      ["rec_act2", "visit"],
      ["rec_act3", "message"],
      ["rec_act4", "note"],
    ]);
    expect(acts.items[0]).toMatchObject({ opportunityId: "rec_opp2", occurredAt: "2026-08-20T10:00:00+08:00", source: "crm" });
    const tasks = await adapter().search(ADMIN, { type: "task" });
    expect(tasks.items.map((t) => [t.id, (t as { status: string }).status, (t as { dueDate?: string }).dueDate])).toEqual([
      ["rec_task1", "done", "2026-09-24"],
      ["rec_task2", "open", undefined],
    ]);
  });

  it("分页拉取全表（fake 每页 2 条）", async () => {
    await adapter().search(ADMIN, { type: "activity" });
    expect(api.calls.filter((c) => c.op === "list" && c.tableId === mapping.objects.activity!.tableId)).toHaveLength(2);
  });
});

describe("多维表格：可见性规则 V1（tenant 模式）", () => {
  it("rep 只看自己的；联系人经可见客户可见；活动挂在他人商机上不可见", async () => {
    const a = adapter();
    expect((await a.search(ZHANG, { type: "opportunity" })).items.map((r) => r.id)).toEqual(["rec_opp1"]);
    expect((await a.search(ZHANG, { type: "contact" })).items.map((r) => r.id)).toEqual(["rec_con1"]);
    expect((await a.search(ZHANG, { type: "activity" })).items.map((r) => r.id)).toEqual(["rec_act2", "rec_act3", "rec_act4"]);
    expect((await a.search(LI, { type: "activity" })).items.map((r) => r.id)).toEqual(["rec_act1"]);
    expect(await codeOf(a.get(ZHANG, { type: "opportunity", id: "rec_opp2" }))).toBe("PERMISSION_DENIED");
    expect((await a.search(WANG, { type: "opportunity" })).items).toHaveLength(2);
    expect(await a.get(ZHANG, { type: "opportunity", id: "rec_nope" })).toBeNull();
  });

  it("未映射的对象类型：search 返回空，写入 → VALIDATION", async () => {
    delete mapping.objects.task;
    const a = adapter();
    expect((await a.search(ADMIN, { type: "task" })).items).toEqual([]);
    expect(await codeOf(a.create(ZHANG, "task", { title: "x" }, W("k")))).toBe("VALIDATION");
  });
});

describe("ROM → 多维表格（写入）", () => {
  it("update：阶段反向映射、日期转毫秒、文本；返回值回读为 ROM；幂等不重复写", async () => {
    const a = adapter();
    const rec = await a.update(
      ZHANG,
      { type: "opportunity", id: "rec_opp1" },
      { stage: "negotiation", nextStep: "发报价", expectedCloseDate: "2026-10-15" },
      W("p1"),
    );
    const call = api.calls.find((c) => c.op === "update")!;
    expect(call.recordId).toBe("rec_opp1");
    expect(call.fields).toEqual({ 阶段: "商务谈判", 下一步: "发报价", 预计成交日期: ms("2026-10-15T00:00:00+08:00") });
    expect(rec).toMatchObject({ stage: "negotiation", rawStage: "商务谈判", nextStep: "发报价", expectedCloseDate: "2026-10-15" });
    await a.update(ZHANG, { type: "opportunity", id: "rec_opp1" }, { nextStep: "再来一次" }, W("p1"));
    expect(api.writes()).toBe(1);
  });

  it("create：人员 / 关联字段按飞书格式写，ownerId 强制为 actor，task.status 缺省写「进行中」", async () => {
    const a = adapter();
    const rec = await a.create(ZHANG, "task", { title: "发送报价单", dueDate: "2026-09-24", opportunityId: "rec_opp1" }, W("c1"));
    const call = api.calls.find((c) => c.op === "create")!;
    expect(call.tableId).toBe(mapping.objects.task!.tableId);
    expect(call.fields).toEqual({
      待办事项: "发送报价单",
      截止日期: ms("2026-09-24T00:00:00+08:00"),
      商机: ["rec_opp1"],
      状态: "进行中",
      负责人: [{ id: "ou_rep_zhang" }],
    });
    expect(rec).toMatchObject({ id: "rec_new_1", type: "task", ownerId: "ou_rep_zhang", status: "open", dueDate: "2026-09-24" });
    await a.create(ZHANG, "task", { title: "发送报价单" }, W("c1"));
    expect(api.writes()).toBe(1);
  });

  it("写入校验：不可见 / 引用不可见 → PERMISSION_DENIED；未映射字段 / 非法值 / 手机号 → VALIDATION；都不发请求", async () => {
    const a = adapter();
    expect(await codeOf(a.update(ZHANG, { type: "opportunity", id: "rec_opp2" }, { nextStep: "x" }, W("a")))).toBe(
      "PERMISSION_DENIED",
    );
    expect(await codeOf(a.create(ZHANG, "task", { title: "x", opportunityId: "rec_opp2" }, W("b")))).toBe("PERMISSION_DENIED");
    expect(
      await codeOf(a.update(ZHANG, { type: "opportunity", id: "rec_opp1" }, { qualification: { budget: "10万" } }, W("c"))),
    ).toBe("VALIDATION");
    expect(await codeOf(a.update(ZHANG, { type: "opportunity", id: "rec_opp1" }, { probability: 101 }, W("d")))).toBe(
      "VALIDATION",
    );
    expect(await codeOf(a.update(ADMIN, { type: "contact", id: "rec_con1" }, { phone: "13800000001" }, W("e")))).toBe(
      "VALIDATION",
    );
    expect(await codeOf(a.update(ZHANG, { type: "opportunity", id: "rec_nope" }, { nextStep: "x" }, W("f")))).toBe("NOT_FOUND");
    expect(api.writes()).toBe(0);
  });
});

describe("频控重试与上游错误", () => {
  it("429 / 频控码：按 0.5s / 1s / 2s 退避重试，成功即返回", async () => {
    api.failures = [new BitableApiError("too many", undefined, 429), new BitableApiError("limit", 99991400)];
    const page = await adapter().search(ADMIN, { type: "opportunity" });
    expect(page.items).toHaveLength(2);
    expect(sleeps).toEqual([500, 1000]);
  });

  it("重试 3 次仍频控 → RATE_LIMITED（retryable）", async () => {
    api.failures = Array.from({ length: 4 }, () => new BitableApiError("too many", undefined, 429));
    try {
      await adapter().search(ADMIN, { type: "account" });
      expect.fail("应抛出");
    } catch (e) {
      expect((e as KaidanError).code).toBe("RATE_LIMITED");
      expect((e as KaidanError).retryable).toBe(true);
    }
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it("其他上游错误 → UPSTREAM，不重试", async () => {
    api.failures = [new BitableApiError("forbidden", 91403, 403)];
    expect(await codeOf(adapter().search(ADMIN, { type: "account" }))).toBe("UPSTREAM");
    expect(sleeps).toEqual([]);
  });
});

describe("inspectSchema", () => {
  it("admin：列出数据表与字段（含单选选项），source=bitable；非 admin → PERMISSION_DENIED", async () => {
    api.names.set("tblA", "客户");
    api.names.set("tblB", "商机");
    api.fields.set("tblA", [{ field_name: "客户名称", ui_type: "Text" }]);
    api.fields.set("tblB", [
      { field_name: "阶段", ui_type: "SingleSelect", property: { options: [{ name: "方案报价" }, { name: "赢单" }] } },
      { field_name: "金额", type: 2 },
      { field_name: "负责人", ui_type: "User" },
    ]);
    const s = await adapter().inspectSchema(ADMIN);
    expect(s).toEqual({
      source: "bitable",
      tables: [
        { id: "tblA", name: "客户", fields: [{ name: "客户名称", kind: "Text" }] },
        {
          id: "tblB",
          name: "商机",
          fields: [
            { name: "阶段", kind: "SingleSelect", options: ["方案报价", "赢单"] },
            { name: "金额", kind: "type_2" },
            { name: "负责人", kind: "User" },
          ],
        },
      ],
    });
    expect(await codeOf(adapter().inspectSchema(ZHANG))).toBe("PERMISSION_DENIED");
  });
});
