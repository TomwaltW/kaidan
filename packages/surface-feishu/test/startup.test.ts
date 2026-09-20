// 启动自述与长连接状态：serve 起来后一眼看出连上了没有、连的是谁、还差什么没填。
// 所有用例都显式钉死 logLevel，不读 KAIDAN_LOG_LEVEL —— 开发者为了排错导出了那个环境变量时，测试也不能变色。
import { afterEach, describe, expect, it } from "vitest";
import { isKaidanError } from "@kaidan/contracts";
import {
  APP_ID_PATTERN,
  BOT_INFO_FAILURE_PREFIX,
  botFailureReason,
  buildFeishuSurface,
  checkAppIdFormat,
  createConfigIdentityResolver,
  createConnectionWatch,
  createLogger,
  fetchBotInfo,
  isPlaceholderOpenId,
  renderStartupBanner,
  wsStateText,
  type FeishuConnection,
  type FeishuEventHandlers,
  type TimerApi,
} from "../src/index.js";
import { FakeAgent, FakeGovernance, RecordingLarkClient, testConfig } from "./fakes.js";

const BOT = "ou_bot_kaidan";

function collector() {
  const lines: string[] = [];
  return { lines, sink: (...a: unknown[]) => void lines.push(a.map(String).join(" ")), text: () => lines.join("\n") };
}

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const s of stops.splice(0)) await s();
});

/** 用注入的 connect 启动一次，返回启动期间打出的所有日志行 */
async function startWith(
  connection: Partial<FeishuConnection> | ((h: FeishuEventHandlers) => Promise<FeishuConnection>),
  extraConfig: Record<string, unknown> = {},
): Promise<{ lines: string[]; text: string; handlers?: FeishuEventHandlers }> {
  const c = collector();
  const config = testConfig(extraConfig);
  let handlers: FeishuEventHandlers | undefined;
  const connect = async (h: FeishuEventHandlers): Promise<FeishuConnection> => {
    handlers = h;
    if (typeof connection === "function") return connection(h);
    return {
      botOpenId: BOT,
      client: new RecordingLarkClient(),
      close: () => {},
      ...connection,
    };
  };
  const surface = buildFeishuSurface(
    {
      agent: new FakeAgent(),
      governance: new FakeGovernance(),
      identity: createConfigIdentityResolver(config),
      config,
      client: new RecordingLarkClient(),
    },
    { connect, log: c.sink, logLevel: "info", schedule: { paused: true }, sleep: async () => {} },
  );
  stops.push(() => surface.stop());
  try {
    await surface.start();
  } catch {
    // 连接失败的分支也要能看到自述
  }
  return { lines: c.lines, text: c.text(), ...(handlers ? { handlers } : {}) };
}

describe("启动自述", () => {
  it("含租户 / adapter / 模型公示（沿用 doctor 的说法）、机器人信息、长连接状态与订阅、users 条数", async () => {
    const r = await startWith({ botName: "开单助手", status: () => "已连接" });
    expect(r.text).toContain("开单 serve 启动自述");
    expect(r.text).toContain("tenant: demo");
    expect(r.text).toContain("adapter: mock");
    expect(r.text).toContain("model: 测试 scripted");
    expect(r.text).toContain(`bot: 开单助手（open_id=${BOT}）`);
    expect(r.text).toContain("长连接: 已连接");
    expect(r.text).toContain("im.message.receive_v1");
    expect(r.text).toContain("card.action.trigger");
    expect(r.text).toContain("users: 4");
    expect(r.text).toContain("日志级别: info");
  });

  it("机器人没返回名称 → 写「（未返回名称）」，open_id 照样给出", async () => {
    const r = await startWith({});
    expect(r.text).toContain(`bot: （未返回名称）（open_id=${BOT}）`);
  });

  it("还有几个 open_id 是占位符 → 自述里点名列出（TODO_ 与样例里的 ou_xxxx… 都算）", async () => {
    const config = {
      users: [
        { openId: "TODO_填销售主管的open_id", displayName: "销售主管", roles: ["manager"] },
        { openId: "ou_xxxxxxxxxxxxxxxx", displayName: "销售A", roles: ["rep"] },
        { openId: "ou_real_0001", displayName: "销售B", roles: ["rep"] },
      ],
    };
    const r = await startWith({}, config);
    expect(r.text).toContain("users: 3，其中 2 个还是占位符 open_id");
    expect(r.text).toContain("TODO_填销售主管的open_id");
    expect(r.text).toContain("ou_xxxxxxxxxxxxxxxx");

    expect(isPlaceholderOpenId("TODO_abc")).toBe(true);
    expect(isPlaceholderOpenId("ou_yyyyyyyyyyyyyyyy")).toBe(true);
    expect(isPlaceholderOpenId("ou_real_0001")).toBe(false);
  });

  it("open_id 都填好了 → 明确写「都已填写」", async () => {
    const r = await startWith({});
    expect(r.text).toContain("users: 4（open_id 都已填写）");
  });

  it("定时任务行带上 cron 与时区；没有 schedules 段时也写清楚", async () => {
    const withCron = await startWith({}, { schedules: { dailyBrief: "30 8 * * 1-5", weeklyReview: "0 17 * * 5" } });
    expect(withCron.text).toContain("定时任务: 2（晨报 30 8 * * 1-5；周报 0 17 * * 5；时区 Asia/Shanghai）");
    const none = await startWith({});
    expect(none.text).toContain("配置里没有 schedules 段");
  });
});

