// `pnpm eval:validate`：校验数据集与任务文件；成功时输出 `dataset OK` 与 `tasks: 20 OK`。
import { readFile } from "node:fs/promises";
import { FIXTURE_PATH } from "./dataset.js";
import { validateDataset, validateTasks } from "./checks.js";
import { TASKS_DIR, loadTasks } from "./tasks.js";

const fail = (title: string, errors: string[]) => {
  for (const e of errors) process.stderr.write(`✗ ${e}\n`);
  process.stdout.write(`${title} FAILED（${errors.length} 个问题）\n`);
  process.exit(1);
};

let raw: unknown;
try {
  raw = JSON.parse(await readFile(FIXTURE_PATH, "utf8"));
} catch (e) {
  fail("dataset", [`无法读取 ${FIXTURE_PATH}：${(e as Error).message}`]);
}
const d = validateDataset(raw);
if (!d.ok || !d.dataset || !d.stats) fail("dataset", d.errors);
else {
  const s = d.stats;
  process.stdout.write(
    `客户 ${s.accounts} · 联系人 ${s.contacts} · 商机 ${s.opportunities} · 活动 ${s.activities}` +
      `（注入 ${s.injections}）· 待办 ${s.tasks} · 日程 ${s.calendar} · 用户 ${s.users}\n`,
  );
  process.stdout.write("dataset OK\n");

  const { tasks, errors } = await loadTasks(TASKS_DIR);
  const all = [...errors, ...validateTasks(tasks, d.dataset)];
  if (all.length > 0) fail("tasks", all);
  process.stdout.write(`tasks: ${tasks.length} OK\n`);
}
