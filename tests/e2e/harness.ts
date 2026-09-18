// e2e 公共前提（spec 2.2）：数据集 mini.json、可前进的时钟、记录型飞书 fake、按 openId 取 Actor、解析工具消息。
// 每个 it 用 setup() 构建一个全新的 app（governance.dbPath=":memory:"，proposalTtlMinutes=1440）；
// 各用例文件在 afterEach 里调用 teardown() 关闭本用例打开的 app。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { createScriptedProvider } from "@kaidan/agent";
import { buildApp } from "@kaidan/app";
import {
  KaidanConfig,
  RomDataset,
  isKaidanError,
  type Actor,
  type App,
  type AuditEvent,
  type AuditEventType,
  type ErrorCode,
  type KaidanError,
  type LarkClientLike,
  type LlmRequest,
  type MockRomAdapter,
  type ModelDisclosure,
  type Opportunity,
  type OutboundCard,
  type ScriptStep,
  type ScriptedLlmProvider,
  type ToolContext,
  type ToolInvokeResult,
} from "@kaidan/contracts";

// ---------------------------------------------------------------- 常量

/** 时钟初值：2026-09-21（周一）09:00，Asia/Shanghai */
export const START = "2026-09-21T09:00:00+08:00";
export const TIMEZONE = "Asia/Shanghai";
export const TENANT = "demo";
export const MINI_PATH = fileURLToPath(new URL("./fixtures/mini.json", import.meta.url));

export const WANG = "ou_mgr_wang"; // 王经理 [manager]
export const ZHANG = "ou_rep_zhang"; // 张三 [rep，上级王经理，scheduled]
export const LI = "ou_rep_li"; // 李四 [rep，上级王经理，scheduled]
export const ADMIN = "ou_admin"; // 管理员 [admin]

/** 脚本 provider 的模型公示：reply 卡页脚应为"内容由 AI 生成 · 测试 scripted" */
export const DISCLOSURE: ModelDisclosure = { providerName: "测试", modelName: "scripted" };

// ---------------------------------------------------------------- 配置与构建

export function e2eConfig(): KaidanConfig {
  return KaidanConfig.parse({
    tenantId: TENANT,
    timezone: TIMEZONE,
    llm: { kind: "scripted", disclosure: { ...DISCLOSURE } },
    adapter: { kind: "mock", mock: { datasetPath: MINI_PATH } },
    governance: { dbPath: ":memory:", proposalTtlMinutes: 1440 },
    risk: {
      staleDays: 14,
      stuckDays: 30,
      soonDays: 7,
      requiredQualificationKeys: ["pain", "decision_maker", "budget", "timeline"],
    },
    users: [
      { openId: WANG, displayName: "王经理", roles: ["manager"] },
      { openId: ZHANG, displayName: "张三", roles: ["rep"], managerOpenId: WANG, scheduled: true },
      { openId: LI, displayName: "李四", roles: ["rep"], managerOpenId: WANG, scheduled: true },
      { openId: ADMIN, displayName: "管理员", roles: ["admin"] },
    ],
  });
}

/** 每次读一份新的 mini.json，用例之间互不影响 */
export function loadMini(): RomDataset {
  return RomDataset.parse(JSON.parse(readFileSync(MINI_PATH, "utf8")));
}

/** 可控时钟：只在测试显式 advance 时前进 */
export class ManualClock {
  private t: number;
  constructor(iso: string) {
    this.t = Date.parse(iso);
  }
  now(): Date {
    return new Date(this.t);
  }
  advanceHours(hours: number): void {
    this.t += hours * 3_600_000;
  }
}

export interface SentCard {
  to: { chatId?: string; openId?: string };
  card: OutboundCard;
  messageId: string;
}

/** 记录型飞书客户端：只记录，不联网 */
export class RecordingLarkClient implements LarkClientLike {
  readonly sent: SentCard[] = [];
  readonly updated: { messageId: string; card: OutboundCard }[] = [];
  async sendCard(to: { chatId?: string; openId?: string }, card: OutboundCard): Promise<{ messageId: string }> {
    const messageId = `om_fake_${this.sent.length + 1}`;
    this.sent.push({ to: { ...to }, card: structuredClone(card), messageId });
    return { messageId };
  }
  async updateCard(messageId: string, card: OutboundCard): Promise<void> {
    this.updated.push({ messageId, card: structuredClone(card) });
  }
}

