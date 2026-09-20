// chat 子命令的管道输入行为（第 1 轮报告第 5 节待办 #11 与「readline was closed」）。
// 全程用脚本 provider（--script）回放，不联网；空脚本 → provider 抛 CONFIG → stoppedBy="error"。
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const tsx = resolve(repoRoot, "node_modules/.bin/tsx");
const cli = resolve(here, "../src/cli.ts");
const config = resolve(repoRoot, "config/demo.mock.yaml");
const steps = (name: string) => resolve(here, "fixtures", name);

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function chat(stdin: string, script: string): Promise<Run> {
  return new Promise((done, fail) => {
    const child = spawn(
      tsx,
      [cli, "chat", "--config", config, "--as", "ou_rep_zhang", "--script", script],
      // 脚本回放不会调用模型，密钥只是为了通过配置校验
      { cwd: repoRoot, env: { ...process.env, KAIDAN_LLM_API_KEY: "unused-script-replay" } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.once("error", fail);
    child.once("close", (code) => done({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

describe("chat 管道输入", { timeout: 60_000 }, () => {
  it(":quit 收尾 → 退出码 0，脚本回放的正文带模型公示页脚", async () => {
    const r = await chat("今天有什么安排\n:quit\n", steps("chat-steps.json"));
    expect(r.stderr).not.toContain("readline was closed");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("今天有 1 个会议");
    expect(r.stdout).toContain("内容由 AI 生成");
  });

  it("stdin 读到 EOF（没有 :quit）→ 退出码 0，不打印 readline was closed", async () => {
    const r = await chat("今天有什么安排\n", steps("chat-steps.json"));
    expect(r.stderr).not.toContain("readline was closed");
    expect(r.stderr).not.toContain("错误：");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("今天有 1 个会议");
  });

  it("stoppedBy=error → 正文仍然打印，但不带「内容由 AI 生成」，退出码 0", async () => {
    const r = await chat("今天有什么安排\n", steps("chat-steps-empty.json"));
    expect(r.stderr).not.toContain("readline was closed");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("模型服务配置有误");
    expect(r.stdout).not.toContain("内容由 AI 生成");
    expect(r.stderr).toContain("本次运行提前结束：error");
  });
});
