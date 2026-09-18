import { describe, expect, it } from "vitest";
import { KaidanError, type Actor, type Filter, type RomObjectType } from "@kaidan/contracts";
import { createMockAdapter } from "../src/index.js";
import { ADMIN, LI, LONELY_MGR, W, WANG, ZHANG, loadMini } from "./helpers.js";

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    expect(e).toBeInstanceOf(KaidanError);
    return (e as KaidanError).code;
  }
}

async function ids(actor: Actor, type: RomObjectType, extra: object = {}) {
  const a = createMockAdapter(loadMini());
  const page = await a.search(actor, { type, limit: 100, ...extra });
  return page.items.map((r) => r.id);
}

describe("可见性规则 V1", () => {
  const cases: [string, Actor, Record<RomObjectType, string[]>][] = [
    [
      "rep 张三",
      ZHANG,
      {
        account: ["acc_hdjm", "acc_xyrj"],
        opportunity: ["opp_1", "opp_2"],
        contact: ["con_chen"],
        activity: ["act_1", "act_3"],
        task: ["task_1"],
      },
    ],
    [
      "rep 李四",
      LI,
      { account: ["acc_nhwm"], opportunity: ["opp_3"], contact: ["con_liu"], activity: ["act_2"], task: [] },
    ],
    [
      "manager 王经理（含下属）",
      WANG,
      {
        account: ["acc_hdjm", "acc_nhwm", "acc_xyrj"],
        opportunity: ["opp_1", "opp_2", "opp_3"],
        contact: ["con_chen", "con_liu"],
        activity: ["act_1", "act_2", "act_3"],
        task: ["task_1"],
      },
    ],
    ["manager 无下属", LONELY_MGR, { account: [], opportunity: [], contact: [], activity: [], task: [] }],
    [
      "admin",
      ADMIN,
      {
        account: ["acc_hdjm", "acc_nhwm", "acc_xyrj"],
        opportunity: ["opp_1", "opp_2", "opp_3"],
        contact: ["con_chen", "con_liu"],
        activity: ["act_1", "act_2", "act_3"],
        task: ["task_1"],
      },
    ],
  ];
  for (const [label, actor, expected] of cases) {
    for (const type of Object.keys(expected) as RomObjectType[]) {
      it(`${label} × ${type}`, async () => {
        expect(await ids(actor, type)).toEqual(expected[type]);
      });
    }
  }

  it("contact / activity / task：负责人不可见，但关联的客户或商机可见 → 可见", async () => {
    const ds = loadMini();
    // 李四负责的联系人挂在张三的客户下；李四负责的活动挂在张三的商机下；李四负责的任务挂在张三的客户下
    ds.contacts.push({ ...ds.contacts[1]!, id: "con_x", accountId: "acc_hdjm" });
    ds.activities.push({ ...ds.activities[1]!, id: "act_x", accountId: undefined, opportunityId: "opp_1" });
    ds.tasks.push({ ...ds.tasks[0]!, id: "task_x", ownerId: "ou_rep_li", accountId: "acc_hdjm", opportunityId: undefined });
    const a = createMockAdapter(ds);
    expect((await a.search(ZHANG, { type: "contact" })).items.map((r) => r.id)).toEqual(["con_chen", "con_x"]);
    expect((await a.search(ZHANG, { type: "activity" })).items.map((r) => r.id)).toEqual(["act_1", "act_3", "act_x"]);
    expect((await a.search(ZHANG, { type: "task" })).items.map((r) => r.id)).toEqual(["task_1", "task_x"]);
    // account / opportunity 没有额外规则
    expect((await a.search(LI, { type: "account" })).items.map((r) => r.id)).toEqual(["acc_nhwm"]);
  });

  it("get：可见返回记录，不存在返回 null，不可见抛 PERMISSION_DENIED 且不带记录内容", async () => {
    const a = createMockAdapter(loadMini());
    expect((await a.get(ZHANG, { type: "opportunity", id: "opp_1" }))?.id).toBe("opp_1");
    expect(await a.get(ZHANG, { type: "opportunity", id: "opp_404" })).toBeNull();
    try {
      await a.get(ZHANG, { type: "opportunity", id: "opp_3" });
      expect.fail("应抛出");
    } catch (e) {
      expect((e as KaidanError).code).toBe("PERMISSION_DENIED");
      expect((e as Error).message).not.toContain("南海");
    }
    expect(await codeOf(a.get(ZHANG, { type: "activity", id: "act_2" }))).toBe("PERMISSION_DENIED");
    expect((await a.get(WANG, { type: "opportunity", id: "opp_3" }) as { name?: string } | null)?.name).toBe("南海外贸-CRM集成");
  });
});

