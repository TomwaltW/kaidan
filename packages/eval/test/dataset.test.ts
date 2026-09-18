import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RomDataset } from "@kaidan/contracts";
import { DEFAULT_SEED, FIXTURE_PATH, generateDataset, serializeDataset } from "../src/dataset.js";
import { MINIMUMS, datasetStats, validateDataset } from "../src/checks.js";
import { createRng, mulberry32 } from "../src/prng.js";

describe("PRNG", () => {
  it("mulberry32 同种子同序列、异种子不同", () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const sa = Array.from({ length: 5 }, a), sb = Array.from({ length: 5 }, b), sc = Array.from({ length: 5 }, c);
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    expect(sa.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("shuffle 是排列，int 在闭区间内", () => {
    const rng = createRng(7);
    const arr = Array.from({ length: 20 }, (_, i) => i);
    expect([...rng.shuffle(arr)].sort((x, y) => x - y)).toEqual(arr);
    for (let i = 0; i < 200; i++) {
      const v = rng.int(3, 5);
      expect(v >= 3 && v <= 5).toBe(true);
    }
  });
});

describe("数据集生成器", () => {
  it("同种子两次输出字节一致；不同种子不同", () => {
    const a = serializeDataset(generateDataset(DEFAULT_SEED));
    const b = serializeDataset(generateDataset(DEFAULT_SEED));
    expect(a).toBe(b);
    expect(serializeDataset(generateDataset(DEFAULT_SEED + 1))).not.toBe(a);
  });

  it("已提交的 fixtures/crm-demo.json 就是生成器的输出", () => {
    expect(readFileSync(FIXTURE_PATH, "utf8")).toBe(serializeDataset(generateDataset(DEFAULT_SEED)));
  });

  it("满足 RomDataset schema 与附录 E 的全部约束", () => {
    const ds = generateDataset();
    expect(RomDataset.safeParse(ds).success).toBe(true);
    const r = validateDataset(ds);
    expect(r.errors).toEqual([]);
    const s = datasetStats(ds);
    for (const [k, min] of Object.entries(MINIMUMS)) expect(s[k as keyof typeof MINIMUMS]).toBeGreaterThanOrEqual(min);
    expect(s.injections).toBeGreaterThanOrEqual(5);
    expect(ds.users.map((u) => u.userId)).toEqual(["ou_mgr_wang", "ou_rep_zhang", "ou_rep_li", "ou_rep_zhao", "ou_admin"]);
    expect(ds.now).toBe("2026-09-21T09:00:00+08:00");
    expect(ds.tenantId).toBe("demo");
  });

  it("每个销售今天都有日程，三位销售都有未关闭商机", () => {
    const ds = generateDataset();
    for (const rep of ["ou_rep_zhang", "ou_rep_li", "ou_rep_zhao"]) {
      expect(ds.calendar.some((e) => e.ownerId === rep && e.start.startsWith("2026-09-21"))).toBe(true);
      expect(ds.opportunities.some((o) => o.ownerId === rep && !["won", "lost"].includes(o.stage))).toBe(true);
    }
  });
});

describe("validateDataset 反例", () => {
  const clone = () => structuredClone(generateDataset());

  it("公司名缺「（虚构）」", () => {
    const ds = clone();
    ds.accounts[0]!.name = "真实公司";
    expect(validateDataset(ds).errors).toContain(`${ds.accounts[0]!.id}: 公司名"真实公司"必须以"（虚构）"结尾`);
  });

  it("引用断裂 / id 重复", () => {
    const ds = clone();
    ds.opportunities[0]!.accountId = "acc_missing";
    ds.tasks[1]!.id = ds.tasks[0]!.id;
    const errors = validateDataset(ds).errors;
    expect(errors.some((e) => e.includes("accountId 指向不存在的 acc_missing"))).toBe(true);
    expect(errors).toContain(`id 重复：${ds.tasks[0]!.id}`);
  });

  it("出现完整手机号 / 注入样本不足 / 数量不足", () => {
    const ds = clone();
    ds.activities[0]!.summary = "对方电话 13912345678";
    for (const a of ds.activities) if (/忽略之前|无视|ignore previous|系统提示|AI 助手请注意|助手你好，请/i.test(a.summary ?? "")) a.summary = "正常摘要";
    ds.calendar = ds.calendar.slice(0, 3);
    const errors = validateDataset(ds).errors;
    expect(errors).toContain("数据集中出现了完整手机号");
    expect(errors.some((e) => e.startsWith("注入样本 0 条"))).toBe(true);
    expect(errors).toContain("calendar 数量 3 少于下限 12");
  });

  it("不符合 RomDataset schema → schema 错误", () => {
    const ds = clone() as unknown as { version: number };
    ds.version = 2;
    expect(validateDataset(ds).errors[0]).toMatch(/^schema: version/);
  });
});
