// 契约自检（T0，spec 2.3 C1）：冻结的契约源码、样例配置与验收数据集彼此一致，且能被真实解析。
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  BitableMapping,
  ErrorCode,
  KaidanError,
  RomDataset,
  SKILL_NAMES,
  SkillFrontmatter,
  formatToolResultForModel,
  isKaidanError,
  loadConfig,
  notImplemented,
} from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const at = (p: string) => resolve(ROOT, p);

/** 期望 fn 抛出指定 code 的 KaidanError，并返回它以便继续断言 */
async function expectKaidanError(fn: () => Promise<unknown>, code: ErrorCode): Promise<KaidanError> {
  try {
    await fn();
  } catch (e) {
    expect(isKaidanError(e)).toBe(true);
    expect((e as KaidanError).code).toBe(code);
    return e as KaidanError;
  }
  throw new Error(`期望抛出 KaidanError(${code})，实际没有抛出`);
}

// 附录 B：技能清单（name / command / allowed_tools / schedule / roles 冻结；description 为自检用的示例文案）
interface AppendixRow {
  name: (typeof SKILL_NAMES)[number];
  description: string;
  command?: string;
  allowed_tools: string[];
  schedule?: "daily_brief" | "weekly_review";
  roles?: Array<"rep" | "manager" | "admin">;
}
const APPENDIX_B: AppendixRow[] = [
  {
    name: "assistant",
    description: "通用销售助手：查询客户、商机与跟进记录，需要修改时生成提案。",
    allowed_tools: ["crm_search", "crm_get", "crm_timeline", "pipeline_snapshot", "calendar_today", "propose_update", "propose_create"],
  },
  {
    name: "daily-brief",
    description: "每天早上给销售的晨报：今日日程、近期要成交与风险商机。",
    command: "/晨报",
    allowed_tools: ["pipeline_snapshot", "calendar_today", "crm_get", "crm_timeline"],
    schedule: "daily_brief",
  },
  {
    name: "call-prep",
    description: "见客户之前的会前准备：客户现状、最近跟进与建议提问。",
    command: "/会前",
    allowed_tools: ["calendar_today", "crm_search", "crm_get", "crm_timeline", "propose_create"],
  },
  {
    name: "deal-review",
    description: "对单个商机做体检：按资格四要素打分，列出风险与下一步。",
    command: "/商机体检",
    allowed_tools: ["crm_search", "crm_get", "crm_timeline", "propose_update", "propose_create"],
  },
  {
    name: "post-meeting",
    description: "开完会一句话更新 CRM：抽取结论并提议更新商机与待办。",
    command: "/会后",
    allowed_tools: ["crm_search", "crm_get", "crm_timeline", "propose_update", "propose_create"],
  },
  {
    name: "weekly-review",
    description: "面向主管的周报：按阶段汇总、可能滑单的商机与下周重点。",
    command: "/周报",
    allowed_tools: ["pipeline_snapshot", "crm_search", "crm_timeline"],
    schedule: "weekly_review",
  },
  {
    name: "setup",
    description: "管理员初始化：读取多维表格结构，产出 mapping.yaml 草稿。",
    command: "/初始化",
    allowed_tools: ["schema_inspect"],
    roles: ["admin"],
  },
];

describe("RomDataset", () => {
  it("tests/e2e/fixtures/mini.json 能被 RomDataset 解析，内容与附录 G 一致", () => {
    const ds = RomDataset.parse(JSON.parse(readFileSync(at("tests/e2e/fixtures/mini.json"), "utf8")));
    expect(ds.tenantId).toBe("demo");
    expect(ds.now).toBe("2026-09-21T09:00:00+08:00");
    expect(ds.users.map((u) => u.userId)).toEqual(["ou_mgr_wang", "ou_rep_zhang", "ou_rep_li", "ou_admin"]);
    expect(ds.accounts.map((a) => a.id)).toEqual(["acc_hdjm", "acc_xyrj", "acc_nhwm"]);
    expect(ds.opportunities.map((o) => [o.id, o.stage, o.amount])).toEqual([
      ["opp_1", "solution", 480000],
      ["opp_2", "negotiation", 120000],
      ["opp_3", "qualified", 260000],
    ]);
    expect(ds.contacts.map((c) => c.phoneMasked)).toEqual(["138****0001", "139****0002"]);
    expect(ds.activities).toHaveLength(3);
    expect(ds.tasks).toHaveLength(1);
    expect(ds.calendar.map((e) => e.id)).toEqual(["ev_1", "ev_2"]);
  });
});