describe("查询：filters / text / sort / cursor", () => {
  const f = (filter: Filter) => ids(ADMIN, "opportunity", { filters: [filter] });
  it("eq / neq", async () => {
    expect(await f({ field: "stage", op: "eq", value: "solution" })).toEqual(["opp_1"]);
    expect(await f({ field: "stage", op: "neq", value: "solution" })).toEqual(["opp_2", "opp_3"]);
  });
  it("lt / lte（数字）", async () => {
    expect(await f({ field: "amount", op: "lt", value: 260000 })).toEqual(["opp_2"]);
    expect(await f({ field: "amount", op: "lte", value: 260000 })).toEqual(["opp_2", "opp_3"]);
  });
  it("gt / gte（日期字符串按字典序）", async () => {
    expect(await f({ field: "expectedCloseDate", op: "gt", value: "2026-09-25" })).toEqual(["opp_1"]);
    expect(await f({ field: "expectedCloseDate", op: "gte", value: "2026-09-25" })).toEqual(["opp_1", "opp_2"]);
  });
  it("in / contains", async () => {
    expect(await f({ field: "stage", op: "in", value: ["qualified", "negotiation"] })).toEqual(["opp_2", "opp_3"]);
    expect(await f({ field: "name", op: "contains", value: "星垣" })).toEqual(["opp_2"]);
  });
  it("is_empty / not_empty（空字符串与缺失都算空）", async () => {
    expect(await f({ field: "nextStep", op: "is_empty" })).toEqual(["opp_1"]);
    expect(await f({ field: "qualification", op: "not_empty" })).toEqual(["opp_2"]);
    expect(await f({ field: "qualification", op: "is_empty" })).toEqual(["opp_1", "opp_3"]);
  });
  it("点路径字段、数组字段 contains、多个 filter 取交集", async () => {
    expect(await f({ field: "qualification.decision_maker", op: "eq", value: "CFO" })).toEqual(["opp_2"]);
    expect(await ids(ADMIN, "activity", { filters: [{ field: "contactIds", op: "contains", value: "con_chen" }] })).toEqual([
      "act_1",
    ]);
    expect(
      await ids(ADMIN, "opportunity", {
        filters: [
          { field: "ownerId", op: "eq", value: "ou_rep_zhang" },
          { field: "amount", op: "gt", value: 200000 },
        ],
      }),
    ).toEqual(["opp_1"]);
  });
  it("in 的 value 不是数组 → VALIDATION", async () => {
    const a = createMockAdapter(loadMini());
    expect(
      await codeOf(a.search(ADMIN, { type: "opportunity", filters: [{ field: "stage", op: "in", value: "lead" }] })),
    ).toBe("VALIDATION");
  });
  it("text 匹配 name / subject / title / summary", async () => {
    expect(await ids(ADMIN, "opportunity", { text: "二期产线" })).toEqual(["opp_1"]);
    expect(await ids(ADMIN, "activity", { text: "合同" })).toEqual(["act_3"]); // subject
    expect(await ids(ADMIN, "activity", { text: "交期" })).toEqual(["act_1"]); // summary
    expect(await ids(ADMIN, "task", { text: "法务" })).toEqual(["task_1"]); // title
    expect(await ids(ZHANG, "opportunity", { text: "南海" })).toEqual([]); // 不可见的不出现
  });
  it("sort：缺省 id 升序；指定字段升 / 降序；缺值排最后", async () => {
    expect(await ids(ADMIN, "opportunity")).toEqual(["opp_1", "opp_2", "opp_3"]);
    expect(await ids(ADMIN, "opportunity", { sort: { field: "amount", dir: "desc" } })).toEqual(["opp_1", "opp_3", "opp_2"]);
    expect(await ids(ADMIN, "opportunity", { sort: { field: "expectedCloseDate", dir: "asc" } })).toEqual([
      "opp_3",
      "opp_2",
      "opp_1",
    ]);
    expect(await ids(ADMIN, "opportunity", { sort: { field: "probability", dir: "asc" } })).toEqual(["opp_1", "opp_2", "opp_3"]);
  });
  it("cursor 翻页：十进制偏移量；limit 缺省 20；非法 cursor → VALIDATION", async () => {
    const a = createMockAdapter(loadMini());
    const p1 = await a.search(ADMIN, { type: "opportunity", limit: 2 });
    expect(p1.items.map((r) => r.id)).toEqual(["opp_1", "opp_2"]);
    expect(p1.nextCursor).toBe("2");
    const p2 = await a.search(ADMIN, { type: "opportunity", limit: 2, cursor: p1.nextCursor! });
    expect(p2.items.map((r) => r.id)).toEqual(["opp_3"]);
    expect(p2.nextCursor).toBeUndefined();
    expect((await a.search(ADMIN, { type: "opportunity" })).nextCursor).toBeUndefined();
    expect(await codeOf(a.search(ADMIN, { type: "opportunity", cursor: "abc" }))).toBe("VALIDATION");
  });
});

