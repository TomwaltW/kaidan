// B4 越权（spec 2.2）：看不到的记录不泄露任何内容；不同身份经 tools.invoke 的可见性与 admin 限制。
import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN,
  TENANT,
  WANG,
  ZHANG,
  actor,
  auditOf,
  errorCode,
  okOutput,
  setup,
  teardown,
  toolCtx,
  toolMessage,
  type GetOut,
  type SchemaOut,
  type SearchOut,
} from "./harness.js";

afterEach(teardown);

describe("B4 越权", () => {
  it("张三 assistant 读 opp_3 被拒且不泄露；各身份的工具调用符合可见性规则 V1", async () => {
    const h = await setup([
      { toolCalls: [{ name: "crm_get", arguments: { type: "opportunity", id: "opp_3" } }] },
      { content: "你没有权限查看这条商机（测试）" },
    ]);
    const zhang = await actor(h, ZHANG);
    const wang = await actor(h, WANG);
    const admin = await actor(h, ADMIN);

    await h.app.agent.run({
      actor: zhang,
      text: "看看南海外贸那个商机",
      skill: "assistant",
      channel: "cli",
      traceId: "t-b4",
    });

    // crm_get 工具消息：PERMISSION_DENIED，且全文不含记录内容
    const denied = toolMessage(h.provider, "crm_get");
    expect(denied.body.ok).toBe(false);
    expect(errorCode(denied)).toBe("PERMISSION_DENIED");
    expect(denied.content).not.toContain("南海");
    expect(denied.content).not.toContain("260000");

    // 张三 propose_update opp_3 → PERMISSION_DENIED，且没有产生提案
    const update = await h.app.tools.invoke(toolCtx(h, zhang, "t-b4-1"), "propose_update", {
      ref: { type: "opportunity", id: "opp_3" },
      patch: { nextStep: "越权修改" },
      reason: "越权测试",
    });
    expect(errorCode(update)).toBe("PERMISSION_DENIED");
    expect(await h.app.governance.proposals.listPending(TENANT, ZHANG)).toEqual([]);

    // 张三 联系人搜索：只看到 con_chen，手机号为脱敏值
    const contacts = okOutput<SearchOut>(
      await h.app.tools.invoke(toolCtx(h, zhang, "t-b4-2"), "crm_search", { type: "contact" }),
    );
    expect(contacts.items.map((c) => c.id)).toEqual(["con_chen"]);
    expect(contacts.items[0]?.phoneMasked).toBe("138****0001");

    // 张三 活动搜索：id 集合为 {act_1, act_3}
    const activities = okOutput<SearchOut>(
      await h.app.tools.invoke(toolCtx(h, zhang, "t-b4-3"), "crm_search", { type: "activity" }),
    );
    expect(activities.items.map((a) => a.id).sort()).toEqual(["act_1", "act_3"]);

    // 张三 schema_inspect → PERMISSION_DENIED
    expect(errorCode(await h.app.tools.invoke(toolCtx(h, zhang, "t-b4-4"), "schema_inspect", {}))).toBe(
      "PERMISSION_DENIED",
    );

    // 王经理 crm_get opp_3 → ok
    const got = okOutput<GetOut>(
      await h.app.tools.invoke(toolCtx(h, wang, "t-b4-5"), "crm_get", { type: "opportunity", id: "opp_3" }),
    );
    expect(got.item?.name).toBe("南海外贸-CRM集成");

    // 管理员 schema_inspect → ok，source=mock
    const schema = okOutput<SchemaOut>(await h.app.tools.invoke(toolCtx(h, admin, "t-b4-6"), "schema_inspect", {}));
    expect(schema.schema.source).toBe("mock");

    // 审计：至少 3 条 permission_denied（crm_get、propose_update、schema_inspect）
    expect((await auditOf(h, { type: "permission_denied" })).length).toBeGreaterThanOrEqual(3);
  });
});
