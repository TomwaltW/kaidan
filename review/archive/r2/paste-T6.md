# 派单 T6 · 提案过期不再列出 ＋ MCP 入口收口

> 开单 Kaidan · 2026-09-20。第 1 轮的冻结（`.contracts.lock`）仍然有效，本批只做不碰冻结路径的小修；
> 结构性的改动已决定推迟到第 2 轮，本轨不要碰。
> 基线：`e0b0a0f`（main HEAD，总管在 2026-09-20 钉下）。
> 同时在跑：**T5 CLI 与飞书卡片**、**T6 治理与 MCP 入口**（本轨）、**T7 技能措辞**。三轨文件互不重叠。

## 工作区（已建好，你就在里面）

- worktree：`/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t6`
- 分支：`t6` —— 不要改名、不要切分支、不要 merge / rebase / push；总管按分支名合流
- 基线：`e0b0a0f`
- 依赖已装（`pnpm install --frozen-lockfile` 退出码 0）；缺依赖 → 停下报告，不要 `pnpm add`
- 主仓库 `/Users/shensikai/Documents/Projects/Kaidan/kaidan` 和另外两个 worktree（`.worktrees/task-t5`、`task-t7`）一律只读

## 第 1 步：开场自检（任一条对不上 → 停下，回执 `status=blocked` 并贴实际输出；不要去「修」基线）

1. **守卫 hook 挂上了没有**：用 Write 工具新建 `docs/.guard-probe`（内容随意；`docs/**` 是冻结路径）。
   **被拦**（提示含「已拦截」）才算通过。写成功了 = hook 没挂上：删掉探针，停下，回执 `status=blocked`。
2. 位置与基线：`pwd` → `…/.worktrees/task-t6`；`git rev-parse --abbrev-ref HEAD` → `t6`；
   `git rev-parse --short HEAD` → `e0b0a0f`；`git status --short` → 空。
3. 基线期望值（总管 2026-09-20 在 task-t5 里实跑，三个 worktree 同一基线，结果相同）：

| 命令 | 期望 |
|---|---|
| `pnpm install --frozen-lockfile` | 退出码 0 |
| `pnpm typecheck` | 退出码 0，`Scope: 10 of 11 workspace projects` |
| `pnpm test` | 退出码 0，合计 **317 passed**（contracts 22 / adapters 69 / tools 47 / governance 24 / agent 52 / skills 13 / surface-feishu 55 / mcp-server 5 / eval 30） |
| `pnpm test:e2e` | `Test Files  6 passed (6)`、`Tests  13 passed (13)` |
| `pnpm lint:skills` | `skills: 7 OK` |
| `pnpm kaidan doctor --config config/demo.mock.yaml` | `adapter: mock`、`skills: 7`、`model: 阿里云百炼 通义千问` |
| C2 冻结路径 diff（命令见「验收」第 7 条） | 输出为空 |

## 任务

### 1. `listPending` 不再返回已过期的提案（第 1 轮报告待办 #6）

现状：`packages/governance/src/index.ts` 的 `listPending` 只按 `status = pending` 过滤。
提案是**懒过期**的（只有在 `approve` 被调用时才标记 `expired`），所以一条早就过了 TTL、但没人碰过的提案，
照样会出现在「待我确认」的列表里——用户点下去只会拿到 `EXPIRED`。

要求：`listPending` 的结果里不含 `expiresAt` 已经到期的提案。

- 时间一律用**注入的 clock**（`deps.clock()` / 构造时传进来的那个），不要 `new Date()`——测试靠它才能确定性。
- 是顺手把它们标记成 `expired`（清扫），还是只在列表里过滤，由你定；但**不要改变 `approve` 的既有行为**：
  `tests/e2e/b5-approval.test.ts` 断言「时钟前进 25 小时后第一次 `approve` 报 `EXPIRED` 并把状态置 `expired`，
  第二次报 `INVALID_STATE`」——这条必须仍然通过。
- 契约不动：`ProposalService.listPending` 的签名在 `packages/contracts/**`（冻结），只改实现。

### 2. MCP 入口收口（第 1 轮报告待办 #3 / #4）

`packages/mcp-server/src/bin.ts` 在运行时动态 `import("@kaidan/app")` 来组装依赖——而 `@kaidan/app`
不在本包的依赖清单里（依赖已冻结）。正式入口是 `pnpm -s kaidan mcp --config <配置> --as <openId>`（已实测可用）。

