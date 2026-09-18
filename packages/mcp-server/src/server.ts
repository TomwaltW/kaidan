// MCP server 的构造（不绑定 transport）：把 ToolRegistry 的 8 个工具以 MCP tools 暴露出来。
// 测试用 SDK 自带的 InMemoryTransport 连接；startMcpServer 用 stdio。
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { formatToolResultForModel, type Actor, type ToolDeps } from "@kaidan/contracts";
import { createToolRegistry } from "@kaidan/tools";
import { z } from "zod";

export const SERVER_INFO = { name: "kaidan", version: "0.1.0" } as const;

export type McpDeps = ToolDeps & { actor: Actor };

/** z.toJSONSchema 的结果去掉顶层 $schema（与 agent 暴露给模型的工具规格一致） */
export function inputJsonSchema(schema: z.ZodType): { type: "object"; [k: string]: unknown } {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return { ...rest, type: "object" };
}

export function buildMcpServer(deps: McpDeps): Server {
  const registry = createToolRegistry(deps);
  const server = new Server(SERVER_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: inputJsonSchema(t.input),
      annotations: { readOnlyHint: t.readOnly, destructiveHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const now = deps.clock ? deps.clock() : new Date();
    // 身份固定为启动时的 actor；invoke 负责校验、权限、审计与出口净化（剔除 raw、手机号脱敏），永不抛出
    const result = await registry.invoke(
      { actor: deps.actor, traceId: `mcp-${randomUUID()}`, now, skill: "mcp" },
      req.params.name,
      req.params.arguments ?? {},
    );
    return {
      content: [{ type: "text" as const, text: formatToolResultForModel(result) }],
      isError: !result.ok,
    };
  });

  return server;
}