describe("取不到机器人信息", () => {
  it("连接时抛出 → 自述里明确写「取不到机器人信息：<原因>」，并且 start() 照旧抛错", async () => {
    const c = collector();
    const config = testConfig();
    const surface = buildFeishuSurface(
      {
        agent: new FakeAgent(),
        governance: new FakeGovernance(),
        identity: createConfigIdentityResolver(config),
        config,
        client: new RecordingLarkClient(),
      },
      {
        log: c.sink,
        logLevel: "info",
        connect: async () => {
          throw await fetchBotInfo(
            { request: async () => ({ code: 99991672, msg: "no permission", error: { log_id: "LOGID-BOT" } }) } as never,
            createLogger({ sink: () => {}, level: "info" }),
          );
        },
      },
    );
    await expect(surface.start()).rejects.toThrow(BOT_INFO_FAILURE_PREFIX);
    expect(c.text()).toContain(`bot: ${BOT_INFO_FAILURE_PREFIX}`);
    expect(c.text()).toContain("bot/v3/info（读机器人信息）");
    expect(c.text()).toContain("code=99991672");
    expect(c.text()).toContain("log_id=LOGID-BOT");
    expect(c.text()).toContain("长连接: 未建立");
    // 连不上也照样把租户 / 模型 / users 打出来，方便一次看清
    expect(c.text()).toContain("tenant: demo");
    expect(c.text()).toContain("users: 4");
  });

  it("连上了但没给 open_id → 自述写明原因，不静默跳过", async () => {
    const r = await startWith({ botOpenId: "", botInfoError: "权限未开通（im:message 未申请）" });
    expect(r.text).toContain(`bot: ${BOT_INFO_FAILURE_PREFIX}权限未开通（im:message 未申请）`);
  });

  it("fetchBotInfo：HTTP 抛错 / code≠0 / 缺 open_id 三种失败都带上原因", async () => {
    const quiet = createLogger({ sink: () => {}, level: "info" });
    const call = (impl: () => Promise<unknown>) => fetchBotInfo({ request: impl } as never, quiet);

    await expect(call(async () => Promise.reject(new Error("ECONNRESET")))).rejects.toThrow("原始错误=Error: ECONNRESET");
    await expect(call(async () => ({ code: 99991663, msg: "invalid token" }))).rejects.toThrow("code=99991663");
    await expect(call(async () => ({ code: 0, bot: {} }))).rejects.toThrow("没有 bot.open_id");

    const ok = await call(async () => ({ code: 0, bot: { open_id: BOT, app_name: "开单助手" } }));
    expect(ok).toEqual({ openId: BOT, name: "开单助手" });
  });

  it("botFailureReason 只认取机器人信息的失败", () => {
    expect(botFailureReason(new Error(`${BOT_INFO_FAILURE_PREFIX}权限没开`))).toBe("权限没开");
    expect(botFailureReason(new Error("别的错"))).toBeUndefined();
  });
});

