// @kaidan/mcp-server 的 stdio 入口（`pnpm --filter @kaidan/mcp-server start`）—— T0 桩，由 T1 实现：
// 解析 --config 与 --as，以 stdio 运行 MCP server。stdio 模式下 stdout 只允许协议消息，日志一律写 stderr。
process.stderr.write("@kaidan/mcp-server bin 尚未实现\n");
process.exit(1);
