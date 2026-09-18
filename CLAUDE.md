# CLAUDE.md — 开单 Kaidan

开单（Kaidan，工作代号）是"飞书里的 AI 销售运营助手"：读懂客户的多维表格 CRM，给销售推送晨报、会前准备、会后一句话更新 CRM、商机体检、周报；任何写入都必须由人在飞书卡片上点"同意"才生效。它是 Salesforce × Anthropic「Claudeforce / Salesforce in Claude」思路在中国市场的本土化实现。背景与商业判断见 `docs/PLAN.md`（可选阅读）。

## 本轮唯一权威文档

`docs/dev-spec-2026-09-18.md`。开工前先读它的第 2 节（验收）、第 3 节（冻结契约与文件归属表）和第 6 节里你那一行。你的派工提示词（`docs/dispatch/T*.md`）只写"做什么"，"做到什么算完"以 spec 为准。

## 技术栈与常用命令

- Node ≥ 22.13（推荐 24 LTS），pnpm 10，TypeScript 7（`tsc --noEmit` 只做类型检查），zod 4，vitest 5，tsx 运行 TS 源码
- 每个包的 `exports` 直接指向 `./src/index.ts`，包内相对导入写 `.js` 后缀（NodeNext 规则）
- SQLite 用 Node 内置 `node:sqlite`（不引入任何原生编译依赖）

```bash
pnpm install --frozen-lockfile
pnpm typecheck                 # 全仓类型检查
pnpm test                      # 各包单元测试
pnpm test:e2e                  # 验收用例（tests/e2e）
pnpm lint:skills               # 技能包校验
pnpm eval:validate             # 评测数据集与任务校验
pnpm kaidan doctor --config config/demo.mock.yaml
```

## 硬规则（违反任意一条 = 任务失败）

1. **不改冻结路径。** 仓库根目录存在 `.contracts.lock` 时，其中列出的路径（契约、根配置、各包 package.json、验收用例、docs）不可修改。`.claude/hooks/guard-frozen.mjs` 会拦截 Edit/Write；也不许用 Bash（`sed -i`、重定向、`mv`、`rm`、`git checkout --`）绕过。需要改契约 → 停下来，在回执里 `status=blocked` 说明。
2. **不加依赖。** 依赖清单由 T0 一次性冻结在各包 `package.json` 与 `pnpm-lock.yaml` 里。缺依赖 → 停下来报告，不要 `pnpm add`。
3. **运行时不接 Claude / Anthropic / OpenAI 或任何境外模型 API。** 模型只通过配置里的 OpenAI 兼容接口接入国产已备案模型（百炼 / DeepSeek / 智谱 / 火山方舟 / Kimi 等）。代码里不许出现"Claude 中转/代理"开关。开发工具用什么是开发者自己的事，与产品运行时无关。
4. **模型只能提案，不能提交。** 写 CRM 只能走 `propose_*` 工具生成提案，提交只发生在 `ApprovalService.approve()`，而它只由人的操作（飞书卡片按钮 / CLI 命令）触发。任何工具都不得直接调用 adapter 的写方法。
5. **最小化个人信息。** ROM 层只有脱敏手机号；工具返回给模型/MCP 的数据必须剔除 `raw` 字段；审计日志只记元数据（工具名、耗时、提案 id、token 数），不记 CRM 正文与手机号。
6. **仓库里不放真实客户数据。** 所有测试与评测数据均为虚构，公司名带"（虚构）"。
7. **测试必须确定性。** 时间通过 `clock` 注入；单元测试与 e2e 不联网（飞书、模型、MCP 一律用 fake 或 in-memory）。
8. **不猜 SDK。** 飞书 SDK（`@larksuiteoapi/node-sdk`）、MCP SDK（`@modelcontextprotocol/sdk`）的接口以 `node_modules` 里安装版本的类型定义为准；拿不准就写清楚 TODO 并在回执里报告，不要凭记忆编 API。
9. **MCP stdio 模式下 stdout 只允许输出协议消息**，日志一律写 stderr。
10. **面向用户的文字用中文**（卡片、回复、错误提示、技能正文）；代码标识符用英文；注释中英文均可。

## 完成一个任务时

按派工提示词最后的要求提交 commit，并输出回执；回执最后一行必须是机械可判的一行：

```
RECEIPT <任务号> status=<done|blocked> commit=<短hash> checks=<通过数>/<总数> files=<改动文件数>
```

回执正文贴每条验收命令的**实际输出**关键行，不要只写"通过了"。
