// @kaidan/adapters —— Mock 适配器、飞书多维表格适配器、日程提供者与 createAdapter（spec 3.2 / 附录 C）。
import { readFile } from "node:fs/promises";
import { ErrorCode, KaidanError, RomDataset, type CreateAdapter, type KaidanConfig } from "@kaidan/contracts";
import { createSdkBitableApi, createSdkTenantTokenProbe, type BitableApi, type BitableCredentials } from "./bitable/api.js";
import { createBitableAdapter, loadBitableMapping } from "./bitable/adapter.js";
import { runBitablePrecheck, type PrecheckReport, type TenantTokenProbe } from "./bitable/precheck.js";
import { createMockAdapter } from "./mock.js";

export { createMockAdapter } from "./mock.js";
export { createMockContextProvider, createNullContextProvider } from "./context.js";
export { createBitableAdapter, loadBitableMapping, type BitableAdapterOptions } from "./bitable/adapter.js";
export {
  BitableApiError,
  describeBitableError,
  type BitableApi,
  type BitableCredentials,
  type BitableField,
  type BitablePage,
  type BitableRecord,
  type BitableTable,
} from "./bitable/api.js";
export { maskPhone } from "./bitable/convert.js";
export {
  runBitablePrecheck,
  type CheckLine,
  type CheckStatus,
  type PrecheckReport,
  type TenantTokenProbe,
} from "./bitable/precheck.js";

async function readDataset(path: string): Promise<RomDataset> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e) {
    throw new KaidanError(ErrorCode.CONFIG, `无法读取 Mock 数据集 ${path}：${(e as Error).message}`, { cause: e });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new KaidanError(ErrorCode.CONFIG, `Mock 数据集 ${path} 不是合法的 JSON`, { cause: e });
  }
  const r = RomDataset.safeParse(json);
  if (!r.success) {
    const where = r.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new KaidanError(ErrorCode.CONFIG, `Mock 数据集 ${path} 不合法：${where}`);
  }
  return r.data;
}

/**
 * 从配置 + 环境变量取飞书应用凭据。调用时才读 env（构造时不读密钥、不联网）；
 * createAdapter 与 doctor --online 共用这一份，错误提示只有一处。
 */
export function bitableCredentials(cfg: KaidanConfig): () => BitableCredentials {
  return () => {
    const f = cfg.feishu;
    if (!f) throw new KaidanError(ErrorCode.CONFIG, "adapter.kind=bitable 需要配置 feishu（appIdEnv / appSecretEnv）");
    const appId = process.env[f.appIdEnv];
    const appSecret = process.env[f.appSecretEnv];
    if (!appId) throw new KaidanError(ErrorCode.CONFIG, `环境变量 ${f.appIdEnv} 未设置（feishu.appIdEnv）`);
    if (!appSecret) throw new KaidanError(ErrorCode.CONFIG, `环境变量 ${f.appSecretEnv} 未设置（feishu.appSecretEnv）`);
    return { appId, appSecret, domain: f.domain };
  };
}

export interface BitableDoctorOverrides {
  /** 测试注入 fake，不联网 */
  api?: BitableApi;
  probeTenantToken?: TenantTokenProbe;
  env?: Record<string, string | undefined>;
}

/**
 * doctor --online 的多维表格侧只读预检（adapter.kind=bitable 时才有意义）。
 * 只发只读请求；调用方按 report.ok 决定退出码。
 */
export async function runBitableDoctor(cfg: KaidanConfig, overrides: BitableDoctorOverrides = {}): Promise<PrecheckReport> {
  const b = cfg.adapter.bitable;
  if (cfg.adapter.kind !== "bitable" || !b) {
    throw new KaidanError(ErrorCode.CONFIG, "runBitableDoctor 只能用于 adapter.kind=bitable 的配置");
  }
  const f = cfg.feishu;
  if (!f) throw new KaidanError(ErrorCode.CONFIG, "adapter.kind=bitable 需要配置 feishu（appIdEnv / appSecretEnv）");
  const mapping = await loadBitableMapping(b.mappingPath);
  const credentials = bitableCredentials(cfg);
  return runBitablePrecheck({
    mapping,
    api: overrides.api ?? createSdkBitableApi({ appToken: b.appToken, credentials }),
    timezone: cfg.timezone,
    appToken: b.appToken,
    credentials: { appIdEnv: f.appIdEnv, appSecretEnv: f.appSecretEnv },
    probeTenantToken: overrides.probeTenantToken ?? createSdkTenantTokenProbe(credentials),
    ...(overrides.env ? { env: overrides.env } : {}),
  });
}

export const createAdapter: CreateAdapter = async (cfg, opts) => {
  if (cfg.adapter.kind === "mock") {
    if (opts?.dataset) return createMockAdapter(opts.dataset);
    if (!cfg.adapter.mock) throw new KaidanError(ErrorCode.CONFIG, "adapter.mock 缺失");
    return createMockAdapter(await readDataset(cfg.adapter.mock.datasetPath));
  }

  const b = cfg.adapter.bitable;
  if (!b) throw new KaidanError(ErrorCode.CONFIG, "adapter.bitable 缺失");
  const mapping = await loadBitableMapping(b.mappingPath);
  // 构造时不读密钥、不联网；首次调用接口时才解析凭据
  const api = createSdkBitableApi({ appToken: b.appToken, credentials: bitableCredentials(cfg) });
  return createBitableAdapter({ mapping, api, timezone: cfg.timezone });
};
