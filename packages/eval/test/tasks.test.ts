import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateDataset } from "../src/dataset.js";
import { validateTasks } from "../src/checks.js";
import { CATEGORY_COUNTS, EvalTask, TASKS_DIR, loadTasks } from "../src/tasks.js";

describe("任务文件", () => {
  it("恰 20 个、schema 全部合法、类别数量符合附录 E、引用对 actor 可见", async () => {
    const { tasks, errors } = await loadTasks(TASKS_DIR);
    expect(errors).toEqual([]);
    expect(tasks).toHaveLength(20);
    const counts: Record<string, number> = {};
    for (const { task } of tasks) counts[task.checks.type] = (counts[task.checks.type] ?? 0) + 1;
    expect(counts).toEqual(CATEGORY_COUNTS);
    expect(validateTasks(tasks, generateDataset())).toEqual([]);
  });

  it("schema 反例：stage 指标缺 stage、update 缺 targetId、注入未禁 propose_*、多余字段", () => {
    const base = { id: "x-1", actor: "ou_rep_zhang", text: "t" };
    const bad = [
      { ...base, checks: { type: "aggregate", oracle: { metric: "stage_count", scope: "me" } } },
      { ...base, checks: { type: "proposal", proposal: { kind: "update", objectType: "opportunity", patch: { stage: "won" } } } },
      { ...base, checks: { type: "injection", forbidTools: ["propose_update"], noPhonePattern: true } },
      { ...base, extra: 1, checks: { type: "brief", mustMention: ["opp_001"] } },
      { ...base, skill: "unknown", checks: { type: "brief", mustMention: ["opp_001"] } },
      { ...base, checks: { type: "permission", mustNotContain: [] } },
    ];
    for (const t of bad) expect(EvalTask.safeParse(t).success, JSON.stringify(t)).toBe(false);
    expect(EvalTask.safeParse({ ...base, checks: { type: "brief", mustMention: ["opp_001"] } }).success).toBe(true);
  });

  it("validateTasks 反例：类别分布不对、引用不可见、销售用 team 视角、文件名不符", async () => {
    const dir = await mkdtemp(join(tmpdir(), "kaidan-tasks-"));
    try {
      await writeFile(join(dir, "a.yaml"), "id: a\nactor: ou_rep_zhang\ntext: x\nchecks: { type: brief, mustMention: [opp_003] }\n");
      await writeFile(join(dir, "b.yaml"), "id: b\nactor: ou_rep_li\ntext: x\nchecks: { type: aggregate, oracle: { metric: open_amount, scope: team } }\n");
      await writeFile(join(dir, "c.yaml"), "id: other\nactor: ou_rep_li\ntext: x\nchecks: { type: permission, mustNotContain: [x] }\n");
      await writeFile(join(dir, "d.yaml"), "id: d\nactor: ou_nobody\ntext: x\nchecks: { type: permission, mustNotContain: [x] }\n");
      await writeFile(join(dir, "e.yaml"), "id: [broken\n");
      const { tasks, errors } = await loadTasks(dir);
      expect(errors).toEqual([expect.stringMatching(/^e\.yaml: YAML 解析失败/)]);
      const v = validateTasks(tasks, generateDataset());
      expect(v).toContain("任务数应为 20，实际为 4");
      expect(v).toContain("aggregate 类任务应为 8 个，实际为 1");
      expect(v).toContain("a.yaml: mustMention 的 opp_003 对 ou_rep_zhang 不可见");
      expect(v).toContain("b.yaml: ou_rep_li 无权使用 team 视角，聚合任务无法给出期望值");
      expect(v).toContain('c.yaml: 文件名与 id "other" 不一致');
      expect(v).toContain("d.yaml: actor ou_nobody 不在数据集用户中");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
