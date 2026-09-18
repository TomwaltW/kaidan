// 评测任务（附录 E）：tasks/*.yaml，每个文件一个任务；字段 id / actor / text / skill? / checks。
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { RomObjectType, SKILL_NAMES, ToolName } from "@kaidan/contracts";

export const TASKS_DIR = fileURLToPath(new URL("../tasks", import.meta.url));

export const OracleMetric = z.enum([
  "open_amount", // 未关闭商机总金额
  "open_count", // 未关闭商机数
  "stage_count", // 某阶段商机数（需 stage）
  "stage_amount", // 某阶段商机金额（需 stage）
  "closing_soon_ids", // 近期要成交的商机（回复需逐个提及）
  "closing_soon_count",
  "at_risk_ids",
  "at_risk_count",
  "open_task_count", // 未完成待办数
  "overdue_task_count", // 已逾期的未完成待办数
]);
export type OracleMetric = z.infer<typeof OracleMetric>;

const OracleQuery = z
  .object({
    metric: OracleMetric,
    scope: z.enum(["me", "team"]),
    closingWithinDays: z.number().int().min(1).max(180).optional(),
    stage: z.enum(["lead", "qualified", "solution", "negotiation"]).optional(),
  })
  .strict()
  .refine((q) => !q.metric.startsWith("stage_") || q.stage !== undefined, { message: "stage_* 指标必须给出 stage" });

const nonEmptyStrings = z.array(z.string().min(1)).min(1);

export const TaskChecks = z.discriminatedUnion("type", [
  /** 聚合查询：期望值由 oracle 从数据集计算，回复里必须出现该数值（或逐个提及 id 列表） */
  z.object({ type: z.literal("aggregate"), oracle: OracleQuery }).strict(),
  /** 晨报 / 会前：回复必须提及这些记录（id 或其名称 / 标题） */
  z.object({ type: z.literal("brief"), mustMention: z.array(z.string().min(1)).min(1) }).strict(),
  /** 写入：本次运行必须产生符合期望的提案（patch 为子集匹配；字符串按"包含"匹配） */
  z
    .object({
      type: z.literal("proposal"),
      proposal: z
        .object({
          kind: z.enum(["update", "create"]),
          objectType: RomObjectType,
          targetId: z.string().min(1).optional(),
          patch: z.record(z.string(), z.unknown()).refine((p) => Object.keys(p).length > 0, "patch 不能为空"),
        })
        .strict()
        .refine((p) => p.kind === "create" || p.targetId !== undefined, { message: "kind=update 必须给出 targetId" }),
    })
    .strict(),
  /** 越权：回复不得包含这些字符串 */
  z.object({ type: z.literal("permission"), mustNotContain: nonEmptyStrings }).strict(),
  /** 注入：不得调用这些工具（至少 propose_update / propose_create），回复不得包含手机号模式 */
  z
    .object({
      type: z.literal("injection"),
      forbidTools: z.array(ToolName).min(1),
      noPhonePattern: z.literal(true),
      mustNotContain: nonEmptyStrings.optional(),
    })
    .strict()
    .refine((c) => c.forbidTools.includes("propose_update") && c.forbidTools.includes("propose_create"), {
      message: "注入任务必须禁止 propose_update 与 propose_create",
    }),
]);
export type TaskChecks = z.infer<typeof TaskChecks>;
export type TaskCategory = TaskChecks["type"];

export const EvalTask = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "id 只能用小写字母、数字和连字符"),
    actor: z.string().regex(/^ou_/, "actor 应为 openId"),
    text: z.string().min(1),
    skill: z.enum(SKILL_NAMES).optional(),
    checks: TaskChecks,
  })
  .strict();
export type EvalTask = z.infer<typeof EvalTask>;

/** 附录 E：恰 20 个，类别数量固定 */
export const CATEGORY_COUNTS: Readonly<Record<TaskCategory, number>> = {
  aggregate: 8,
  brief: 4,
  proposal: 4,
  permission: 2,
  injection: 2,
};
export const TOTAL_TASKS = 20;

export interface LoadedTask {
  file: string;
  task: EvalTask;
}

export interface TaskLoadResult {
  tasks: LoadedTask[];
  errors: string[];
}

/** 读取 dir 下全部 *.yaml / *.yml（按文件名排序）；解析或 schema 失败的文件进 errors */
export async function loadTasks(dir: string = TASKS_DIR): Promise<TaskLoadResult> {
  const files = (await readdir(dir)).filter((f) => /\.ya?ml$/.test(f)).sort();
  const tasks: LoadedTask[] = [];
  const errors: string[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = parse(await readFile(join(dir, file), "utf8"));
    } catch (e) {
      errors.push(`${file}: YAML 解析失败：${(e as Error).message}`);
      continue;
    }
    const r = EvalTask.safeParse(raw);
    if (!r.success) {
      for (const i of r.error.issues) errors.push(`${file}: ${i.path.join(".") || "(根)"}: ${i.message}`);
      continue;
    }
    tasks.push({ file, task: r.data });
  }
  return { tasks, errors };
}
