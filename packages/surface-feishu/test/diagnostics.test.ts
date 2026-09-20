// 分级日志与飞书错误码翻译：真机上出错时，日志里必须同时有调用名、code、msg、log_id。
import { describe, expect, it } from "vitest";
import { ErrorCode, KaidanError, isKaidanError } from "@kaidan/contracts";
import {
  DEFAULT_LOG_LEVEL,
  FEISHU_CALLS,
  FEISHU_CODE_HINTS,
  buildNoticeCard,
  createLarkClient,
  createLogger,
  createSdkLogger,
  describeError,
  describeFeishuFailure,
  extractFeishuError,
  resolveLogLevel,
  type LarkImApi,
} from "../src/index.js";

function collector() {
  const lines: string[] = [];
  return { lines, sink: (...args: unknown[]) => void lines.push(args.map(String).join(" ")), text: () => lines.join("\n") };
}

describe("分级日志", () => {
  it("默认 info：debug 不出现，info/warn/error 出现", () => {
    const c = collector();
    const log = createLogger({ sink: c.sink, level: "info" });
    log.debug("看不见的细节");
    log.info("看得见");
    log.warn("警告");
    log.error("错误");
    expect(c.text()).not.toContain("看不见的细节");
    expect(c.lines).toHaveLength(3);
    expect(c.lines[0]).toBe("[surface-feishu][info] 看得见");
  });

  it("KAIDAN_LOG_LEVEL=debug 打开详细模式；不认识的值退回 info", () => {
    expect(resolveLogLevel({ KAIDAN_LOG_LEVEL: "debug" })).toBe("debug");
    expect(resolveLogLevel({ KAIDAN_LOG_LEVEL: " DEBUG " })).toBe("debug");
    expect(resolveLogLevel({ KAIDAN_LOG_LEVEL: "verbose" })).toBe(DEFAULT_LOG_LEVEL);
    expect(resolveLogLevel({})).toBe("info");

    const c = collector();
    createLogger({ sink: c.sink, env: { KAIDAN_LOG_LEVEL: "debug" } }).debug("细节");
    expect(c.text()).toContain("[surface-feishu][debug] 细节");
  });

  it("describeError：KaidanError 带 code；普通 Error 带 name；默认不带堆栈", () => {
    expect(describeError(new KaidanError(ErrorCode.CONFLICT, "记录已被他人修改"))).toBe(
      `[${ErrorCode.CONFLICT}] 记录已被他人修改`,
    );
    expect(describeError(new TypeError("x is not a function"))).toBe("TypeError: x is not a function");
    expect(describeError(new TypeError("boom"))).not.toContain("at ");
  });

  it("SDK 自己的 info 日志降到 debug，默认不刷屏；error 照常出", () => {
    const c = collector();
    const sdk = createSdkLogger(createLogger({ sink: c.sink, level: "info" }));
    sdk.info("[ws] pulling connect config");
    expect(c.lines).toHaveLength(0);
    sdk.error("[ws] handshake failed");
    expect(c.text()).toContain("[lark] [ws] handshake failed");
  });
});