describe("写入：create / update / 幂等", () => {
  it("create：id 为 <type>_new_<序号>，ownerId 强制为 actor，task.status 缺省 open，计 1 次写", async () => {
    const a = createMockAdapter(loadMini());
    const rec = await a.create(ZHANG, "task", { title: "发送报价单", dueDate: "2026-09-24", opportunityId: "opp_1" }, W("p1"));
    expect(rec).toMatchObject({ id: "task_new_1", type: "task", ownerId: "ou_rep_zhang", status: "open" });
    const opp = await a.create(ZHANG, "opportunity", { accountId: "acc_hdjm", name: "三期", stage: "lead" }, W("p2"));
    expect(opp).toMatchObject({ id: "opportunity_new_2", rawStage: "初步接洽" });
    expect(a.stats()).toEqual({ writes: 2, appliedKeys: ["p1", "p2"] });
    expect(a.snapshot().tasks.map((t) => t.id)).toContain("task_new_1");
  });

  it("create 校验：非可写字段 / schema 不合法 / 引用不存在 → VALIDATION；引用不可见 → PERMISSION_DENIED；都不计写", async () => {
    const a = createMockAdapter(loadMini());
    expect(await codeOf(a.create(ZHANG, "task", { title: "x", ownerId: "ou_rep_li" }, W("a")))).toBe("VALIDATION");
    expect(await codeOf(a.create(ZHANG, "task", { title: "x", dueDate: "明天" }, W("b")))).toBe("VALIDATION");
    expect(await codeOf(a.create(ZHANG, "task", { title: "x", opportunityId: "opp_404" }, W("c")))).toBe("VALIDATION");
    expect(await codeOf(a.create(ZHANG, "task", { title: "x", opportunityId: "opp_3" }, W("d")))).toBe("PERMISSION_DENIED");
    expect(await codeOf(a.create(ZHANG, "contact", { accountId: "acc_hdjm", name: "x", phoneMasked: "1" }, W("e")))).toBe(
      "VALIDATION",
    );
    expect(a.stats().writes).toBe(0);
  });

  it("update：改 stage 同步 rawStage；null 清空字段；返回副本不影响内部数据", async () => {
    const a = createMockAdapter(loadMini());
    const rec = await a.update(
      ZHANG,
      { type: "opportunity", id: "opp_1" },
      { stage: "negotiation", nextStep: "发报价", expectedCloseDate: "2026-10-15" },
      W("p1"),
    );
    expect(rec).toMatchObject({ stage: "negotiation", rawStage: "商务谈判", nextStep: "发报价", expectedCloseDate: "2026-10-15" });
    (rec as { name: string }).name = "被篡改";
    expect(a.snapshot().opportunities[0]!.name).toBe("华东精密-二期产线");
    const cleared = await a.update(ZHANG, { type: "opportunity", id: "opp_2" }, { nextStep: null }, W("p2"));
    expect("nextStep" in cleared).toBe(false);
  });

  it("update 校验：不可见 → PERMISSION_DENIED；不存在 → NOT_FOUND；非可写字段 / 值越界 → VALIDATION", async () => {
    const a = createMockAdapter(loadMini());
    expect(await codeOf(a.update(ZHANG, { type: "opportunity", id: "opp_3" }, { nextStep: "x" }, W("a")))).toBe(
      "PERMISSION_DENIED",
    );
    expect(await codeOf(a.update(ZHANG, { type: "opportunity", id: "opp_9" }, { nextStep: "x" }, W("b")))).toBe("NOT_FOUND");
    expect(await codeOf(a.update(ZHANG, { type: "opportunity", id: "opp_1" }, { ownerId: "ou_rep_li" }, W("c")))).toBe(
      "VALIDATION",
    );
    expect(await codeOf(a.update(ZHANG, { type: "opportunity", id: "opp_1" }, { probability: 150 }, W("d")))).toBe("VALIDATION");
    expect(await codeOf(a.update(ZHANG, { type: "opportunity", id: "opp_1" }, { stage: "won_big" }, W("e")))).toBe("VALIDATION");
    expect(a.stats().writes).toBe(0);
    expect(a.snapshot().opportunities[0]!.stage).toBe("solution");
  });

  it("幂等：同一 idempotencyKey 第二次写直接返回当前记录，不计写", async () => {
    const a = createMockAdapter(loadMini());
    await a.update(ZHANG, { type: "opportunity", id: "opp_1" }, { nextStep: "第一次" }, W("k1"));
    const again = await a.update(ZHANG, { type: "opportunity", id: "opp_1" }, { nextStep: "第二次" }, W("k1"));
    expect((again as { nextStep?: string }).nextStep).toBe("第一次");
    const c1 = await a.create(ZHANG, "task", { title: "t" }, W("k2"));
    const c2 = await a.create(ZHANG, "task", { title: "t" }, W("k2"));
    expect(c2.id).toBe(c1.id);
    expect(a.stats()).toEqual({ writes: 2, appliedKeys: ["k1", "k2"] });
    expect(a.snapshot().tasks).toHaveLength(2);
  });

  it("管理员可以改任何记录（B5 手工改动场景）", async () => {
    const a = createMockAdapter(loadMini());
    await a.update(ADMIN, { type: "opportunity", id: "opp_2" }, { nextStep: "被人改了" }, W("manual-1"));
    expect(a.snapshot().opportunities[1]!.nextStep).toBe("被人改了");
  });
});

