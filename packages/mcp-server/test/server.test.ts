// MCP server：用 SDK 自带的 InMemoryTransport 连接 Client，不起子进程、不联网。
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolName, type Actor } from "@kaidan/contracts";
import { buildMcpServer } from "../src/server.js";
import { ADMIN, ZHANG, fixture, type Fixture } from "./fakes.js";

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
});

async function connect(actor: Actor, f: Fixture = fixture()) {
  const server = buildMcpServer({ ...f.deps, actor });
  const client = new Client({ name: "kaidan-test", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  open.push(client, server);
  return { client, f };
}

type Body = { ok: true; output: Record<string, unknown> } | { ok: false; error: { code: string; message: string } };

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const r = await client.callTool({ name, arguments: args });
  const content = r.content as { type: string; text: string }[];
  expect(content).toHaveLength(1);
  expect(content[0]!.type).toBe("text");
  return { isError: r.isError, text: content[0]!.text, body: JSON.parse(content[0]!.text) as Body };
}

describe("MCP server", () => {
  it("恰好列出 8 个工具，inputSchema 为 object 且不带 $schema", async () => {
    const { client } = await connect(ZHANG);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...ToolName.options].sort());
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect("$schema" in t.inputSchema).toBe(false);
      expect(t.description).toMatch(/[一-龥]/);
    }
    const pipeline = tools.find((t) => t.name === "pipeline_snapshot")!;
    expect(pipeline.inputSchema.required).toEqual(["scope"]);
    expect(tools.find((t) => t.name === "propose_update")!.annotations?.readOnlyHint).toBe(false);
  });

  it("以张三身份 crm_search 只返回张三可见的记录，且不含 raw", async () => {
    const f = fixture();
    for (const o of f.adapter.data.opportunities) o.raw = { 内部: "原始字段" };
    const { client } = await connect(ZHANG, f);
    const opps = await call(client, "crm_search", { type: "opportunity" });
    expect(opps.isError).toBe(false);
    if (!opps.body.ok) throw new Error("应成功");
    expect((opps.body.output["items"] as { id: string }[]).map((i) => i.id)).toEqual(["opp_1", "opp_2"]);
    expect(opps.text).not.toContain('"raw"');
    expect(opps.text).not.toContain("原始字段");
    expect(opps.text).not.toContain("南海");
    const contacts = await call(client, "crm_search", { type: "contact" });
    if (!contacts.body.ok) throw new Error("应成功");
    expect(contacts.body.output["items"]).toEqual([expect.objectContaining({ id: "con_chen", phoneMasked: "138****0001" })]);
  });

  it("propose_update 只产生提案，适配器写入次数仍为 0", async () => {
    const { client, f } = await connect(ZHANG);
    const r = await call(client, "propose_update", {
      ref: { type: "opportunity", id: "opp_1" },
      patch: { stage: "negotiation" },
      reason: "MCP 测试",
    });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({
      ok: true,
      output: { status: "pending", diff: [{ field: "stage", before: "solution", after: "negotiation" }] },
    });
    expect(f.proposals.items).toHaveLength(1);
    expect(f.proposals.items[0]).toMatchObject({ actorUserId: "ou_rep_zhang", targetId: "opp_1", status: "pending" });
    expect(f.adapter.writeCalls).toBe(0);
    expect(f.adapter.data.opportunities[0]!.stage).toBe("solution");
  });

  it("越权与非法参数以 isError 返回（不抛出协议错误），并写审计", async () => {
    const { client, f } = await connect(ZHANG);
    const denied = await call(client, "crm_get", { type: "opportunity", id: "opp_3" });
    expect(denied.isError).toBe(true);
    expect(denied.body).toEqual({ ok: false, error: { code: "PERMISSION_DENIED", message: "无权限访问该记录" } });
    const schema = await call(client, "schema_inspect", {});
    expect(schema.body).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
    const bad = await call(client, "pipeline_snapshot", { scope: "everyone" });
    expect(bad.body).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    const unknown = await call(client, "delete_everything", {});
    expect(unknown.body).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(f.audit.events.filter((e) => e.type === "permission_denied")).toHaveLength(2);
    expect(f.audit.events.filter((e) => e.type === "tool_call")).toHaveLength(4);
    expect(f.audit.events.every((e) => e.actorUserId === "ou_rep_zhang" && e.traceId.startsWith("mcp-"))).toBe(true);
  });

  it("身份固定为启动时的 actor：管理员实例可以 schema_inspect", async () => {
    const { client } = await connect(ADMIN);
    const r = await call(client, "schema_inspect", {});
    expect(r.body).toMatchObject({ ok: true, output: { schema: { source: "mock" } } });
  });
});
