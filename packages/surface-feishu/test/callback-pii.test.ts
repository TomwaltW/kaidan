// 卡片回调链路的可观测性，以及 PII 反向验证：
// 整条链路跑完后，日志里必须有提案 id / 操作人 / 处理结果，且绝不能出现手机号与 CRM 正文（硬规则 5）。
import { describe, expect, it } from "vitest";
import { ErrorCode, KaidanError } from "@kaidan/contracts";
import {
  buildFeishuSurface,
  createConfigIdentityResolver,
  type FeishuEventHandlers,
  type LogLevel,
} from "../src/index.js";
import {
  FakeAgent,
  FakeGovernance,
  RecordingLarkClient,
  ZHANG,
  flush,
  proposal,
  runResult,
  testConfig,
} from "./fakes.js";

/** 虚构数据：手机号与 CRM 正文，跑完整条链路后日志里一个字都不许有 */
const PHONE = "13800000001";
const CRM_TEXT = "华东精密（虚构）的王总说预算卡在财务，下周三前要折扣方案";
const PROPOSAL_ID = "prop_pii_1";
const MESSAGE_ID = "om_card_1";

function piiProposal() {
  return proposal({
    id: PROPOSAL_ID,
    reason: CRM_TEXT,
    patch: { nextStep: `致电 ${PHONE} 确认预算` },
    diff: [{ field: "nextStep", before: "", after: `致电 ${PHONE} 确认预算` }],
  });
}

function setup(opts: { level?: LogLevel; agent?: FakeAgent; governance?: FakeGovernance } = {}) {
  const lines: string[] = [];
  const config = testConfig();
  const governance = opts.governance ?? new FakeGovernance([piiProposal()]);
  let handlers: FeishuEventHandlers | undefined;
  const lark = new RecordingLarkClient();
  const surface = buildFeishuSurface(
    {
      agent: opts.agent ?? new FakeAgent(),
      governance,
      identity: createConfigIdentityResolver(config),
      config,
      client: lark,
    },
    {
      log: (...a: unknown[]) => void lines.push(a.map(String).join(" ")),
      logLevel: opts.level ?? "debug",
      connect: async (h) => {
        handlers = h;
        return { botOpenId: "ou_bot", client: lark, close: () => {} };
      },
      schedule: { paused: true },
      sleep: async () => {},
    },
  );
  return {
    surface,
    governance,
    lark,
    lines,
    text: () => lines.join("\n"),
    async handlers(): Promise<FeishuEventHandlers> {
      await surface.start();
      if (!handlers) throw new Error("connect 没被调用");
      return handlers;
    },
  };
}

function cardCallback(action: "approve" | "reject", proposalId = PROPOSAL_ID): Record<string, unknown> {
  return {
    operator: { open_id: ZHANG },
    action: { value: { kaidan_action: action, proposal_id: proposalId } },
    context: { open_message_id: MESSAGE_ID, open_chat_id: "oc_p2p_zhang" },
  };
}

describe("卡片回调链路的可观测性", () => {
  it("收到回调 → 一行里有回调类型、提案 id、操作人；处理完再一行写结果 committed", async () => {
    const h = setup();
    const handlers = await (await h.handlers());
    await handlers.onCardAction(cardCallback("approve"));
    await flush();

    expect(h.text()).toContain("card.action.trigger：动作=approve");
    expect(h.text()).toContain(`提案=${PROPOSAL_ID}`);
    expect(h.text()).toContain(`操作人=${ZHANG}`);
    expect(h.text()).toContain(`card.action.trigger 处理完成：提案=${PROPOSAL_ID} 结果=committed`);
    // 行为没变：仍然以换卡的方式回原卡片
    expect(h.lark.updated.map((u) => u.messageId)).toEqual([MESSAGE_ID]);
  });

  it("拒绝 → 结果写 rejected；审批报错 → 结果写错误码", async () => {
    const rejected = setup();
    (await rejected.handlers()).onCardAction(cardCallback("reject"));
    await flush();
    expect(rejected.text()).toContain("结果=rejected");

    const governance = new FakeGovernance([piiProposal()]);
    governance.failWith.set(PROPOSAL_ID, new KaidanError(ErrorCode.CONFLICT, "记录已被他人修改"));
    const failed = setup({ governance });
    (await failed.handlers()).onCardAction(cardCallback("approve"));
    await flush();
    expect(failed.text()).toContain(`结果=错误 ${ErrorCode.CONFLICT}`);
  });

  it("按钮 value 形状不对 → warn 指出应有的形状，只打顶层字段名，不打载荷内容", async () => {
    const h = setup();
    const handlers = await h.handlers();
    const r = await handlers.onCardAction({
      operator: { open_id: ZHANG },
      action: { value: { foo: CRM_TEXT } },
    });
    expect(r).toBeUndefined();
    expect(h.text()).toContain("按钮 value 应为 {kaidan_action, proposal_id}");
    expect(h.text()).toContain("顶层字段：operator,action");
    expect(h.text()).not.toContain(CRM_TEXT);
  });
});

describe("PII 反向验证", () => {
  it("消息 + 审批整条链路跑完（debug 级别），日志里没有手机号、没有 CRM 正文", async () => {
    const agent = new FakeAgent([
      runResult({
        reply: `已记录：${CRM_TEXT}`,
        proposals: [piiProposal()],
      }),
    ]);
    const h = setup({ agent, level: "debug" });
    const handlers = await h.handlers();

    // ① 用户私聊，正文里带手机号与 CRM 内容
    await handlers.onMessage({
      sender: { sender_id: { open_id: ZHANG }, sender_type: "user" },
      message: {
        message_id: "om_pii_1",
        chat_id: "oc_p2p_zhang",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: `/会后 ${CRM_TEXT}，联系方式 ${PHONE}` }),
      },
    });
    await flush();

    // ② 在审批卡上点同意
    await handlers.onCardAction(cardCallback("approve"));
    await flush();

    const logs = h.text();

    // 链路确实跑完了（否则下面的「不含」断言就是空的）
    expect(h.lark.sent.map((s) => s.card.kind)).toEqual(["reply", "proposal"]);
    expect(h.governance.calls).toEqual([{ op: "approve", proposalId: PROPOSAL_ID, by: ZHANG }]);
    expect(logs).toContain("结果=committed");
    expect(logs).toContain("om_pii_1");
    expect(logs).toContain("文本长度=");

    // 反向验证点：把任意一处日志改成打印整个提案 / 消息正文，这两条就会变红
    expect(logs).not.toContain(PHONE);
    expect(logs).not.toContain(CRM_TEXT);
    // 卡片里当然有正文——只是不许进日志
    expect(JSON.stringify(h.lark.sent)).toContain(CRM_TEXT);
  });

  it("未开通用户只记 open_id，不记正文（deploy/README 让管理员照着这行抄 open_id）", async () => {
    const h = setup({ level: "debug" });
    const handlers = await h.handlers();
    await handlers.onMessage({
      sender: { sender_id: { open_id: "ou_stranger" }, sender_type: "user" },
      message: {
        message_id: "om_pii_2",
        chat_id: "oc_p2p_x",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: `我的手机是 ${PHONE}` }),
      },
    });
    await flush();
    expect(h.text()).toContain("未开通用户发来消息：open_id=ou_stranger");
    expect(h.text()).not.toContain(PHONE);
  });
});
