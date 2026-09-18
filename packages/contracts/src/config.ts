// @kaidan/contracts — config.ts（冻结；loadConfig 由 T0 实现）
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ErrorCode, KaidanError } from "./errors.js";
import { Id, Role } from "./rom.js";

export const KaidanConfig = z.object({
  tenantId: Id,
  timezone: z.string().min(1), // "Asia/Shanghai"
  llm: z.object({
    kind: z.enum(["openai_compatible", "scripted"]),
    baseURL: z.string().url().optional(), // 如 https://dashscope.aliyuncs.com/compatible-mode/v1
    model: z.string().optional(),
    apiKeyEnv: z.string().optional(), // 从环境变量读取密钥，配置文件里不放密钥
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    disclosure: z.object({
      providerName: z.string(),
      modelName: z.string(),
      filingNo: z.string().optional(),
    }),
  }),
  adapter: z.object({
    kind: z.enum(["mock", "bitable"]),
    mock: z.object({ datasetPath: z.string() }).optional(),
    bitable: z
      .object({
        appToken: z.string().min(1),
        auth: z.enum(["tenant"]), // P1 再加 "user"（用户授权，权限由飞书执行）
        mappingPath: z.string(),
      })
      .optional(),
  }),
  feishu: z
    .object({
      appIdEnv: z.string(),
      appSecretEnv: z.string(),
      domain: z.enum(["feishu", "lark"]),
    })
    .optional(),
  governance: z.object({
    dbPath: z.string(),
    proposalTtlMinutes: z.number().int().positive(),
  }),
  risk: z.object({
    staleDays: z.number().int().positive(),
    stuckDays: z.number().int().positive(),
    soonDays: z.number().int().positive(),
    requiredQualificationKeys: z.array(z.string()).min(1),
  }),
  users: z.array(
    z.object({
      openId: Id,
      displayName: z.string(),
      roles: z.array(Role).min(1),
      managerOpenId: Id.optional(),
      scheduled: z.boolean().optional(), // 是否接收晨报/周报
    }),
  ),
  schedules: z
    .object({
      dailyBrief: z.string(), // cron，时区 = timezone，如 "30 8 * * 1-5"
      weeklyReview: z.string(), // 如 "0 17 * * 5"
    })
    .optional(),
  skillsDir: z.string().optional(), // 缺省用 @kaidan/skills 导出的 SKILLS_DIR
});
export type KaidanConfig = z.infer<typeof KaidanConfig>;

/**
 * 读取 YAML 配置：
 *  - zod 校验失败 → KaidanError(CONFIG)，message 含字段路径
 *  - 相对路径字段（adapter.mock.datasetPath / adapter.bitable.mappingPath / governance.dbPath（非 :memory:）/ skillsDir）
 *    解析为相对于配置文件所在目录的绝对路径
 *  - adapter.kind 与对应子配置必须同时存在，否则 CONFIG
 */
export async function loadConfig(path: string): Promise<KaidanConfig> {
  const text = await readFile(path, "utf8");
  const parsed = KaidanConfig.safeParse(parse(text));
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new KaidanError(ErrorCode.CONFIG, `配置无效：${where}`);
  }
  const cfg = parsed.data;
  if (cfg.adapter.kind === "mock" && !cfg.adapter.mock) throw new KaidanError(ErrorCode.CONFIG, "adapter.mock 缺失");
  if (cfg.adapter.kind === "bitable" && !cfg.adapter.bitable)
    throw new KaidanError(ErrorCode.CONFIG, "adapter.bitable 缺失");
  const base = dirname(resolve(path));
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  if (cfg.adapter.mock) cfg.adapter.mock.datasetPath = abs(cfg.adapter.mock.datasetPath);
  if (cfg.adapter.bitable) cfg.adapter.bitable.mappingPath = abs(cfg.adapter.bitable.mappingPath);
  if (cfg.governance.dbPath !== ":memory:") cfg.governance.dbPath = abs(cfg.governance.dbPath);
  if (cfg.skillsDir) cfg.skillsDir = abs(cfg.skillsDir);
  return cfg;
}