describe("长连接状态", () => {
  it("已连接 / 断开 / 重连中 / 重连成功各打一行", () => {
    const c = collector();
    const watch = createConnectionWatch(createLogger({ sink: c.sink, level: "info" }));
    watch.onReady();
    watch.onReconnecting();
    watch.onReconnected();
    expect(c.lines[0]).toContain("长连接: 已连接");
    expect(c.lines[0]).toContain("im.message.receive_v1");
    expect(c.lines[1]).toContain("长连接: 断开，正在重连…");
    expect(c.lines[2]).toContain("长连接: 重连成功");
  });

  it("彻底建立失败 → error 一行，带上原因与要检查的三件事", () => {
    const c = collector();
    createConnectionWatch(createLogger({ sink: c.sink, level: "info" })).onError(new Error("handshake timeout"));
    expect(c.text()).toContain("长连接: 建立失败且不再重试");
    expect(c.text()).toContain("handshake timeout");
    expect(c.text()).toContain("长连接");
  });

  it("超时仍没握手成功 → warn 列出常见原因；已连上则不报", () => {
    let fire: (() => void) | undefined;
    const timers: TimerApi = { set: (fn) => ((fire = fn), "h"), clear: () => (fire = undefined) };
    const c = collector();
    const watch = createConnectionWatch(createLogger({ sink: c.sink, level: "info" }), { timeoutMs: 15_000, timers });
    watch.armReadyWatchdog();
    fire?.();
    expect(c.text()).toContain("15 秒内没有握手成功");
    expect(c.text()).toContain("使用长连接接收");

    const c2 = collector();
    const watch2 = createConnectionWatch(createLogger({ sink: c2.sink, level: "info" }), { timers });
    watch2.armReadyWatchdog();
    watch2.onReady();
    fire?.();
    expect(c2.text()).not.toContain("没有握手成功");
  });

  it("App ID 形状不对 → warn 说明 SDK 会静默放弃连接", () => {
    const c = collector();
    expect(checkAppIdFormat("cli_a1b2c3d4e5f60718", createLogger({ sink: c.sink, level: "info" }))).toBe(true);
    expect(c.lines).toHaveLength(0);
    expect(checkAppIdFormat("cli_short", createLogger({ sink: c.sink, level: "info" }))).toBe(false);
    expect(c.text()).toContain("不是 cli_ + 16 位十六进制");
    expect(c.text()).toContain("不抛错");
    expect(APP_ID_PATTERN.test("cli_a1b2c3d4e5f60718")).toBe(true);
  });

  it("WSClient 的状态映射成中文", () => {
    expect(wsStateText("connected")).toBe("已连接");
    expect(wsStateText("reconnecting")).toBe("重连中");
    expect(wsStateText("connecting")).toContain("正在建立");
  });
});

describe("renderStartupBanner（纯函数）", () => {
  it("逐行返回，第一行是标题", () => {
    const lines = renderStartupBanner({
      config: testConfig(),
      bot: { openId: BOT, name: "开单助手" },
      connection: "已连接",
      scheduleCount: 0,
      logLevel: "debug",
    });
    expect(lines[0]).toBe("开单 serve 启动自述 ——");
    expect(lines.some((l) => l.startsWith("tenant: "))).toBe(true);
    expect(lines.some((l) => l.includes("KAIDAN_LOG_LEVEL=debug"))).toBe(true);
  });

  it("不是取机器人信息失败时，bot 行写「未读取」而不是硬安一个取不到的原因；错误原样抛出", async () => {
    let err: unknown;
    const c = collector();
    const config = testConfig();
    const surface = buildFeishuSurface(
      {
        agent: new FakeAgent(),
        governance: new FakeGovernance(),
        identity: createConfigIdentityResolver(config),
        config,
      },
      { log: c.sink, logLevel: "info", connect: async () => Promise.reject(new Error("连不上")) },
    );
    try {
      await surface.start();
    } catch (e) {
      err = e;
    }
    expect(isKaidanError(err)).toBe(false);
    expect((err as Error).message).toBe("连不上");
    expect(c.text()).toContain("bot: 未读取（长连接未建立：Error: 连不上）");
    expect(c.text()).not.toContain(BOT_INFO_FAILURE_PREFIX);
  });
});
