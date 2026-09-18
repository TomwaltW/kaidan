// `pnpm bench -- --config <path> [--only id,...]`：用 buildApp + 真实 provider 跑评测任务，
// 输出 packages/eval/reports/<时间戳>.{json,md}。需要模型密钥，由总管手动运行。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildApp } from "@kaidan/app";
import { ErrorCode, KaidanError, RomDataset, loadConfig } from "@kaidan/contracts";
import { TASKS_DIR, loadTasks } from "./tasks.js";
import { renderMarkdown, runBench, summarize } from "./score.js";

const REPORTS_DIR = fileURLToPath(new URL("../reports", import.meta.url));

// 根脚本是 `pnpm --filter @kaidan/eval bench --`，pnpm 会把 "--" 原样传进来（用户再写 `pnpm bench -- …` 时还会多一个）；
// 先去掉开头的 "--"，否则 parseArgs 会把其后的参数全当成位置参数
const argv = process.argv.slice(2);
while (argv[0] === "--") argv.shift();
const { values } = parseArgs({
  args: argv,
  options: { config: { type: "string" }, only: { type: "string" } },
  allowPositionals: false,
});
if (!values.config) {
  process.stderr.write("用法：pnpm bench -- --config <path> [--only id,...]\n");
  process.exit(2);
}
// pnpm --filter 会把 cwd 切到包目录；相对路径按用户执行命令时的目录解析
const configPath = resolve(process.env.INIT_CWD ?? process.cwd(), values.config);
const loaded = await loadConfig(configPath);
if (loaded.adapter.kind !== "mock" || !loaded.adapter.mock) {
  throw new KaidanError(ErrorCode.CONFIG, "bench 需要 adapter.kind=mock（oracle 要从同一数据集计算期望值）");
}
const dataset = RomDataset.parse(JSON.parse(await readFile(loaded.adapter.mock.datasetPath, "utf8")));
// bench 必须用真实模型：缺密钥时每个任务都会记成 stoppedBy=error、成功率 0%，看起来像模型很差 —— 开跑前就拦下
const keyEnv = loaded.llm.kind === "openai_compatible" ? loaded.llm.apiKeyEnv : undefined;
if (keyEnv && !process.env[keyEnv]) {
  process.stderr.write(`缺少环境变量 ${keyEnv}（llm.apiKeyEnv）：bench 需要真实模型的密钥，先 export ${keyEnv}=… 再运行\n`);
  process.exit(2);
}
// 评测不落盘：提案与审计用内存库；时钟固定在数据集的 now，保证期望值可复现
const config = { ...loaded, governance: { ...loaded.governance, dbPath: ":memory:" } };

const { tasks: all, errors } = await loadTasks(TASKS_DIR);
if (errors.length > 0) throw new KaidanError(ErrorCode.CONFIG, `任务文件无效：${errors.join("; ")}`);
const only = values.only ? new Set(values.only.split(",").map((s) => s.trim()).filter(Boolean)) : null;
const tasks = all.map((t) => t.task).filter((t) => !only || only.has(t.id));

const app = await buildApp(config, { dataset, clock: () => new Date(dataset.now) });
try {
  const scores = await runBench(tasks, {
    agent: app.agent,
    resolveActor: (openId) => app.identity.resolveByOpenId(openId),
    dataset,
    risk: config.risk,
    timezone: config.timezone,
  });
  const d = config.llm.disclosure;
  const generatedAt = new Date().toISOString();
  const report = summarize(scores, { generatedAt, model: `${d.providerName} ${d.modelName}` });
  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, "-");
  await writeFile(join(REPORTS_DIR, `${stamp}.json`), JSON.stringify(report, null, 2) + "\n", "utf8");
  await writeFile(join(REPORTS_DIR, `${stamp}.md`), renderMarkdown(report), "utf8");
  process.stdout.write(
    `成功率 ${report.passed}/${report.total} · 越权 ${report.permissionViolations} · 注入命中 ${report.injectionHits}\n` +
      `报告：${join(REPORTS_DIR, stamp)}.{json,md}\n`,
  );
} finally {
  await app.close();
}
