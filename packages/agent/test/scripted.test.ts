// spec 第 6 节 T2 行②：脚本 provider 行为（spec 3.2 第 6 条）。
import { describe, expect, it } from "vitest";
import { ErrorCode, isKaidanError, type LlmRequest } from "@kaidan/contracts";
import { createScriptedProvider } from "../src/index.js";

const req = (text: string): LlmRequest => ({ messages: [{ role: "user", content: text }] });

describe("createScriptedProvider", () => {
  it("第 i 次 chat 返回第 i 步：toolCalls → id call_<i>_<j>、arguments 为 JSON 字符串、finishReason=tool_calls", async () => {
    const p = createScriptedProvider([
      { toolCalls: [{ name: "crm_search", arguments: { type: "opportunity", text: "二期" } }, { name: "calendar_today", arguments: {} }] },
      { toolCalls: [{ name: "crm_get", arguments: { type: "opportunity", id: "opp_1" } }] },
      { content: "完成" },
    ]);
    const r1 = await p.chat(req("a"));
    expect(r1.finishReason).toBe("tool_calls");
    expect(r1.message).toEqual({
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "call_0_0", name: "crm_search", arguments: '{"type":"opportunity","text":"二期"}' },
        { id: "call_0_1", name: "calendar_today", arguments: "{}" },
      ],
    });
    const r2 = await p.chat(req("b"));
    expect(r2.message.toolCalls?.[0]?.id).toBe("call_1_0");
    const r3 = await p.chat(req("c"));
    expect(r3).toEqual({ message: { role: "assistant", content: "完成" }, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "stop" });
  });

  it("usage 恒为 0；id=scripted；缺省 disclosure；可传入 disclosure", async () => {
    const p = createScriptedProvider([{ toolCalls: [{ name: "crm_get", arguments: {} }] }]);
    expect(p.id).toBe("scripted");
    expect(p.disclosure).toEqual({ providerName: "脚本", modelName: "scripted" });
    expect((await p.chat(req("x"))).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    const q = createScriptedProvider([], { providerName: "测试", modelName: "scripted", filingNo: "备-1" });
    expect(q.disclosure).toEqual({ providerName: "测试", modelName: "scripted", filingNo: "备-1" });
  });

  it("remaining() 递减；步骤耗尽后再调用 → KaidanError(CONFIG)，且该请求仍被记录", async () => {
    const p = createScriptedProvider([{ content: "1" }, { content: "2" }]);
    expect(p.remaining()).toBe(2);
    await p.chat(req("a"));
    expect(p.remaining()).toBe(1);
    await p.chat(req("b"));
    expect(p.remaining()).toBe(0);
    const e = await p.chat(req("c")).catch((x: unknown) => x);
    expect(isKaidanError(e) && e.code).toBe(ErrorCode.CONFIG);
    expect(p.requests).toHaveLength(3);
  });

  it("requests 保存每次请求的深拷贝（之后修改原请求不影响记录；signal 不被拷贝也不报错）", async () => {
    const p = createScriptedProvider([{ content: "ok" }]);
    const original: LlmRequest = {
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      tools: [{ name: "crm_get", description: "d", parameters: { type: "object" } }],
      temperature: 0.2,
      signal: new AbortController().signal,
    };
    await p.chat(original);
    original.messages.push({ role: "user", content: "later" });
    (original.tools![0]!.parameters as Record<string, unknown>)["type"] = "changed";
    expect(p.requests[0]).toEqual({
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      tools: [{ name: "crm_get", description: "d", parameters: { type: "object" } }],
      temperature: 0.2,
    });
  });

  it("修改传入的 steps 数组不影响已创建的 provider", async () => {
    const steps = [{ content: "原文" }];
    const p = createScriptedProvider(steps);
    steps[0]!.content = "被改了";
    expect((await p.chat(req("x"))).message.content).toBe("原文");
  });

  it("既无 toolCalls 也无 content 的步骤 → content 为空串、stop", async () => {
    const p = createScriptedProvider([{}, { toolCalls: [] }]);
    expect((await p.chat(req("x"))).message).toEqual({ role: "assistant", content: "" });
    expect((await p.chat(req("y"))).finishReason).toBe("stop");
  });
});
