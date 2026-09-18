// 开单 CLI（spec 附录 F）：doctor / chat / serve / mcp，参数解析用 node:util 的 parseArgs。
// 约定：面向用户的文字用中文；进度与日志一律写 stderr —— mcp（stdio）模式下 stdout 只允许协议消息。
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { createScriptedProvider } from "@kaidan/agent";
import {
  ErrorCode,
  KaidanError,
  isKaidanError,
  loadConfig,
  type Actor,
  type AgentRunResult,
  type App,
  type AppOverrides,
  type KaidanConfig,
  type ModelDisclosure,
  type Proposal,
  type ScriptStep,
} from "@kaidan/contracts";
import { startMcpServer } from "@kaidan/mcp-server";
import { buildApp } from "./app.js";

const USAGE = `用法：
  pnpm kaidan doctor --config <配置文件>
  pnpm kaidan chat   --config <配置文件> --as <openId> [--script <steps.json>]
  pnpm kaidan serve  --config <配置文件>
  pnpm kaidan mcp    --config <配置文件> --as <openId>`;

class UsageError extends Error {}

const log = (msg: string) => void process.stderr.write(msg + "\n");
const out = (msg: string) => void process.stdout.write(msg + "\n");

/** pnpm 在包目录（apps/kaidan）里执行脚本；相对路径按用户敲命令时所在的目录（INIT_CWD）解析 */
const userPath = (p: string) => resolve(process.env.INIT_CWD ?? process.cwd(), p);

function required(value: string | undefined, flag: string): string {
  if (!value) throw new UsageError(`缺少参数 ${flag}`);
  return value;
}

async function main(argv: string[]): Promise<number> {
  // `pnpm kaidan …` 会经过 `pnpm --filter @kaidan/app start -- …`，pnpm 把 "--" 原样传进来（`pnpm kaidan -- …` 时还会多一个）
  const args = [...argv];
  while (args[0] === "--") args.shift();
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        config: { type: "string" },
        as: { type: "string" },
        script: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const { values, positionals } = parsed;
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const [command, ...extra] = positionals;
  if (!command) throw new UsageError("缺少子命令");
  if (extra.length > 0) throw new UsageError(`多余的参数：${extra.join(" ")}`);

  switch (command) {
    case "doctor":
      return doctor(required(values.config, "--config"));
    case "chat":
      return chat(required(values.config, "--config"), required(values.as, "--as"), values.script);
    case "serve":
      return serve(required(values.config, "--config"));
    case "mcp":
      return mcp(required(values.config, "--config"), required(values.as, "--as"));
    default:
      throw new UsageError(`未知子命令：${command}`);
  }
}

// ---------------------------------------------------------------- doctor

async function doctor(configArg: string): Promise<number> {
  log(`[doctor] 读取配置：${userPath(configArg)}`);
  const config = await readConfig(configArg);
  log("[doctor] 配置有效，加载组件（不调用模型、不连飞书）…");
  const app = await buildApp(config);
  try {
    const skills = app.agent.skills();
    const listed = skills.map((s) => (s.command ? `${s.name} ${s.command}` : s.name)).join("、");
    out(`tenant: ${config.tenantId}`);
    out(`adapter: ${app.adapter.kind}`);
    out(`skills: ${skills.length}（${listed}）`);
    out(`model: ${disclosureText(config.llm.disclosure)}`);
    out(`governance: ${config.governance.dbPath}`);
    out(`users: ${config.users.length}`);
  } finally {
    await app.close();
  }
  return 0;
}

// ---------------------------------------------------------------- chat

async function chat(configArg: string, openId: string, scriptArg: string | undefined): Promise<number> {
  const config = await readConfig(configArg);
  const overrides: AppOverrides = {};
  // 脚本回放不是模型生成：用脚本 provider 的缺省公示（脚本 scripted），不冒用配置里的模型名
  if (scriptArg) overrides.provider = createScriptedProvider(await readSteps(userPath(scriptArg)));
  const app = await buildApp(config, overrides);
  try {
    const actor = await resolveActor(app, openId);
    log(`开单助手 · ${actor.displayName}（${actor.roles.join("/")}）`);
    log("直接输入问题，或用技能命令（如 /晨报、/会后 …）；:approve <提案id> 同意写入，:reject <提案id> 拒绝，:quit 退出");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    rl.setPrompt("> ");
    rl.prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (line === ":quit" || line === ":q") break;
      if (line) {
        try {
          await handleChatLine(app, actor, line);
        } catch (e) {
          log(describeError(e));
        }
      }
      rl.prompt();
    }
    rl.close();
  } finally {
    await app.close();
  }
  return 0;
}

async function handleChatLine(app: App, actor: Actor, line: string): Promise<void> {
  if (line.startsWith(":")) {
    const [cmd, id, ...rest] = line.split(/\s+/);
    if ((cmd !== ":approve" && cmd !== ":reject") || !id || rest.length > 0) {
      log("可用指令：:approve <提案id>、:reject <提案id>、:quit");
      return;
    }
    const p =
      cmd === ":approve"
        ? await app.governance.approvals.approve(id, actor)
        : await app.governance.approvals.reject(id, actor);
    out(`提案 ${p.id} → ${p.status}${p.status === "committed" ? "（已写入 CRM）" : p.status === "rejected" ? "（已拒绝）" : ""}`);
    return;
  }
  const result = await app.agent.run({ actor, text: line, traceId: `cli-${randomUUID()}`, channel: "cli" });
  printResult(result);
}

