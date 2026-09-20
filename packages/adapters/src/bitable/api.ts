// 多维表格 API 的内部接口：适配器只依赖 BitableApi，测试用 fake 实现，不联网。
// SDK 实现（createSdkBitableApi）的方法名与参数以 node_modules 中 @larksuiteoapi/node-sdk@1.74.0 的类型定义为准：
//   client.bitable.appTableRecord.list / create / update、client.bitable.appTable.list、client.bitable.appTableField.list
//   client.auth.tenantAccessToken.internal（doctor --online 的凭证自检）
// 以上调用尚未真机验证（见 T1 / T8 回执）。
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
  listRecords(tableId: string, pageToken?: string, pageSize?: number): Promise<BitablePage<BitableRecord>>;
  createRecord(tableId: string, fields: Record<string, unknown>): Promise<BitableRecord>;
  updateRecord(tableId: string, recordId: string, fields: Record<string, unknown>): Promise<BitableRecord>;
  listTables(pageToken?: string): Promise<BitablePage<BitableTable>>;
  listFields(tableId: string, pageToken?: string): Promise<BitablePage<BitableField>>;
}

/** BitableApi 抛出的错误：code = 飞书业务错误码，status = HTTP 状态码，logId = 飞书 log_id（报障时飞书要这个） */
export class BitableApiError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly status?: number,
    readonly logId?: string,
  ) {
    super(message);
    this.name = "BitableApiError";
  }
}

/** 把飞书错误整理成人能看懂的一行：code / msg / log_id 都带上，频控翻译成大白话 */
export function describeBitableError(e: unknown): string {
  if (!(e instanceof BitableApiError)) return e instanceof Error ? e.message : String(e);
  const parts: string[] = [e.message];
  if (isRateLimited(e)) parts.push("触发频控，稍后重试");
  if (e.code !== undefined) parts.push(`code ${e.code}`);
  if (e.status !== undefined) parts.push(`HTTP ${e.status}`);
  parts.push(e.logId ? `log_id ${e.logId}` : "log_id 未返回");
  return parts.join("；");
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
  /** 飞书在业务错误（HTTP 200、code≠0）时把 log_id 放在响应体里 */
  log_id?: string;
  error?: { log_id?: string };
}

/** log_id 在响应体里的位置飞书并不统一：error.log_id / 顶层 log_id / 响应头 x-tt-logid，逐个试 */
function pickLogId(body: unknown, headers?: unknown): string | undefined {
  const b = body as { log_id?: unknown; error?: { log_id?: unknown } } | undefined;
  const fromBody = b?.error?.log_id ?? b?.log_id;
  if (typeof fromBody === "string" && fromBody) return fromBody;
  const h = headers as Record<string, unknown> | undefined;
  const fromHeader = h?.["x-tt-logid"] ?? h?.["X-Tt-Logid"];
  if (typeof fromHeader === "string" && fromHeader) return fromHeader;
  return undefined;
}

function unwrap<D>(resp: SdkResp<D>, what: string): D {
  if (resp.code !== undefined && resp.code !== 0) {
    throw new BitableApiError(`${what} 失败：${resp.msg ?? ""}（code ${resp.code}）`, resp.code, undefined, pickLogId(resp));
  }
  return (resp.data ?? {}) as D;
}

/** SDK 在 HTTP 非 2xx 时抛 axios 风格错误；把状态码与飞书错误码取出来交给 withRetry 判断 */
function normalizeSdkError(e: unknown, what: string): never {
  if (e instanceof BitableApiError) throw e;
  const err = e as {
    response?: { status?: number; headers?: unknown; data?: { code?: number; msg?: string } };
    message?: string;
  };
  throw new BitableApiError(
    `${what} 失败：${err.response?.data?.msg ?? err.message ?? String(e)}`,
    err.response?.data?.code,
    err.response?.status,
    pickLogId(err.response?.data, err.response?.headers),
  );
}

type SdkFields = Record<string, never>;

export interface BitableCredentials {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
}

export interface SdkBitableOptions {
  appToken: string;
  /** 首次调用时才解析凭据（构造时不读密钥、不联网） */
  credentials: () => BitableCredentials;
}

const PAGE_SIZE = 500;

function createLarkClient(cred: BitableCredentials, opts: { disableTokenCache?: boolean } = {}): lark.Client {
  return new lark.Client({
    appId: cred.appId,
    appSecret: cred.appSecret,
    domain: cred.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: lark.LoggerLevel.error,
    ...(opts.disableTokenCache ? { disableTokenCache: true } : {}),
  });
}

/**
 * 用应用身份换一次 tenant_access_token，验证 appId / appSecret 对不对（doctor --online 第 1 项）。
 * 只回有效期，token 本身既不返回也不打印。尚未真机验证。
 */
export function createSdkTenantTokenProbe(credentials: () => BitableCredentials): () => Promise<{ expireSeconds?: number }> {
  return async () => {
    const cred = credentials(); // 凭据缺失 → CONFIG，不能被当成上游错误
    // disableTokenCache：SDK 的 Client.formatPayload（lib/index.js:100760）默认会在每个请求前
    // 先经 TokenManager 换一次 tenant_access_token —— 对「换 token」这个接口本身是多余的一跳，
    // 而且凭据错时错误会在 TokenManager 里抛出、丢掉 HTTP 响应（拿不到 code / log_id）。
    // 关掉它，请求裸发，飞书的 code / msg / log_id 才能原样带回给用户。
    const client = createLarkClient(cred, { disableTokenCache: true });
    let raw: unknown;
    try {
      raw = await client.auth.tenantAccessToken.internal({
        data: { app_id: cred.appId, app_secret: cred.appSecret },
      });
    } catch (e) {
      normalizeSdkError(e, "换取 tenant_access_token");
    }
    // 这个接口按开放平台文档把 expire 放在响应体顶层，SDK 的类型里却写在 data 下 —— 两处都读，哪边有算哪边
    const resp = raw as { code?: number; msg?: string; expire?: number; data?: { expire?: number } };
    if (resp.code !== undefined && resp.code !== 0) {
      throw new BitableApiError(
        `换取 tenant_access_token 失败：${resp.msg ?? ""}（code ${resp.code}）`,
        resp.code,
        undefined,
        pickLogId(resp),
      );
    }
    const expire = resp.expire ?? resp.data?.expire;
    return expire !== undefined ? { expireSeconds: expire } : {};
  };
}

export function createSdkBitableApi(opts: SdkBitableOptions): BitableApi {
  let client: lark.Client | undefined;
  const c = (): lark.Client => {
    if (!client) client = createLarkClient(opts.credentials());
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
    async listRecords(tableId, pageToken, pageSize) {
      const data = await call("读取记录", (client) =>
        client.bitable.appTableRecord.list({
          path: { app_token, table_id: tableId },
          params: {
            page_size: pageSize ?? PAGE_SIZE,
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