describe("inspectSchema / snapshot", () => {
  it("admin 得到 5 张表且 source=mock；非 admin → PERMISSION_DENIED", async () => {
    const a = createMockAdapter(loadMini());
    const s = await a.inspectSchema(ADMIN);
    expect(s.source).toBe("mock");
    expect(s.tables.map((t) => t.id)).toEqual(["account", "contact", "opportunity", "activity", "task"]);
    const stage = s.tables[2]!.fields.find((f) => f.name === "stage");
    expect(stage).toEqual({ name: "stage", kind: "enum", options: ["lead", "qualified", "solution", "negotiation", "won", "lost"] });
    expect(s.tables.every((t) => t.fields.every((f) => f.name !== "raw"))).toBe(true);
    expect(await codeOf(a.inspectSchema(ZHANG))).toBe("PERMISSION_DENIED");
    expect(await codeOf(a.inspectSchema(WANG))).toBe("PERMISSION_DENIED");
  });

  it("构造时深拷贝数据集：外部修改不影响适配器", async () => {
    const ds = loadMini();
    const a = createMockAdapter(ds);
    ds.opportunities[0]!.name = "外部篡改";
    expect((await a.get(ADMIN, { type: "opportunity", id: "opp_1" }) as { name?: string } | null)?.name).toBe("华东精密-二期产线");
  });
});