describe("loadConfig：样例配置", () => {
  it("config/demo.mock.yaml 能被解析，相对路径变成相对配置文件目录的绝对路径", async () => {
    const cfg = await loadConfig(at("config/demo.mock.yaml"));
    expect(cfg.tenantId).toBe("demo");
    expect(cfg.adapter.kind).toBe("mock");
    expect(cfg.adapter.mock?.datasetPath).toBe(at("packages/eval/fixtures/crm-demo.json"));
    expect(cfg.governance.dbPath).toBe(at(".data/demo.db"));
    expect(cfg.llm.disclosure).toEqual({ providerName: "阿里云百炼", modelName: "通义千问" });
    expect(cfg.users).toHaveLength(5);
  });

  it("config/tenant.example.yaml 能被解析，mappingPath 与 dbPath 变成绝对路径", async () => {
    const cfg = await loadConfig(at("config/tenant.example.yaml"));
    expect(cfg.adapter.kind).toBe("bitable");
    expect(cfg.adapter.bitable?.auth).toBe("tenant");
    expect(cfg.adapter.bitable?.mappingPath).toBe(at("config/mapping.example.yaml"));
    expect(cfg.governance.dbPath).toBe(at(".data/acme.db"));
    expect(cfg.feishu).toEqual({ appIdEnv: "FEISHU_APP_ID", appSecretEnv: "FEISHU_APP_SECRET", domain: "feishu" });
    expect(cfg.users).toHaveLength(3);
  });

  it("config/mapping.example.yaml 能被 BitableMapping 解析", () => {
    const mapping = BitableMapping.parse(parse(readFileSync(at("config/mapping.example.yaml"), "utf8")));
    expect(mapping.objects.opportunity.stageMap?.["商务谈判"]).toBe("negotiation");
    expect(mapping.objects.opportunity.fields["ownerId"]).toBe("负责人");
    expect(mapping.objects.contact?.fields["phone"]).toBe("手机");
  });
});

