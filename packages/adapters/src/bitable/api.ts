// 多维表格 API 的内部接口：适配器只依赖 BitableApi，测试用 fake 实现，不联网。
// SDK 实现（createSdkBitableApi）的方法名与参数以 node_modules 中 @larksuiteoapi/node-sdk@1.74.0 的类型定义为准：
//   client.bitable.appTableRecord.list / create / update、client.bitable.appTable.list、client.bitable.appTableField.list
// 以上调用尚未真机验证（见 T1 回执）。
import * as lark from "@larksuiteoapi/node-sdk";
import { ErrorCode, KaidanError } from "@kaidan/contracts";

export interface BitableRecord {
  record_id: string;
  fields: Record<string, unknown>;
  created_time?: number;
  last_modified_time?: number;
}

export interface BitablePage<T> {
  items: T[];
  pageToken?: string;
  hasMore: boolean;
}

export interface BitableTable {
  table_id: string;
  name: string;
}

export interface BitableField {
  field_name: string;
  ui_type?: string;
  type?: number;
  property?: { options?: { name?: string }[] } | null;
}

export interface BitableApi {
  listRecords(tableId: string, pageToken?: string): Promise<BitablePage<BitableRecord>>;
  createRecord(tableId: string, fields: Record<string, unknown>): Promise<BitableRecord>;
  updateRecord(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<BitableRecord>;
  listTables(pageToken?: string): Promise<BitablePage<BitableTable>>;
  listFields(tableId: string, pageToken?: string): Promise<BitablePage<BitableField>>;
}

/** BitableApi 抛出的错误：code = 飞书业务错误码，status = HTTP 状态码 */
export class BitableApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BitableApiError";
  }
}

/** 飞书频控错误码（开放平台通用：99991400 应用频控；1254290 多维表格请求过快） */
const RATE_LIMIT_CODES = new Set([99991400, 1254290]);

export function isRateLimited(e: unknown): boolean {
  if (e instanceof BitableApiError) return e.status === 429 || (e.code !== undefined && RATE_LIMIT_CODES.has(e.code));
  return false;
}

export const RETRY_DELAYS_MS = [500, 1000, 2000] as const;

/**
 * 频控重试：429 / 频控码最多重试 3 次（0.5s / 1s / 2s），仍失败 → RATE_LIMITED；
 * 其他 BitableApiError → UPSTREAM；KaidanError 原样抛出。
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (isRateLimited(e)) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined) {
          throw new KaidanError(ErrorCode.RATE_LIMITED, "飞书多维表格接口频控，请稍后再试", { retryable: true, cause: e });
        }
        await sleep(delay);
        continue;
      }
      if (e instanceof KaidanError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new KaidanError(ErrorCode.UPSTREAM, `飞书多维表格接口出错：${msg}`, { cause: e });
    }
  }
}

// ---------------------------------------------------------------- SDK 实现

interface SdkResp<D> {
  code?: number;
  msg?: string;
  data?: D;
}

function unwrap<D>(resp: SdkResp<D>, what: string): D {
  if (resp.code !== undefined && resp.code !== 0) {
    throw new BitableApiError(`${what} 失败：${resp.msg ?? ""}（code ${resp.code}）`, resp.code);
  }
  return (resp.data ?? {}) as D;
}

/** SDK 在 HTTP 非 2xx 时抛 axios 风格错误；把状态码与飞书错误码取出来交给 withRetry 判断 */
function normalizeSdkError(e: unknown, what: string): never {
  if (e instanceof BitableApiError) throw e;
  const err = e as { response?: { status?: number; data?: { code?: number; msg?: string } }; message?: string };
  throw new BitableApiError(
    `${what} 失败：${err.response?.data?.msg ?? err.message ?? String(e)}`,
    err.response?.data?.code,
    err.response?.status,
  );
}

type SdkFields = Record<string, never>;