function printResult(r: AgentRunResult): void {
  out(r.reply || "（没有回复内容）");
  for (const p of r.proposals) printProposal(p);
  out(`—— 内容由 AI 生成 · ${disclosureText(r.disclosure)}`);
  if (r.stoppedBy !== "final") log(`[提示] 本次运行提前结束：${r.stoppedBy}`);
}

function printProposal(p: Proposal): void {
  const target = p.targetId ? ` ${p.targetId}` : "";
  out(`\n提案 ${p.id}（${p.kind === "update" ? "修改" : "新建"} ${p.objectType}${target}，${p.status}）`);
  for (const d of p.diff) out(`  ${d.field}: ${showValue(d.before)} → ${showValue(d.after)}`);
  out(`  理由：${p.reason}`);
  out(`  点同意后才会写入：:approve ${p.id}　不要：:reject ${p.id}`);
}

function showValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "（空）";
  return typeof v === "string" ? v : JSON.stringify(v);
}

async function readSteps(path: string): Promise<ScriptStep[]> {
  let data: unknown;
  try {
    data = JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    throw new KaidanError(ErrorCode.CONFIG, `脚本文件无法读取或不是合法 JSON：${path}`, { cause: e });
  }
  if (!Array.isArray(data) || !data.every(isScriptStep)) {
    throw new KaidanError(ErrorCode.CONFIG, `脚本文件应为 ScriptStep 数组（[{toolCalls?, content?}, …]）：${path}`);
  }
  return data;
}

function isScriptStep(v: unknown): v is ScriptStep {
  if (typeof v !== "object" || v === null) return false;
  const { content, toolCalls } = v as Record<string, unknown>;
  if (content !== undefined && typeof content !== "string") return false;
  if (toolCalls === undefined) return true;
  return (
    Array.isArray(toolCalls) &&
    toolCalls.every((c: unknown) => {
      if (typeof c !== "object" || c === null) return false;
      const { name, arguments: args } = c as Record<string, unknown>;
      return typeof name === "string" && typeof args === "object" && args !== null && !Array.isArray(args);
    })
  );
}

// ---------------------------------------------------------------- serve

async function serve(configArg: string): Promise<number> {
  const config = await readConfig(configArg);
  const app = await buildApp(config);
  try {
    await app.surface.start();
    log(`开单已启动：租户 ${config.tenantId}，已连接飞书。Ctrl+C 停止。`);
    const signal = await waitForShutdown();
    log(`收到 ${signal}，正在停止…`);
  } finally {
    await app.close();
  }
  return 0;
}

// ---------------------------------------------------------------- mcp

async function mcp(configArg: string, openId: string): Promise<number> {
  const config = await readConfig(configArg);
  const app = await buildApp(config);
  try {
    const actor = await resolveActor(app, openId);
    const server = await startMcpServer({
      adapter: app.adapter,
      proposals: app.governance.proposals,
      audit: app.governance.audit,
      context: app.context,
      risk: config.risk,
      timezone: config.timezone,
      proposalTtlMinutes: config.governance.proposalTtlMinutes,
      actor,
    });
    log(`[mcp] 以 ${actor.displayName}（${actor.userId}）的身份在 stdio 上提供工具`);
    try {
      const reason = await waitForShutdown({ stdinEnd: true });
      log(`[mcp] ${reason}，正在停止…`);
    } finally {
      await server.close();
    }
  } finally {
    await app.close();
  }
  return 0;
}

// ---------------------------------------------------------------- 公共

async function readConfig(configArg: string): Promise<KaidanConfig> {
  const path = userPath(configArg);
  try {
    return await loadConfig(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new KaidanError(ErrorCode.CONFIG, `找不到配置文件：${path}`, { cause: e });
    }
    throw e;
  }
}

async function resolveActor(app: App, openId: string): Promise<Actor> {
  const actor = await app.identity.resolveByOpenId(openId);
  if (!actor) throw new KaidanError(ErrorCode.CONFIG, `用户 ${openId} 不在配置的 users 中`);
  return actor;
}

function disclosureText(d: ModelDisclosure): string {
  return `${d.providerName} ${d.modelName}${d.filingNo ? ` · 备案号 ${d.filingNo}` : ""}`;
}

function waitForShutdown(opts: { stdinEnd?: boolean } = {}): Promise<string> {
  return new Promise((done) => {
    process.once("SIGINT", () => done("SIGINT"));
    process.once("SIGTERM", () => done("SIGTERM"));
    if (opts.stdinEnd) process.stdin.once("end", () => done("stdin 已关闭"));
  });
}

function describeError(e: unknown): string {
  if (isKaidanError(e)) return `错误 [${e.code}]：${e.message}`;
  if (e instanceof Error) return `错误：${e.message}`;
  return `错误：${String(e)}`;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    if (e instanceof UsageError) {
      log(`${e.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      log(describeError(e));
      process.exitCode = 1;
    }
  },
).finally(() => {
  // 正常情况下事件循环清空后自然退出；若有组件残留句柄，2 秒后兜底退出（unref 不会拖住进程）
  setTimeout(() => process.exit(), 2000).unref();
});