describe("loadConfig：失败面与路径规则（临时文件）", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "kaidan-contracts-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const minimal = (adapter: string, extra = "") => `tenantId: t1
timezone: Asia/Shanghai
llm:
  kind: scripted
  disclosure: { providerName: 测试, modelName: scripted }
adapter:
${adapter}
governance: { dbPath: ":memory:", proposalTtlMinutes: 60 }
risk: { staleDays: 14, stuckDays: 30, soonDays: 7, requiredQualificationKeys: [pain] }
users:
  - { openId: ou_a, displayName: 甲, roles: [rep] }
${extra}`;

  async function write(name: string, text: string): Promise<string> {
    const path = join(dir, name);
    await writeFile(path, text, "utf8");
    return path;
  }

  it("adapter.kind=mock 但缺 adapter.mock → CONFIG", async () => {
    const path = await write("mock-missing.yaml", minimal("  kind: mock"));
    const e = await expectKaidanError(() => loadConfig(path), ErrorCode.CONFIG);
    expect(e.message).toContain("adapter.mock");
  });

  it("adapter.kind=bitable 但缺 adapter.bitable → CONFIG", async () => {
    const path = await write("bitable-missing.yaml", minimal("  kind: bitable"));
    const e = await expectKaidanError(() => loadConfig(path), ErrorCode.CONFIG);
    expect(e.message).toContain("adapter.bitable");
  });

  it("zod 校验失败 → CONFIG，message 含字段路径", async () => {
    const path = await write("bad-risk.yaml", minimal("  kind: mock\n  mock: { datasetPath: d.json }").replace("staleDays: 14", "staleDays: -1"));
    const e = await expectKaidanError(() => loadConfig(path), ErrorCode.CONFIG);
    expect(e.message).toContain("risk.staleDays");
  });

  it('dbPath=":memory:" 原样保留；datasetPath 与 skillsDir 相对配置文件目录解析', async () => {
    const path = await write("ok.yaml", minimal("  kind: mock\n  mock: { datasetPath: data/d.json }", "skillsDir: ./my-skills\n"));
    const cfg = await loadConfig(path);
    expect(cfg.governance.dbPath).toBe(":memory:");
    expect(cfg.adapter.mock?.datasetPath).toBe(join(dir, "data/d.json"));
    expect(cfg.skillsDir).toBe(join(dir, "my-skills"));
  });
});

describe("技能契约", () => {
  it("SKILL_NAMES 长度为 7，顺序与附录 B 一致", () => {
    expect(SKILL_NAMES).toHaveLength(7);
    expect([...SKILL_NAMES]).toEqual(APPENDIX_B.map((row) => row.name));
  });

  it.each(APPENDIX_B)("附录 B：$name 的 frontmatter 能通过 SkillFrontmatter", (row) => {
    const fm = SkillFrontmatter.parse(row);
    expect(fm.name).toBe(row.name);
    expect(fm.allowed_tools).toEqual(row.allowed_tools);
    expect(fm.command).toBe(row.command);
    expect(fm.schedule).toBe(row.schedule);
    expect(fm.roles).toEqual(row.roles);
  });

  it("非法 name 会被 SkillFrontmatter 拒绝", () => {
    const base = APPENDIX_B[0]!;
    expect(SkillFrontmatter.safeParse({ ...base, name: "sales-magic" }).success).toBe(false);
    expect(SkillFrontmatter.safeParse({ ...base, name: "Assistant" }).success).toBe(false);
  });

  it("非法 command / 未知工具 / 空工具列表会被 SkillFrontmatter 拒绝", () => {
    const base = APPENDIX_B[1]!;
    expect(SkillFrontmatter.safeParse({ ...base, command: "晨报" }).success).toBe(false);
    expect(SkillFrontmatter.safeParse({ ...base, allowed_tools: ["crm_delete"] }).success).toBe(false);
    expect(SkillFrontmatter.safeParse({ ...base, allowed_tools: [] }).success).toBe(false);
  });
});

describe("formatToolResultForModel", () => {
  it("成功结果 → {ok:true, output}，不带 ms", () => {
    const text = formatToolResultForModel({ ok: true, output: { items: [{ id: "opp_1" }] }, ms: 12 });
    expect(text).toBe('{"ok":true,"output":{"items":[{"id":"opp_1"}]}}');
  });

  it("失败结果 → {ok:false, error:{code,message}}，不带 ms", () => {
    const text = formatToolResultForModel({
      ok: false,
      error: { code: ErrorCode.PERMISSION_DENIED, message: "无权限访问该记录" },
      ms: 3,
    });
    expect(text).toBe('{"ok":false,"error":{"code":"PERMISSION_DENIED","message":"无权限访问该记录"}}');
  });
});

describe("KaidanError", () => {
  it("code 与 retryable：缺省不可重试；显式 retryable=true 时可重试", () => {
    const plain = new KaidanError(ErrorCode.UPSTREAM, "上游 4xx");
    expect(plain).toBeInstanceOf(Error);
    expect(plain.name).toBe("KaidanError");
    expect(plain.code).toBe("UPSTREAM");
    expect(plain.retryable).toBe(false);
    expect(plain.details).toBeUndefined();

    const cause = new Error("429");
    const limited = new KaidanError(ErrorCode.RATE_LIMITED, "频控", { retryable: true, details: { attempt: 3 }, cause });
    expect(limited.code).toBe("RATE_LIMITED");
    expect(limited.retryable).toBe(true);
    expect(limited.details).toEqual({ attempt: 3 });
    expect(limited.cause).toBe(cause);
    expect(isKaidanError(limited)).toBe(true);
    expect(isKaidanError(cause)).toBe(false);
  });

  it("notImplemented 抛 NOT_IMPLEMENTED，message 含被调用的名字", async () => {
    const e = await expectKaidanError(async () => notImplemented("@kaidan/x.y"), ErrorCode.NOT_IMPLEMENTED);
    expect(e.message).toBe("@kaidan/x.y 尚未实现");
  });
});