export interface Harness {
  app: App;
  clock: ManualClock;
  provider: ScriptedLlmProvider;
  lark: RecordingLarkClient;
}

const opened: App[] = [];

/** 构建一个全新的 app：模型 = 脚本 provider（steps），飞书 = 记录型 fake，时钟 = ManualClock(START) */
export async function setup(steps: ScriptStep[] = []): Promise<Harness> {
  const clock = new ManualClock(START);
  const provider = createScriptedProvider(steps, { ...DISCLOSURE });
  const lark = new RecordingLarkClient();
  const app = await buildApp(e2eConfig(), {
    dataset: loadMini(),
    provider,
    larkClient: lark,
    clock: () => clock.now(),
  });
  opened.push(app);
  return { app, clock, provider, lark };
}

export async function teardown(): Promise<void> {
  for (const app of opened.splice(0)) await app.close();
}

// ---------------------------------------------------------------- 身份与数据

/** Actor 一律由 app.identity.resolveByOpenId() 得到 */
export async function actor(h: Harness, openId: string): Promise<Actor> {
  const a = await h.app.identity.resolveByOpenId(openId);
  if (!a) throw new Error(`identity.resolveByOpenId("${openId}") 返回 null`);
  return a;
}

export function toolCtx(h: Harness, a: Actor, traceId: string): ToolContext {
  return { actor: a, traceId, now: h.clock.now() };
}

export function mockAdapter(h: Harness): MockRomAdapter {
  expect(h.app.adapter.kind).toBe("mock");
  return h.app.adapter as MockRomAdapter;
}

/** 从 Mock 适配器的当前快照读商机（不经过权限检查） */
export function opportunity(h: Harness, id: string): Opportunity {
  const found = mockAdapter(h)
    .snapshot()
    .opportunities.find((o) => o.id === id);
  if (!found) throw new Error(`快照里找不到商机 ${id}`);
  return found;
}

// ---------------------------------------------------------------- 脚本

/** B3 与 B6① 共用的会后脚本：① crm_search ② propose_update ③ 正文 */
export function postMeetingScript(): ScriptStep[] {
  return [
    { toolCalls: [{ name: "crm_search", arguments: { type: "opportunity", text: "二期产线" } }] },
    {
      toolCalls: [
        {
          name: "propose_update",
          arguments: {
            ref: { type: "opportunity", id: "opp_1" },
            patch: { stage: "negotiation", nextStep: "9月24日前发送正式报价单", expectedCloseDate: "2026-10-15" },
            reason: "会后：客户确认方案，进入商务谈判",
          },
        },
      ],
    },
    { content: "已生成更新提案" },
  ];
}

// ---------------------------------------------------------------- 工具消息与工具结果

export type ToolBody = { ok: true; output: unknown } | { ok: false; error: { code: string; message: string } };

/** 模型在后续请求中收到的 role:"tool" 消息；name 取自前面 assistant 消息里对应的 toolCall */
export interface ToolMessage {
  toolCallId: string;
  name: string;
  content: string;
  body: ToolBody;
}

/** 收集脚本 provider 收到的全部工具消息（按首次出现的顺序，按 toolCallId 去重） */
export function toolMessages(provider: ScriptedLlmProvider): ToolMessage[] {
  const names = new Map<string, string>();
  const seen = new Map<string, ToolMessage>();
  for (const req of provider.requests) {
    for (const m of req.messages) {
      if (m.role === "assistant") {
        for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
      } else if (m.role === "tool" && !seen.has(m.toolCallId)) {
        seen.set(m.toolCallId, {
          toolCallId: m.toolCallId,
          name: names.get(m.toolCallId) ?? "",
          content: m.content,
          body: JSON.parse(m.content) as ToolBody,
        });
      }
    }
  }
  return [...seen.values()];
}

