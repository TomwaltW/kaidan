// 定时任务：按 config.schedules 与 config.timezone 用 croner 注册晨报 / 周报。
import { Cron } from "croner";
import type { KaidanConfig } from "@kaidan/contracts";

export type ScheduleKind = "daily_brief" | "weekly_review";

export interface ScheduleOptions {
  /** 测试用：创建后不自动触发 */
  paused?: boolean;
  /** croner 的任务名是进程级全局唯一的；同进程多个实例时用它区分 */
  nameSuffix?: string;
  onError?: (kind: ScheduleKind, e: unknown) => void;
}

/** config.schedules 缺失 → 不注册任何任务 */
export function createSchedules(
  config: KaidanConfig,
  run: (kind: ScheduleKind) => Promise<unknown>,
  opts: ScheduleOptions = {},
): Cron[] {
  const s = config.schedules;
  if (!s) return [];
  const entries: [ScheduleKind, string][] = [
    ["daily_brief", s.dailyBrief],
    ["weekly_review", s.weeklyReview],
  ];
  return entries.map(
    ([kind, pattern]) =>
      new Cron(
        pattern,
        {
          name: opts.nameSuffix ? `kaidan:${kind}:${opts.nameSuffix}` : `kaidan:${kind}`,
          timezone: config.timezone,
          paused: opts.paused ?? false,
          protect: true, // 上一轮还没跑完时跳过本轮
          unref: true,
        },
        async () => {
          try {
            await run(kind);
          } catch (e) {
            opts.onError?.(kind, e);
          }
        },
      ),
  );
}
