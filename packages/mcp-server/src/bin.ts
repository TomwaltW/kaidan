// @kaidan/mcp-server 的 stdio 入口（`pnpm --filter @kaidan/mcp-server start -- --config <配置> --as <openId>`）。
// stdio 模式下 stdout 只允许协议消息，日志一律写 stderr。
//
// 组装 ToolDeps 需要适配器与治理（@kaidan/adapters、@kaidan/governance），它们不在本包依赖里（依赖清单冻结），
// 所以这里在运行时动态加载组装包 @kaidan/app（工作区根目录的 devDependency），不在类型层面引用它，避免循环依赖。
// 正式入口是 `pnpm kaidan mcp --config <配置> --as <openId>`，与这里等价。
import { parseArgs } from "node:util";
import { isKaidanError, loadConfig, type Actor, type App, type KaidanConfig } from "@kaidan/contracts";
import { startMcpServer } from "./index.js";

const log = (msg: string) => process.stderr.write(`[mcp] ${msg}\n`);
const USAGE = "用法：pnpm --filter @kaidan/mcp-server start -- --config <配置文件> --as <openId>";

async function loadBuildApp(): Promise<(cfg: KaidanConfig) => Promise<App>> {
  const spec = "@kaidan/app"; // 非字面量：不让类型检查把 app 拉进本包的依赖图
  const mod = (await import(spec)) as { buildApp?: (cfg: KaidanConfig) => Promise<App> };
  if (typeof mod.buildApp !== "function") throw new Error("@kaidan/app 没有导出 buildApp");
  return mod.buildApp;
}

function waitForShutdown(): Promise<string> {
  return new Promise((resolve) => {
    process.once("SIGINT", () => resolve("收到 SIGINT"));
    process.once("SIGTERM", () => resolve("收到 SIGTERM"));
    process.stdin.once("end", () => resolve("stdin 已关闭"));
  });
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift(); // `pnpm start -- --config …` 会把 "--" 原样传进来
  const { values } = parseArgs({
    args: argv,
    options: { config: { type: "string" }, as: { type: "string" } },
    allowPositionals: false,
    strict: true,
  });
  if (!values.config || !values.as) {
    log(USAGE);
    return 2;
  }

  let buildApp: (cfg: KaidanConfig) => Promise<App>;
  try {
    buildApp = await loadBuildApp();
  } catch (e) {
    log(`无法加载组装包 @kaidan/app：${e instanceof Error ? e.message : String(e)}`);
    log(`请改用：pnpm kaidan mcp --config ${values.config} --as ${values.as}`);
    return 1;
  }

  const config = await loadConfig(values.config);
  const app = await buildApp(config);
  try {
    const actor: Actor | null = await app.identity.resolveByOpenId(values.as);
    if (!actor) {
      log(`用户 ${values.as} 不在配置的 users 中`);
      return 1;
    }
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
    log(`以 ${actor.displayName}（${actor.userId}）的身份在 stdio 上提供工具`);
    try {
      log(`${await waitForShutdown()}，正在停止…`);
    } finally {
      await server.close();
    }
  } finally {
    await app.close();
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    log(isKaidanError(e) ? `错误 [${e.code}]：${e.message}` : `错误：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  },
);