describe("飞书错误码翻译", () => {
  it("返回体里的 code / msg / log_id 都能抠出来（error.log_id 优先）", () => {
    const info = extractFeishuError({
      code: 230020,
      msg: "bot is not in the chat",
      error: { log_id: "0192abc-logid" },
    });
    expect(info).toMatchObject({ code: 230020, msg: "bot is not in the chat", logId: "0192abc-logid" });
    expect(extractFeishuError({ code: 1, log_id: "顶层" }).logId).toBe("顶层");
    expect(extractFeishuError({ code: 1, data: { log_id: "data 里" } }).logId).toBe("data 里");
  });

  it("axios 错误：response.data 里的 code/msg，response.headers 里的 x-tt-logid，以及 http 状态", () => {
    const info = extractFeishuError({
      response: {
        status: 400,
        data: { code: 99991400, msg: "request trigger frequency limit" },
        headers: { "x-tt-logid": "hdr-logid-1" },
      },
    });
    expect(info).toMatchObject({ code: 99991400, httpStatus: 400, logId: "hdr-logid-1" });
  });

  it("99991400 → 频控、稍后重试；230020 → 检查应用可用范围与发布版本", () => {
    const limited = describeFeishuFailure(FEISHU_CALLS.createMessage, {
      code: 99991400,
      msg: "frequency limit",
      error: { log_id: "L1" },
    });
    expect(limited).toContain("im.v1.message.create（回消息）");
    expect(limited).toContain("code=99991400");
    expect(limited).toContain("log_id=L1");
    expect(limited).toContain("频控");
    expect(limited).toContain("稍后重试");

    const notInChat = describeFeishuFailure(FEISHU_CALLS.createMessage, { code: 230020, msg: "x" });
    expect(notInChat).toContain("机器人没在会话里");
    expect(notInChat).toContain("检查应用可用范围与发布版本");
    expect(FEISHU_CODE_HINTS.has(99991400) && FEISHU_CODE_HINTS.has(230020)).toBe(true);
  });

  it("没见过的码不猜含义：原样打印 code + msg + log_id，不给建议", () => {
    const line = describeFeishuFailure(FEISHU_CALLS.patchMessage, {
      code: 234567,
      msg: "something new",
      error: { log_id: "L9" },
    });
    expect(line).toContain("im.v1.message.patch（换卡）");
    expect(line).toContain("code=234567 msg=something new log_id=L9");
    expect(line).not.toContain("建议");
  });

  it("log_id 拿不到时写明「未返回」，不静默；纯网络错误带上原始错误", () => {
    expect(describeFeishuFailure(FEISHU_CALLS.botInfo, { code: 99991663, msg: "no permission" })).toContain(
      "log_id=(未返回)",
    );
    const net = describeFeishuFailure(FEISHU_CALLS.botInfo, new Error("ECONNRESET"));
    expect(net).toContain("bot/v3/info（读机器人信息）");
    expect(net).toContain("code=(未返回)");
    expect(net).toContain("原始错误=Error: ECONNRESET");
  });
});

class FailingImApi implements LarkImApi {
  constructor(private readonly steps: unknown[]) {}
  private next(): Promise<never> | Promise<Record<string, unknown>> {
    const s = this.steps.shift() ?? { code: 0, data: { message_id: "om_ok" } };
    if (s instanceof Error || (typeof s === "object" && s !== null && "response" in s)) return Promise.reject(s);
    return Promise.resolve(s as Record<string, unknown>);
  }
  createMessage() {
    return this.next();
  }
  patchMessage() {
    return this.next();
  }
}

describe("createLarkClient 的失败日志", () => {
  it("发消息失败 → 日志里同时有调用名、code、msg、log_id；原始错误照旧抛出", async () => {
    const c = collector();
    const api = new FailingImApi([{ code: 230002, msg: "bot not in chat", error: { log_id: "LOGID-230002" } }]);
    const client = createLarkClient(api, { sleep: async () => {}, logger: createLogger({ sink: c.sink, level: "info" }) });
    let err: unknown;
    try {
      await client.sendCard({ chatId: "oc_1" }, buildNoticeCard("你好"));
    } catch (e) {
      err = e;
    }
    expect(isKaidanError(err) && err.code).toBe(ErrorCode.UPSTREAM);
    expect(c.text()).toContain("im.v1.message.create（回消息）");
    expect(c.text()).toContain("code=230002");
    expect(c.text()).toContain("msg=bot not in chat");
    expect(c.text()).toContain("log_id=LOGID-230002");
  });

  it("换卡失败 → 调用名是 im.v1.message.patch（换卡）", async () => {
    const c = collector();
    const api = new FailingImApi([{ code: 232001, msg: "message not found", error: { log_id: "LOGID-PATCH" } }]);
    const client = createLarkClient(api, { sleep: async () => {}, logger: createLogger({ sink: c.sink, level: "info" }) });
    await expect(client.updateCard("om_9", buildNoticeCard("已写入 CRM"))).rejects.toMatchObject({
      code: ErrorCode.UPSTREAM,
    });
    expect(c.text()).toContain("im.v1.message.patch（换卡）");
    expect(c.text()).toContain("log_id=LOGID-PATCH");
  });

  it("频控重试：每次失败各打一行，能看出重试了几次", async () => {
    const c = collector();
    const limited = () => ({ response: { status: 400, data: { code: 99991400, msg: "frequency limit" } } });
    const api = new FailingImApi([limited(), limited(), { code: 0, data: { message_id: "om_3" } }]);
    const client = createLarkClient(api, { sleep: async () => {}, logger: createLogger({ sink: c.sink, level: "info" }) });
    expect(await client.sendCard({ chatId: "oc" }, buildNoticeCard("x"))).toEqual({ messageId: "om_3" });
    expect(c.lines.filter((l) => l.includes("code=99991400"))).toHaveLength(2);
    expect(c.text()).toContain("稍后重试");
  });
});
