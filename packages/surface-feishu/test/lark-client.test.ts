// 真实 LarkClientLike 的请求形状与频控重试（注入 sleep，不真的等待；fake SDK 层，不联网）。
import { describe, expect, it } from "vitest";
import { ErrorCode, KaidanError, isKaidanError } from "@kaidan/contracts";
import {
  RETRY_DELAYS_MS,
  buildNoticeCard,
  createLarkClient,
  isRateLimited,
  withRateLimitRetry,
  type LarkImApi,
} from "../src/index.js";

type Resp = Awaited<ReturnType<LarkImApi["createMessage"]>>;
type Step = Resp | Error | Record<string, unknown>;

class FakeImApi implements LarkImApi {
  readonly creates: Parameters<LarkImApi["createMessage"]>[0][] = [];
  readonly patches: Parameters<LarkImApi["patchMessage"]>[0][] = [];
  constructor(private steps: Step[]) {}
  private next(): Promise<Resp> {
    const s = this.steps.shift() ?? { code: 0, data: { message_id: "om_ok" } };
    if (s instanceof Error || "response" in s) return Promise.reject(s);
    return Promise.resolve(s as Resp);
  }
  createMessage(p: Parameters<LarkImApi["createMessage"]>[0]) {
    this.creates.push(p);
    return this.next();
  }
  patchMessage(p: Parameters<LarkImApi["patchMessage"]>[0]) {
    this.patches.push(p);
    return this.next();
  }
}

const axios429 = () => ({ response: { status: 429, data: {} } });
const axios400Limit = () => ({ response: { status: 400, data: { code: 99991400, msg: "request trigger frequency limit" } } });

function recorder() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe("createLarkClient", () => {
  it("sendCard：chatId → im.v1.message.create(receive_id_type=chat_id, msg_type=interactive, content=卡片 JSON)", async () => {
    const api = new FakeImApi([{ code: 0, data: { message_id: "om_1" } }]);
    const client = createLarkClient(api, { sleep: async () => {} });
    const card = buildNoticeCard("你好");
    expect(await client.sendCard({ chatId: "oc_1" }, card)).toEqual({ messageId: "om_1" });
    expect(api.creates[0]).toEqual({
      data: { receive_id: "oc_1", msg_type: "interactive", content: JSON.stringify(card.json) },
      params: { receive_id_type: "chat_id" },
    });
  });

  it("sendCard：openId → receive_id_type=open_id；updateCard → im.v1.message.patch", async () => {
    const api = new FakeImApi([]);
    const client = createLarkClient(api, { sleep: async () => {} });
    await client.sendCard({ openId: "ou_1" }, buildNoticeCard("x"));
    await client.updateCard("om_9", buildNoticeCard("已写入 CRM"));
    expect(api.creates[0]?.params).toEqual({ receive_id_type: "open_id" });
    expect(api.patches[0]?.path).toEqual({ message_id: "om_9" });
    expect(api.patches[0]?.data.content).toContain("已写入 CRM");
  });

  it("频控（HTTP 429 / 99991400 抛错 / 返回 code 230020）→ 退避 0.5s/1s 后成功", async () => {
    const api = new FakeImApi([axios429(), axios400Limit(), { code: 0, data: { message_id: "om_3" } }]);
    const r = recorder();
    const client = createLarkClient(api, { sleep: r.sleep });
    expect(await client.sendCard({ chatId: "oc" }, buildNoticeCard("x"))).toEqual({ messageId: "om_3" });
    expect(r.waits).toEqual([500, 1000]);

    const api2 = new FakeImApi([{ code: 230020, msg: "rate limited" }, { code: 0 }]);
    const r2 = recorder();
    await createLarkClient(api2, { sleep: r2.sleep }).updateCard("om", buildNoticeCard("x"));
    expect(r2.waits).toEqual([500]);
    expect(api2.patches).toHaveLength(2);
  });

  it("重试 3 次（0.5s/1s/2s）仍频控 → RATE_LIMITED，共请求 4 次", async () => {
    const api = new FakeImApi([axios429(), axios429(), axios429(), axios429(), { code: 0 }]);
    const r = recorder();
    const client = createLarkClient(api, { sleep: r.sleep });
    let err: unknown;
    try {
      await client.sendCard({ chatId: "oc" }, buildNoticeCard("x"));
    } catch (e) {
      err = e;
    }
    expect(isKaidanError(err) && err.code).toBe(ErrorCode.RATE_LIMITED);
    expect(r.waits).toEqual([...RETRY_DELAYS_MS]);
    expect(RETRY_DELAYS_MS).toEqual([500, 1000, 2000]);
    expect(api.creates).toHaveLength(4);
  });

  it("非频控错误不重试：code≠0 → UPSTREAM；网络错误原样抛出", async () => {
    const r = recorder();
    const api = new FakeImApi([{ code: 230002, msg: "bot not in chat" }]);
    let err: unknown;
    try {
      await createLarkClient(api, { sleep: r.sleep }).sendCard({ chatId: "oc" }, buildNoticeCard("x"));
    } catch (e) {
      err = e;
    }
    expect(isKaidanError(err) && err.code).toBe(ErrorCode.UPSTREAM);
    expect(api.creates).toHaveLength(1);

    const api2 = new FakeImApi([new Error("ECONNRESET")]);
    await expect(createLarkClient(api2, { sleep: r.sleep }).updateCard("om", buildNoticeCard("x"))).rejects.toThrow(
      "ECONNRESET",
    );
    expect(r.waits).toEqual([]);
  });

  it("没有收件人 → VALIDATION", async () => {
    const client = createLarkClient(new FakeImApi([]), { sleep: async () => {} });
    await expect(client.sendCard({}, buildNoticeCard("x"))).rejects.toMatchObject({ code: ErrorCode.VALIDATION });
  });
});

describe("isRateLimited / withRateLimitRetry", () => {
  it("识别 KaidanError(RATE_LIMITED)、429、频控码；其他不算", () => {
    expect(isRateLimited(new KaidanError(ErrorCode.RATE_LIMITED, "x"))).toBe(true);
    expect(isRateLimited(axios429())).toBe(true);
    expect(isRateLimited(axios400Limit())).toBe(true);
    expect(isRateLimited(new KaidanError(ErrorCode.UPSTREAM, "x"))).toBe(false);
    expect(isRateLimited({ response: { status: 500, data: { code: 1 } } })).toBe(false);
    expect(isRateLimited(new Error("x"))).toBe(false);
  });

  it("首次成功不等待", async () => {
    const r = recorder();
    expect(await withRateLimitRetry("x", async () => 42, r.sleep)).toBe(42);
    expect(r.waits).toEqual([]);
  });
});