export interface SdkBitableOptions {
  appToken: string;
  /** 首次调用时才解析凭据（构造时不读密钥、不联网） */
  credentials: () => { appId: string; appSecret: string; domain: "feishu" | "lark" };
}

const PAGE_SIZE = 500;

export function createSdkBitableApi(opts: SdkBitableOptions): BitableApi {
  let client: lark.Client | undefined;
  const c = (): lark.Client => {
    if (!client) {
      const cred = opts.credentials();
      client = new lark.Client({
        appId: cred.appId,
        appSecret: cred.appSecret,
        domain: cred.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
        loggerLevel: lark.LoggerLevel.error,
      });
    }
    return client;
  };
  const app_token = opts.appToken;

  const call = async <D>(what: string, fn: (client: lark.Client) => Promise<SdkResp<D>>): Promise<D> => {
    const client = c(); // 凭据缺失 → CONFIG，不能被当成上游错误
    let resp: SdkResp<D>;
    try {
      resp = await fn(client);
    } catch (e) {
      normalizeSdkError(e, what);
    }
    return unwrap(resp, what);
  };

  const toRecord = (r: { record_id?: string; fields: unknown; created_time?: number; last_modified_time?: number }): BitableRecord => {
    const rec: BitableRecord = { record_id: r.record_id ?? "", fields: (r.fields ?? {}) as Record<string, unknown> };
    if (r.created_time !== undefined) rec.created_time = r.created_time;
    if (r.last_modified_time !== undefined) rec.last_modified_time = r.last_modified_time;
    return rec;
  };

  return {
    async listRecords(tableId, pageToken) {
      const data = await call("读取记录", (client) =>
        client.bitable.appTableRecord.list({
          path: { app_token, table_id: tableId },
          params: {
            page_size: PAGE_SIZE,
            user_id_type: "open_id",
            automatic_fields: true,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        }),
      );
      return {
        items: (data.items ?? []).map(toRecord),
        hasMore: data.has_more ?? false,
        ...(data.page_token ? { pageToken: data.page_token } : {}),
      };
    },

    async createRecord(tableId, fields) {
      const data = await call("新增记录", (client) =>
        client.bitable.appTableRecord.create({
          path: { app_token, table_id: tableId },
          params: { user_id_type: "open_id" },
          data: { fields: fields as SdkFields },
        }),
      );
      if (!data.record) throw new BitableApiError("新增记录失败：响应里没有 record");
      return toRecord(data.record);
    },

    async updateRecord(tableId, recordId, fields) {
      const data = await call("更新记录", (client) =>
        client.bitable.appTableRecord.update({
          path: { app_token, table_id: tableId, record_id: recordId },
          params: { user_id_type: "open_id" },
          data: { fields: fields as SdkFields },
        }),
      );
      if (!data.record) throw new BitableApiError("更新记录失败：响应里没有 record");
      return toRecord(data.record);
    },

    async listTables(pageToken) {
      const data = await call("列出数据表", (client) =>
        client.bitable.appTable.list({
          path: { app_token },
          params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
        }),
      );
      return {
        items: (data.items ?? []).map((t) => ({ table_id: t.table_id ?? "", name: t.name ?? "" })),
        hasMore: data.has_more ?? false,
        ...(data.page_token ? { pageToken: data.page_token } : {}),
      };
    },

    async listFields(tableId, pageToken) {
      const data = await call("列出字段", (client) =>
        client.bitable.appTableField.list({
          path: { app_token, table_id: tableId },
          params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
        }),
      );
      return {
        items: (data.items ?? []).map((f) => {
          const field: BitableField = { field_name: f.field_name };
          if (f.ui_type !== undefined) field.ui_type = f.ui_type;
          if (f.type !== undefined) field.type = f.type;
          const options = f.property?.options;
          if (options) field.property = { options: options.map((o) => (o.name !== undefined ? { name: o.name } : {})) };
          return field;
        }),
        hasMore: data.has_more ?? false,
        ...(data.page_token ? { pageToken: data.page_token } : {}),
      };
    },
  };
}
