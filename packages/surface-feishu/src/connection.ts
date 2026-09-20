// 长连接状态的可观测性：连上 / 断开 / 重连中 / 重连成功各打一行
// （docs/manual-acceptance.md 有一项就是「断网 30 秒再恢复」）。
//
// 这几个回调是 @larksuiteoapi/node-sdk 1.74 WSClient 构造参数里就有的
// （types/index.d.ts 的 IConstructorParams：onReady / onError / onReconnecting / onReconnected），
// 不是猜的。离线测试直接调这里的函数，不需要真长连接。
import type { WSConnectionState } from "@larksuiteoapi/node-sdk";
import { SUBSCRIBED_EVENTS } from "./startup.js";
import type { Logger } from "./log.js";

/**
 * SDK 在 WSClient.start() 里先校验 App ID 格式，不匹配就只打一条 error 然后 return ——
 * 既不抛错也不连，外面看起来像「启动成功但永远收不到消息」。所以启动时先自己查一遍。
 * 正则抄自 SDK 源码 lib/index.js 的 start()。
 */
export const APP_ID_PATTERN = /^cli_[0-9a-fA-F]{16}$/;

/** 等 onReady 的宽限时间；超时说明握手没成，给出最常见的几种原因 */
export const WS_READY_TIMEOUT_MS = 15_000;

export interface WsStatusHooks {
  onReady: () => void;
  onError: (err: Error) => void;
  onReconnecting: () => void;
  onReconnected: () => void;
}

export interface ConnectionWatch extends WsStatusHooks {
  /** ws.start() 之后调用：超时仍未 onReady → 打一行 warn */
  armReadyWatchdog(): void;
  /** stop() 时清掉计时器 */
  disarm(): void;
}

/** 便于测试的计时器接口；缺省用 setTimeout（unref，不拖住进程退出） */
export interface TimerApi {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: TimerApi = {
  set: (fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** App ID 形状不对 → warn（不阻断启动：真机上 SDK 的校验才是准的） */
export function checkAppIdFormat(appId: string, logger: Logger): boolean {
  if (APP_ID_PATTERN.test(appId)) return true;
  const shown = appId.length > 8 ? `${appId.slice(0, 8)}…（共 ${appId.length} 位）` : appId;
  logger.warn(
    `App ID 不是 cli_ + 16 位十六进制的形状：${shown}。` +
      "飞书 SDK 遇到这种值会直接放弃建立长连接、且不抛错（表现为启动成功但收不到任何消息）——" +
      "请核对环境变量里的 App ID。",
  );
  return false;
}

export function createConnectionWatch(
  logger: Logger,
  opts: { timeoutMs?: number; timers?: TimerApi } = {},
): ConnectionWatch {
  const timers = opts.timers ?? realTimers;
  const timeoutMs = opts.timeoutMs ?? WS_READY_TIMEOUT_MS;
  let handle: unknown;
  let ready = false;

  const disarm = (): void => {
    if (handle !== undefined) timers.clear(handle);
    handle = undefined;
  };

  return {
    armReadyWatchdog() {
      disarm();
      handle = timers.set(() => {
        handle = undefined;
        if (ready) return;
        logger.warn(
          `长连接: ${Math.round(timeoutMs / 1000)} 秒内没有握手成功。常见原因：` +
            "① 开放平台「事件与回调」的订阅方式没选「使用长连接接收」；" +
            "② App ID / App Secret 不对或不是同一个应用；" +
            "③ 出网被挡（需要能访问 open.feishu.cn）。",
        );
      }, timeoutMs);
    },
    disarm,
    onReady() {
      ready = true;
      disarm();
      logger.info(`长连接: 已连接，开始接收 ${SUBSCRIBED_EVENTS}`);
    },
    onReconnecting() {
      ready = false;
      logger.warn("长连接: 断开，正在重连…（期间收到的消息会在重连后由飞书补投）");
    },
    onReconnected() {
      ready = true;
      disarm();
      logger.info("长连接: 重连成功，已恢复接收事件与回调");
    },
    onError(err) {
      ready = false;
      disarm();
      logger.error(
        "长连接: 建立失败且不再重试 —— " +
          (err instanceof Error ? `${err.name}: ${err.message}` : String(err)) +
          "。检查网络出网、App ID / App Secret，以及「事件与回调」是否都选了长连接。",
      );
    },
  };
}

/**
 * WSClient.getConnectionStatus().state → 中文说法。
 * WSConnectionState 是 SDK 1.74 导出的类型（'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'）。
 */
const WS_STATE_TEXT: Readonly<Record<WSConnectionState, string>> = {
  idle: "未开始",
  connecting: "正在建立…（连上后会另打一行「长连接: 已连接」）",
  connected: "已连接",
  reconnecting: "重连中",
  failed: "建立失败",
};

export function wsStateText(state: WSConnectionState): string {
  return WS_STATE_TEXT[state] ?? String(state);
}