/** 取某个工具的唯一一条工具消息 */
export function toolMessage(provider: ScriptedLlmProvider, name: string): ToolMessage {
  const found = toolMessages(provider).filter((m) => m.name === name);
  expect(found, `模型应恰好收到 1 条 ${name} 的工具消息`).toHaveLength(1);
  return found[0]!;
}

function bodyOf(r: ToolMessage | ToolInvokeResult): ToolBody {
  return "body" in r ? r.body : r;
}

/** 断言工具成功并取出 output */
export function okOutput<T>(r: ToolMessage | ToolInvokeResult): T {
  const body = bodyOf(r);
  if (!body.ok) expect.fail(`工具应成功，实际失败：${JSON.stringify(body.error)}`);
  return body.output as T;
}

/** 工具失败时的 error.code；成功时为 undefined */
export function errorCode(r: ToolMessage | ToolInvokeResult): string | undefined {
  const body = bodyOf(r);
  return body.ok ? undefined : body.error.code;
}

/** 以 actor 身份经 tools.invoke 生成一条商机更新提案，返回 proposalId */
export async function proposeUpdate(
  h: Harness,
  a: Actor,
  opportunityId: string,
  patch: Record<string, unknown>,
  reason = "e2e 提案",
): Promise<string> {
  const r = await h.app.tools.invoke(toolCtx(h, a, `t-propose-${opportunityId}`), "propose_update", {
    ref: { type: "opportunity", id: opportunityId },
    patch,
    reason,
  });
  return okOutput<ProposeOut>(r).proposalId;
}

/** 递归检查任意 JSON 值里是否出现某个键 */
export function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((v) => hasKeyDeep(v, key));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(([k, v]) => k === key || hasKeyDeep(v, key));
  }
  return false;
}

// 工具输出里测试用到的字段（形状以 packages/contracts/src/tools.ts 为准）
export interface PipelineOut {
  byStage: { stage: string; count: number; amount: number }[];
  openAmount: number;
  closingSoon: { id: string }[];
  atRisk: { opportunityId: string; name: string; reasons: string[] }[];
}
export interface CalendarOut {
  events: { id: string }[];
}
export interface SearchOut {
  items: { id: string; phoneMasked?: string }[];
}
export interface GetOut {
  item: { id: string; name?: string } | null;
}
export interface SchemaOut {
  schema: { source: string };
}
export interface ProposeOut {
  proposalId: string;
}

// ---------------------------------------------------------------- 模型请求、审计、卡片、错误

export function request(provider: ScriptedLlmProvider, index: number): LlmRequest {
  const req = provider.requests[index];
  if (!req) throw new Error(`模型只收到 ${provider.requests.length} 次请求，没有第 ${index + 1} 次`);
  return req;
}

/** 某次请求里全部 system 消息的正文 */
export function systemText(req: LlmRequest): string {
  return req.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

export function auditOf(
  h: Harness,
  q: { traceId?: string; proposalId?: string; type?: AuditEventType } = {},
): Promise<AuditEvent[]> {
  return h.app.governance.audit.query({ tenantId: TENANT, limit: 1000, ...q });
}

export function countTypes(events: AuditEvent[]): Partial<Record<AuditEventType, number>> {
  const counts: Partial<Record<AuditEventType, number>> = {};
  for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  return counts;
}

/** 卡片 JSON 的字符串形式（断言"含某段文字 / 某个键值"用） */
export function cardText(card: OutboundCard): string {
  return JSON.stringify(card.json);
}

/** 断言 p 以指定 code 的 KaidanError 拒绝 */
export async function expectKaidanError(p: Promise<unknown>, code: ErrorCode): Promise<KaidanError> {
  let thrown: unknown = undefined;
  let didThrow = false;
  try {
    await p;
  } catch (e) {
    thrown = e;
    didThrow = true;
  }
  expect(didThrow, `期望抛出 KaidanError(${code})，实际没有抛出`).toBe(true);
  expect(isKaidanError(thrown), `期望 KaidanError(${code})，实际：${String(thrown)}`).toBe(true);
  expect((thrown as KaidanError).code).toBe(code);
  return thrown as KaidanError;
}
