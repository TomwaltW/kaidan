// 开单 CLI（spec 附录 F）：doctor / chat / serve / mcp，参数解析用 node:util 的 parseArgs。
// 约定：面向用户的文字用中文；进度与日志一律写 stderr —— mcp（stdio）模式下 stdout 只允许协议消息。
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { runBitableDoctor, type CheckStatus } from "@kaidan/adapters";
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
  pnpm kaidan doctor --config <配置文件> [--online]   （--online：对真实多维表格做一轮只读预检）
  pnpm kaidan chat   --config <配置文件> --as <openId> [--script <steps.json>] [--now <ISO 时间>]
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
        now: { type: "string" },
        online: { type: "boolean" },
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
  if (values.online && command !== "doctor") throw new UsageError(`--online 只能跟 doctor 一起用，不能跟 ${command}`);

  switch (command) {
    case "doctor":
      return doctor(required(values.config, "--config"), values.online ?? false);
    case "chat":
      return chat(required(values.config, "--config"), required(values.as, "--as"), values.script, values.now);
    case "serve":
      return serve(required(values.config, "--config"));
    case "mcp":
      return mcp(required(values.config, "--config"), required(values.as, "--as"));
    default:
      throw new UsageError(`未知子命令：${command}`);
  }
}

// ---------------------------------------------------------------- doctor

/** 第 3 轮 R5：缺备案号只告警、退出码不变。只许写 stderr —— 离线那 6 行 stdout 是逐行验收项，多一行就打红 */
const FILING_NO_WARNING = "警告：llm.disclosure.filingNo 未填写，试点上线前必须填备案号（界面公示用）";

async function doctor(configArg: string, online: boolean): Promise<number> {
  log(`[doctor] 读取配置：${userPath(configArg)}`);
  const config = await readConfig(configArg);
  log("[doctor] 配置有效，加载组件（不调用模型、不连飞书）…");
  // 放在组装之前：只看配置本身，组装失败也不影响这一条
  if (config.llm.kind === "openai_compatible" && !config.llm.disclosure.filingNo) log(FILING_NO_WARNING);
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
    // 离线部分到此为止，输出逐行不变（T0 定下的验收项）；--online 的内容一律追加在后面
    if (!online) return 0;
    return await doctorOnline(config);
  } finally {
    await app.close();
  }
}

const STATUS_MARKS: Record<CheckStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "-" };

/** 只读真机预检：一条都不写 CRM。失败 → 退出码 1，并且每条问题都跟一句可执行的修法 */
async function doctorOnline(config: KaidanConfig): Promise<number> {
  out("");
  if (config.adapter.kind !== "bitable") {
    out(`--online 多维表格预检：当前 adapter 是 ${config.adapter.kind}，没有可联网检查的项（改用 adapter.kind=bitable 的配置再跑）`);
    return 0;
  }
  log("[doctor] --online：对多维表格做只读预检（只发读请求，不写任何记录）…");
  out(`--online 多维表格预检（只读，共 6 项）`);
  const report = await runBitableDoctor(config);
  for (const line of report.lines) {
    out(`${STATUS_MARKS[line.status]} ${line.no}. ${line.title}：${line.detail}`);
    // fail 行给的是必须照做的修法；warn 行给的是可以缓一缓的提醒，别让人以为不改就跑不起来
    const label = line.status === "warn" ? "提醒" : "修法";
    for (const fix of line.fixes ?? []) out(`    ${label}：${fix}`);
  }
  return report.ok ? 0 : 1;
}

// ---------------------------------------------------------------- chat

async function chat(
  configArg: string,
  openId: string,
  scriptArg: string | undefined,
  nowArg: string | undefined,
): Promise<number> {
  const config = await readConfig(configArg);
  const overrides: AppOverrides = {};
  // 脚本回放不是模型生成：用脚本 provider 的缺省公示（脚本 scripted），不冒用配置里的模型名
  if (scriptArg) overrides.provider = createScriptedProvider(await readSteps(userPath(scriptArg)));
  // 演示用：让「现在」从指定时刻开始走（Mock 数据集的 now 是 2026-09-21T09:00:00+08:00）；不给就用真实时间
  if (nowArg) {
    const start = Date.parse(nowArg);
    if (Number.isNaN(start)) throw new UsageError(`--now 不是合法时间：${nowArg}（例：2026-09-21T09:00:00+08:00）`);
    const offset = start - Date.now();
    overrides.clock = () => new Date(Date.now() + offset);
  }
  const app = await buildApp(config, overrides);
  try {
    const actor = await resolveActor(app, openId);
    log(`开单助手 · ${actor.displayName}（${actor.roles.join("/")}）`);
    log("直接输入问题，或用技能命令（如 /晨报、/会后 …）；:approve <提案id> 同意写入，:reject <提案id> 拒绝，:quit 退出");
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
    // 管道输入时 stdin 可能在 handleChatLine 还在等待时就读完，readline 随即自行关闭；
    // 此后再调 rl.prompt() 会抛 ERR_USE_AFTER_CLOSE（"readline was closed"）并把退出码带成 1。
    let rlClosed = false;
    rl.once("close", () => {
      rlClosed = true;
    });
    const prompt = () => {
      if (!rlClosed) rl.prompt();
    };
    rl.setPrompt("> ");
    prompt();
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
      prompt();
    }
    // :quit 退出时才真正需要；stdin 读到 EOF 时 readline 已经关过，close() 是空操作
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
  // stoppedBy="error" 时正文是系统提示（例如「模型服务配置有误…」）、并非模型生成 → 不公示模型（飞书 reply 卡同此规则）
  if (r.stoppedBy !== "error") out(`—— 内容由 AI 生成 · ${disclosureText(r.disclosure)}`);
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
