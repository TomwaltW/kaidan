// @kaidan/mcp-server —— startMcpServer：以 stdio 提供 8 个工具（stdout 只允许协议消息，日志写 stderr）。
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { StartMcpServer } from "@kaidan/contracts";
import { buildMcpServer } from "./server.js";

export { buildMcpServer, inputJsonSchema, type McpDeps } from "./server.js";

export const startMcpServer: StartMcpServer = async (deps) => {
  const server = buildMcpServer(deps);
  await server.connect(new StdioServerTransport());
  return {
    async close() {
      await server.close();
    },
  };
};
