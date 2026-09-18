import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KaidanConfig, KaidanError } from "@kaidan/contracts";
import {
  createAdapter,
  createMockContextProvider,
  createNullContextProvider,
  loadBitableMapping,
} from "../src/index.js";
import { LI, MINI_PATH, ZHANG, loadMini } from "./helpers.js";

const EXAMPLE_MAPPING = fileURLToPath(new URL("../../../config/mapping.example.yaml", import.meta.url));

function config(adapter: Record<string, unknown>, extra: Record<string, unknown> = {}): KaidanConfig {
  return KaidanConfig.parse({
    tenantId: "demo",
    timezone: "Asia/Shanghai",
    llm: { kind: "scripted", disclosure: { providerName: "测试", modelName: "scripted" } },
    adapter,
    governance: { dbPath: ":memory:", proposalTtlMinutes: 1440 },
    risk: { staleDays: 14, stuckDays: 30, soonDays: 7, requiredQualificationKeys: ["pain"] },
    users: [],
    ...extra,
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

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kaidan-adapters-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("日程提供者", () => {
  it("Mock：只返回本人当天的日程，按开始时间排序", async () => {
    const ctx = createMockContextProvider(loadMini());
    expect((await ctx.calendarToday(ZHANG, "2026-09-21")).map((e) => e.id)).toEqual(["ev_1"]);
    expect((await ctx.calendarToday(LI, "2026-09-21")).map((e) => e.id)).toEqual(["ev_2"]);
    expect(await ctx.calendarToday(ZHANG, "2026-09-22")).toEqual([]);
  });
  it("Null：永远返回 []", async () => {
    expect(await createNullContextProvider().calendarToday(ZHANG, "2026-09-21")).toEqual([]);
  });
});

describe("createAdapter", () => {
  it("mock：opts.dataset 优先", async () => {
    const ds = loadMini();
    ds.opportunities = ds.opportunities.slice(0, 1);
    const a = await createAdapter(config({ kind: "mock", mock: { datasetPath: "/不存在.json" } }), { dataset: ds });
    expect(a.kind).toBe("mock");
    expect((await a.search(ZHANG, { type: "opportunity" })).items.map((r) => r.id)).toEqual(["opp_1"]);
  });

  it("mock：读取 datasetPath", async () => {
    const a = await createAdapter(config({ kind: "mock", mock: { datasetPath: MINI_PATH } }));
    expect((await a.search(ZHANG, { type: "opportunity" })).items.map((r) => r.id)).toEqual(["opp_1", "opp_2"]);
  });

  it("mock：数据集缺失 / 非 JSON / 不合法 → CONFIG", async () => {
    expect(await codeOf(createAdapter(config({ kind: "mock", mock: { datasetPath: join(dir, "nope.json") } })))).toBe("CONFIG");
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{not json");
    expect(await codeOf(createAdapter(config({ kind: "mock", mock: { datasetPath: bad } })))).toBe("CONFIG");
    const wrong = join(dir, "wrong.json");
    await writeFile(wrong, JSON.stringify({ version: 2 }));
    expect(await codeOf(createAdapter(config({ kind: "mock", mock: { datasetPath: wrong } })))).toBe("CONFIG");
  });

  it("bitable：构造时只读 mapping，不读密钥、不联网；首次调用缺 feishu 配置 → CONFIG", async () => {
    const cfg = config({ kind: "bitable", bitable: { appToken: "bascnTEST", auth: "tenant", mappingPath: EXAMPLE_MAPPING } });
    const a = await createAdapter(cfg);
    expect(a.kind).toBe("bitable");
    expect(await codeOf(a.search(ZHANG, { type: "account" }))).toBe("CONFIG");
  });

  it("bitable：缺少凭据环境变量 → CONFIG 并指明变量名", async () => {
    const cfg = config(
      { kind: "bitable", bitable: { appToken: "bascnTEST", auth: "tenant", mappingPath: EXAMPLE_MAPPING } },
      { feishu: { appIdEnv: "KAIDAN_TEST_NO_SUCH_APP_ID", appSecretEnv: "KAIDAN_TEST_NO_SUCH_SECRET", domain: "feishu" } },
    );
    const a = await createAdapter(cfg);
    await expect(a.search(ZHANG, { type: "account" })).rejects.toThrow(/KAIDAN_TEST_NO_SUCH_APP_ID/);
  });

  it("bitable：mapping 文件缺失 → CONFIG", async () => {
    const cfg = config({ kind: "bitable", bitable: { appToken: "x", auth: "tenant", mappingPath: join(dir, "none.yaml") } });
    expect(await codeOf(createAdapter(cfg))).toBe("CONFIG");
  });
});

describe("loadBitableMapping", () => {
  it("样例 mapping 可以加载", async () => {
    const m = await loadBitableMapping(EXAMPLE_MAPPING);
    expect(m.objects.opportunity.stageMap?.["商务谈判"]).toBe("negotiation");
    expect(m.objects.contact?.fields["phone"]).toBe("手机");
  });

  it("YAML 语法错 / 结构不合法 / 阶段映射值非法 → CONFIG，message 含文件路径", async () => {
    const cases = {
      "syntax.yaml": "version: 1\nobjects: [unclosed",
      "shape.yaml": "version: 1\nobjects:\n  account: { tableId: t1, fields: {} }\n", // 缺 opportunity
      "stage.yaml":
        "version: 1\nobjects:\n  account: { tableId: t1, fields: {} }\n  opportunity: { tableId: t2, fields: {}, stageMap: { 神秘: mystery } }\n",
      "version.yaml": "version: 2\nobjects: {}\n",
    };
    for (const [name, text] of Object.entries(cases)) {
      const p = join(dir, name);
      await writeFile(p, text);
      try {
        await loadBitableMapping(p);
        expect.fail(`${name} 应失败`);
      } catch (e) {
        expect((e as KaidanError).code).toBe("CONFIG");
        expect((e as Error).message).toContain(p);
      }
    }
  });
});

