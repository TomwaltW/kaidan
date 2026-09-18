// @kaidan/adapters —— Mock 适配器、飞书多维表格适配器、日程提供者与 createAdapter（spec 3.2 / 附录 C）。
import { readFile } from "node:fs/promises";
import { ErrorCode, KaidanError, RomDataset, type CreateAdapter } from "@kaidan/contracts";
import { createSdkBitableApi } from "./bitable/api.js";
import { createBitableAdapter, loadBitableMapping } from "./bitable/adapter.js";
import { createMockAdapter } from "./mock.js";

export { createMockAdapter } from "./mock.js";
export { createMockContextProvider, createNullContextProvider } from "./context.js";
export { createBitableAdapter, loadBitableMapping, type BitableAdapterOptions } from "./bitable/adapter.js";
export {
  BitableApiError,
  type BitableApi,
  type BitableField,
  type BitablePage,
  type BitableRecord,
  type BitableTable,
} from "./bitable/api.js";
export { maskPhone } from "./bitable/convert.js";

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

export const createAdapter: CreateAdapter = async (cfg, opts) => {
  if (cfg.adapter.kind === "mock") {
    if (opts?.dataset) return createMockAdapter(opts.dataset);
    if (!cfg.adapter.mock) throw new KaidanError(ErrorCode.CONFIG, "adapter.mock 缺失");
    return createMockAdapter(await readDataset(cfg.adapter.mock.datasetPath));
  }

  const b = cfg.adapter.bitable;
  if (!b) throw new KaidanError(ErrorCode.CONFIG, "adapter.bitable 缺失");
  const mapping = await loadBitableMapping(b.mappingPath);
  const api = createSdkBitableApi({
    appToken: b.appToken,
    // 构造时不读密钥、不联网；首次调用接口时才解析凭据
    credentials: () => {
      const f = cfg.feishu;
      if (!f) throw new KaidanError(ErrorCode.CONFIG, "adapter.kind=bitable 需要配置 feishu（appIdEnv / appSecretEnv）");
      const appId = process.env[f.appIdEnv];
      const appSecret = process.env[f.appSecretEnv];
      if (!appId) throw new KaidanError(ErrorCode.CONFIG, `环境变量 ${f.appIdEnv} 未设置（feishu.appIdEnv）`);
      if (!appSecret) throw new KaidanError(ErrorCode.CONFIG, `环境变量 ${f.appSecretEnv} 未设置（feishu.appSecretEnv）`);
      return { appId, appSecret, domain: f.domain };
    },
  });
  return createBitableAdapter({ mapping, api, timezone: cfg.timezone });
};
