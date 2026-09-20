// doctor 子命令：不带 --online 的输出必须逐行不变；--online 的退出码与提示。
// 全程不联网：mock 配置没有可联网的项；bitable 配置故意不给环境变量，跑到第 1 项就停。
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const tsx = resolve(repoRoot, "node_modules/.bin/tsx");
const cli = resolve(here, "../src/cli.ts");
const mockConfig = resolve(repoRoot, "config/demo.mock.yaml");
const bitableConfig = resolve(here, "fixtures/doctor-bitable.yaml");

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function doctor(args: string[], env: Record<string, string | undefined> = {}): Promise<Run> {
  // 不设密钥就跑不过配置校验；doctor 不调模型，这里只是占位
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    KAIDAN_LLM_API_KEY: "unused-doctor",
    ...env,
  };
  // undefined 表示「这个变量要不存在」，而不是「值是字符串 undefined」
  for (const [k, v] of Object.entries(childEnv)) if (v === undefined) delete childEnv[k];
  return new Promise((done, fail) => {
    const child = spawn(tsx, [cli, "doctor", ...args], { cwd: repoRoot, env: childEnv as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.once("error", fail);
    child.once("close", (code) => done({ code, stdout, stderr }));
  });
}

describe("doctor", { timeout: 60_000 }, () => {
  it("不带 --online：输出与基线逐行一致，退出码 0", async () => {
    const r = await doctor(["--config", mockConfig]);

    expect(r.code).toBe(0);
    const lines = r.stdout.trimEnd().split("\n");
    expect(lines).toEqual([
      "tenant: demo",
      "adapter: mock",
      "skills: 7（assistant、call-prep /会前、daily-brief /晨报、deal-review /商机体检、post-meeting /会后、setup /初始化、weekly-review /周报）",
      "model: 阿里云百炼 通义千问",
      `governance: ${resolve(repoRoot, ".data/demo.db")}`,
      "users: 5",
    ]);
    // 离线自检不该出现任何 --online 的字样
    expect(r.stdout).not.toContain("--online");
  });

  it("--online 对 mock 适配器：明说没有可联网检查的项，退出码 0", async () => {
    const r = await doctor(["--config", mockConfig, "--online"]);

    expect(r.code).toBe(0);
    // 前 6 行仍然与基线一致
    expect(r.stdout).toContain("adapter: mock\n");
    expect(r.stdout).toContain("users: 5\n");
    expect(r.stdout).toContain("当前 adapter 是 mock，没有可联网检查的项");
    // 没装成检查过的样子
    expect(r.stdout).not.toContain("✓ 1. 凭证");
    expect(r.stdout).not.toContain("多维表格预检（只读，共 6 项）");
  });

  it("--online + bitable 但环境变量缺失：报出缺的变量名与修法，退出码 1", async () => {
    const r = await doctor(["--config", bitableConfig, "--online"], {
      FEISHU_APP_ID: undefined,
      FEISHU_APP_SECRET: undefined,
    });

    expect(r.code).toBe(1);
    expect(r.stdout).toContain("adapter: bitable");
    expect(r.stdout).toContain("✗ 1. 凭证：环境变量 FEISHU_APP_ID、FEISHU_APP_SECRET 未设置");
    expect(r.stdout).toContain("修法：在运行环境里设置 FEISHU_APP_ID");
    expect(r.stdout).toContain("修法：在运行环境里设置 FEISHU_APP_SECRET");
    // 后续各项标成跳过，而不是悄悄不打印
    for (const title of ["2. appToken 可达", "3. 表齐不齐", "4. 字段齐不齐", "5. 抽样读"]) {
      expect(r.stdout).toContain(`- ${title}：依赖第 1 项（凭证），已跳过`);
    }
    expect(r.stdout).toContain("✗ 6. 汇总：1 项没过");
  });

  it("--online 跟在别的子命令后面 → 用法错误，退出码 2", async () => {
    const r = await new Promise<Run>((done, fail) => {
      const child = spawn(tsx, [cli, "serve", "--config", mockConfig, "--online"], {
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

    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--online 只能跟 doctor 一起用");
  });
});