- **不能删 `bin.ts`**：`packages/mcp-server/package.json` 是**冻结路径**，它的 `start` 脚本指向 `src/bin.ts`，
  删了会让一个冻结文件里的脚本指向不存在的文件。
- 改成：不再动态 import，直接往 **stderr** 打印「请使用 `pnpm -s kaidan mcp --config <配置> --as <openId>`」，
  退出码 2；**stdout 一个字都不许写**（MCP 是 stdio 协议）。
- `deploy/README.md`（**不在**冻结清单里，可以改）补一小节：MCP 客户端配置必须写成
  `pnpm -s kaidan mcp --config <配置> --as <openId>`，`-s` 不能省——否则 pnpm 会把
  `> kaidan@0.0.0 …` 横幅写进 stdout，破坏协议。这是 TΩ 实测过的坑，代码里修不掉。

## 可写文件（白名单，只有这些）

- `packages/governance/src/**`、`packages/governance/test/**`
- `packages/mcp-server/src/**`、`packages/mcp-server/test/**`
- `deploy/README.md`

## 禁改（改了就算这个任务失败）

- `.contracts.lock` 列出的全部路径：`packages/contracts/**`、`tests/e2e/**`、`config/**`、`docs/**`、
  `CLAUDE.md`、`README.md`、`.claude/**`、各 `package.json`（含 `packages/mcp-server/package.json`）等
- 白名单以外的任何文件。特别是：`apps/kaidan/**`、`packages/surface-feishu/**` 是 **T5** 的，
  `packages/skills/**` 是 **T7** 的，`packages/agent/**` 推迟到第 2 轮 —— 都不要碰。

## 验收（自己跑，全绿才算完）

1. `pnpm typecheck` → 退出码 0
2. `pnpm test` → 退出码 0，全绿。**新增 governance 用例**：同一个用户下造两条 pending 提案，
   一条在 TTL 内、一条已过期（用注入的 clock 往前拨），`listPending` 只返回前者。
   **反向验证**：把你新加的过滤去掉，这条用例必须变红——把它写成「过期那条也返回」也能过的断言不算数。
3. 过期提案的 `approve` 行为没变：`pnpm --filter @kaidan/governance test` 里原有的过期用例仍然通过。
4. `pnpm test:e2e` → `Tests  13 passed (13)`（b4 / b5 / b6 都用到 listPending 与过期）
5. `bin.ts` 收口：

   ```
   pnpm -s --filter @kaidan/mcp-server start > /tmp/t6-out.txt 2> /tmp/t6-err.txt; echo "exit=$?"
   wc -c /tmp/t6-out.txt; grep -c 'pnpm -s kaidan mcp' /tmp/t6-err.txt
   ```

   期望：`exit=2`、`/tmp/t6-out.txt` 是 0 字节、stderr 里能 grep 到 `pnpm -s kaidan mcp`。
6. 正式入口仍然可用：

   ```
   printf '' | pnpm -s kaidan mcp --config config/demo.mock.yaml --as ou_rep_zhang > /tmp/t6-mcp.txt 2>/dev/null; echo "exit=$?"; wc -c /tmp/t6-mcp.txt
   ```

   期望：正常退出（stdin 关闭即停），stdout 为空（没有协议消息也没有横幅）。
   另外 `grep -n 'pnpm -s kaidan mcp' deploy/README.md` 要有命中。
7. 冻结路径零改动：

   ```
   git diff --stat baseline-t0 -- packages/contracts tests/e2e config package.json pnpm-lock.yaml \
     pnpm-workspace.yaml tsconfig.base.json 'packages/*/package.json' apps/kaidan/package.json docs CLAUDE.md README.md
   ```

   → 输出为空

验收过不了就继续改。确信是验收标准本身写错了，停下来报告，不要改验收。

## 完成后

```
git add -A && git commit -m "t6: listPending 过滤已过期提案；mcp-server bin 收口到 pnpm -s kaidan mcp"
```

然后输出回执，最后一行严格按这个格式：

```
RECEIPT T6 status=<done|blocked> commit=<短hash> checks=<通过数>/7 files=<改动文件数>
```

回执正文包含：

- 每条验收命令的**实际输出**关键行（不是「通过了」）。`pnpm test` 因为加了用例，总数会从 317 变大，写清楚新数字。
- 第 2 条的**反向验证**结果：去掉过滤之后那条用例确实红了（贴失败输出的关键行），再改回来。
- 改了哪些文件；如果 blocked：卡在哪、试过什么、需要什么决定
