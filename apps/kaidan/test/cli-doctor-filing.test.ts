// doctor 的备案号告警（第 3 轮 R5，docs/dev-spec-2026-09-23.md §2 R5）：
// llm.kind=openai_compatible 且没填 llm.disclosure.filingNo → stderr 恰好一行告警，退出码仍 0，stdout 逐行不变。
// 告警只许写 stderr：cli-doctor.test.ts 对 stdout 逐行全等。config/** 冻结，三条用例的配置都写到临时目录。
// 三份配置都以 config/demo.mock.yaml 为底、库一律换成 :memory:：不和 cli-chat / cli-doctor 抢 .data/demo.db
// （新 worktree 首跑时几个进程同时建库会 database is locked，那是已知的冷启动抖动，这里不再添一个）。
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const tsx = resolve(repoRoot, "node_modules/.bin/tsx");
const cli = resolve(here, "../src/cli.ts");
const mockConfig = resolve(repoRoot, "config/demo.mock.yaml");

const WARNING = "警告：llm.disclosure.filingNo 未填写，试点上线前必须填备案号（界面公示用）";

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function doctor(config: string): Promise<Run> {
  return new Promise((done, fail) => {
    // 不设密钥就跑不过配置校验；doctor 不调模型，这里只是占位
    const child = spawn(tsx, [cli, "doctor", "--config", config], {
      cwd: repoRoot,
      env: { ...process.env, KAIDAN_LLM_API_KEY: "unused-doctor" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.once("error", fail);
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}

/** 某一行在输出里整行出现了几次 */
const countLine = (text: string, line: string) => text.split("\n").filter((l) => l === line).length;

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(resolve(tmpdir(), "kaidan-r5-"));
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** 以 config/demo.mock.yaml 为底改出一份写进临时目录：数据集改成绝对路径，库改 :memory:，再做 edit 那一处改动 */
async function variant(name: string, edit: (text: string) => string): Promise<string> {
  const base = (await readFile(mockConfig, "utf8"))
    .replace("datasetPath: ../", `datasetPath: ${repoRoot}/`)
    .replace("dbPath: ../.data/demo.db", 'dbPath: ":memory:"');
  const path = resolve(dir, name);
  await writeFile(path, edit(base));
  return path;
}

describe("doctor：备案号告警（第 3 轮 R5）", { timeout: 60_000 }, () => {
  it("R5-1 openai_compatible 且没填 filingNo → stderr 恰好一行告警，退出码 0，stdout 与改动前逐行一致", async () => {
    const r = await doctor(await variant("unfiled.yaml", (t) => t));

    expect(r.code).toBe(0);
    expect(countLine(r.stderr, WARNING)).toBe(1);
    // 与 cli-doctor.test.ts 第一条的 6 行相同，只有库换成了 :memory:：告警一个字都不许进 stdout
    expect(r.stdout.trimEnd().split("\n")).toEqual([
      "tenant: demo",
      "adapter: mock",
      "skills: 7（assistant、call-prep /会前、daily-brief /晨报、deal-review /商机体检、post-meeting /会后、setup /初始化、weekly-review /周报）",
      "model: 阿里云百炼 通义千问",
      "governance: :memory:",
      "users: 5",
    ]);
  });

  it("R5-2 填了 filingNo → 不告警，页脚带上备案号", async () => {
    const config = await variant("filed.yaml", (t) =>
      t.replace(/^( *)modelName: (.*)$/m, "$1modelName: $2\n$1filingNo: TEST-0000"),
    );
    const r = await doctor(config);

    expect(r.code).toBe(0);
    // 这一行证明变体配置真的带上了 filingNo（不是读错了文件）
    expect(r.stdout).toContain("model: 阿里云百炼 通义千问 · 备案号 TEST-0000\n");
    expect(r.stderr).not.toContain("filingNo 未填写");
  });

  it("R5-3 llm.kind=scripted（非 openai_compatible）→ 不告警", async () => {
    const config = await variant("scripted.yaml", (t) => t.replace("kind: openai_compatible", "kind: scripted"));
    const r = await doctor(config);

    // doctor 本来就不支持 scripted：配置校验通过之后、组装时报 CONFIG、退出码 1，与本项无关，不断言退出码。
    // 这句出现说明已经走过了告警判断（告警在组装之前）
    expect(r.stderr).toContain("llm.kind=scripted 时必须通过 AppOverrides.provider 注入脚本 provider");
    expect(r.stderr).not.toContain("filingNo 未填写");
  });
});
