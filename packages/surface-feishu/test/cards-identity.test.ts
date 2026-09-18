// 三类卡片的结构（附录 D）与身份解析（spec 3.2 第 8 条）。
import { describe, expect, it } from "vitest";
import {
  NOTICE_TEXT,
  PROPOSAL_CARD_TITLE,
  buildNoticeCard,
  buildProposalCard,
  buildReplyCard,
  createConfigIdentityResolver,
} from "../src/index.js";
import { ADMIN, DISCLOSURE, LI, TENANT, WANG, ZHANG, cardText, proposal, testConfig } from "./fakes.js";

type El = Record<string, unknown>;
function elements(json: Record<string, unknown>): El[] {
  return (json["body"] as { elements: El[] }).elements;
}
function buttons(json: Record<string, unknown>): El[] {
  const out: El[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if ((v as El)["tag"] === "button") out.push(v as El);
      Object.values(v).forEach(walk);
    }
  };
  walk(json);
  return out;
}

describe("卡片", () => {
  it("reply 卡：JSON 2.0，正文 markdown + 页脚公示", () => {
    const c = buildReplyCard("**晨报**\n- 今日 1 个会议", DISCLOSURE);
    expect(c.kind).toBe("reply");
    expect(c.json["schema"]).toBe("2.0");
    const els = elements(c.json);
    expect(els[0]).toMatchObject({ tag: "markdown", content: "**晨报**\n- 今日 1 个会议" });
    expect(els.at(-1)).toMatchObject({ tag: "markdown", content: "内容由 AI 生成 · 测试 scripted" });
  });

  it("reply 卡页脚：有 filingNo 时追加备案号", () => {
    const c = buildReplyCard("x", { providerName: "阿里云百炼", modelName: "通义千问", filingNo: "Beijing-XX-2026" });
    expect(cardText(c)).toContain("内容由 AI 生成 · 阿里云百炼 通义千问 · 备案号 Beijing-XX-2026");
  });

  it("reply 卡：空回复不产生空 markdown", () => {
    const c = buildReplyCard("   ", DISCLOSURE);
    expect((elements(c.json)[0] as El)["content"]).not.toBe("");
  });

  it("proposal 卡：标题、diff 原值→新值、理由、过期时间（租户时区）、同意/拒绝按钮与 value 形状", () => {
    const c = buildProposalCard(proposal(), "Asia/Shanghai");
    expect(c.kind).toBe("proposal");
    const text = cardText(c);
    expect(text).toContain(PROPOSAL_CARD_TITLE);
    expect(text).toContain("商机");
    expect(text).toContain("opp_1");
    expect(text).toContain("阶段：方案报价 → 商务谈判");
    expect(text).toContain("下一步：（空） → 9月24日前发送正式报价单");
    expect(text).toContain("会后：客户确认方案，进入商务谈判");
    expect(text).toContain("2026-09-22 09:00");
    // e2e B6① 的断言：value 是嵌套对象，序列化后能直接匹配
    expect(text).toContain('"kaidan_action":"approve"');
    expect(text).toContain('"proposal_id":"prop_1"');

    const bs = buttons(c.json);
    expect(bs.map((b) => [(b["text"] as El)["content"], b["type"]])).toEqual([
      ["同意", "primary"],
      ["拒绝", "danger"],
    ]);
    expect(bs.map((b) => (b["behaviors"] as El[])[0])).toEqual([
      { type: "callback", value: { kaidan_action: "approve", proposal_id: "prop_1" } },
      { type: "callback", value: { kaidan_action: "reject", proposal_id: "prop_1" } },
    ]);
  });

  it("proposal 卡：create 提案显示新建记录", () => {
    const c = buildProposalCard(
      proposal({
        kind: "create",
        objectType: "task",
        targetId: undefined,
        diff: [{ field: "title", before: null, after: "发送报价单" }],
      }),
      "Asia/Shanghai",
    );
    const text = cardText(c);
    expect(text).toContain("任务");
    expect(text).toContain("新建记录");
    expect(text).toContain("标题/职位：（空） → 发送报价单");
  });

  it("notice 卡：单段文案", () => {
    const c = buildNoticeCard(NOTICE_TEXT.notEnabled);
    expect(c.kind).toBe("notice");
    expect(elements(c.json)).toEqual([{ tag: "markdown", content: "你还没有开通开单助手，请联系管理员" }]);
    expect(NOTICE_TEXT.approved).toContain("已写入");
    expect(NOTICE_TEXT.rejected).toContain("已拒绝");
  });
});

describe("身份解析", () => {
  const identity = createConfigIdentityResolver(testConfig());

  it("rep：userId=openId、tenantId、managerId，无 teamIds", async () => {
    expect(await identity.resolveByOpenId(ZHANG)).toEqual({
      tenantId: TENANT,
      userId: ZHANG,
      displayName: "张三",
      roles: ["rep"],
      managerId: WANG,
    });
  });

  it("manager：teamIds 按 config 顺序", async () => {
    const wang = await identity.resolveByOpenId(WANG);
    expect(wang?.roles).toEqual(["manager"]);
    expect(wang?.teamIds).toEqual([ZHANG, LI]);
  });

  it("admin 与不存在的用户", async () => {
    expect((await identity.resolveByOpenId(ADMIN))?.roles).toEqual(["admin"]);
    expect(await identity.resolveByOpenId("ou_stranger")).toBeNull();
  });

  it("listScheduled：只含 scheduled=true，按 config 顺序", async () => {
    expect((await identity.listScheduled()).map((a) => a.userId)).toEqual([ZHANG, LI]);
  });
});
