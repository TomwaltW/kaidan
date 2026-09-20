# 派单 T5 · 出错时不公示「AI 生成」＋ chat 管道输入的退出码

> 开单 Kaidan · 2026-09-20。第 1 轮的冻结（`.contracts.lock`）仍然有效，本批只做不碰冻结路径的小修；
> 结构性的改动（给 `LlmRequest` 加 `tool_choice` 之类）已决定推迟到第 2 轮，本轨不要碰。
> 基线：`e0b0a0f`（main HEAD，总管在 2026-09-20 钉下）。
> 同时在跑：**T5 CLI 与飞书卡片**（本轨）、**T6 治理与 MCP 入口**、**T7 技能措辞**。三轨文件互不重叠。

## 工作区（已建好，你就在里面）

- worktree：`/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t5`
- 分支：`t5` —— 不要改名、不要切分支、不要 merge / rebase / push；总管按分支名合流
- 基线：`e0b0a0f`
- 依赖已装（`pnpm install --frozen-lockfile` 退出码 0）；缺依赖 → 停下报告，不要 `pnpm add`
- 主仓库 `/Users/shensikai/Documents/Projects/Kaidan/kaidan` 和另外两个 worktree（`.worktrees/task-t6`、`task-t7`）一律只读

## 第 1 步：开场自检（任一条对不上 → 停下，回执 `status=blocked` 并贴实际输出；不要去「修」基线）

1. **守卫 hook 挂上了没有**：用 Write 工具新建 `docs/.guard-probe`（内容随意；`docs/**` 是冻结路径）。
   **被拦**（提示含「已拦截」）才算通过。写成功了 = hook 没挂上，冻结路径此刻没有任何保护：
   删掉这个探针文件，停下，回执 `status=blocked`，写明「guard hook 未生效」。
2. 位置与基线：`pwd` → `…/.worktrees/task-t5`；`git rev-parse --abbrev-ref HEAD` → `t5`；
   `git rev-parse --short HEAD` → `e0b0a0f`；`git status --short` → 空。
3. 基线期望值（总管 2026-09-20 在 task-t5 里实跑，可复现）：

| 命令 | 期望 |
|---|---|
| `pnpm install --frozen-lockfile` | 退出码 0 |
| `pnpm typecheck` | 退出码 0，`Scope: 10 of 11 workspace projects` |
| `pnpm test` | 退出码 0，合计 **317 passed**（contracts 22 / adapters 69 / tools 47 / governance 24 / agent 52 / skills 13 / surface-feishu 55 / mcp-server 5 / eval 30） |
| `pnpm test:e2e` | `Test Files  6 passed (6)`、`Tests  13 passed (13)` |
| `pnpm lint:skills` | `skills: 7 OK` |
| `pnpm kaidan doctor --config config/demo.mock.yaml` | `adapter: mock`、`skills: 7`、`model: 阿里云百炼 通义千问` |
| C2 冻结路径 diff（命令见「验收」第 6 条） | 输出为空 |

## 任务

### 1. 出错时不加「内容由 AI 生成」页脚

2026-09-20 用真实模型实跑时发现（`review/w2-run-2026-09-20.md` 第 5 节；也是第 1 轮报告第 5 节待办 #11）：
`AgentRunResult.stoppedBy === "error"` 时，回复正文是**系统消息**（例如「模型服务配置有误，请联系管理员检查模型配置。」），
并不是模型生成的内容，却照样带上「内容由 AI 生成 · 阿里云百炼 通义千问」。模型公示必须真实。

**规则（CLI 与飞书卡片必须一致）**：

- `stoppedBy === "error"` → **不加**公示页脚；
- `final` / `max_steps` / `budget` → 维持现状，加页脚（这几种情况正文确实是模型生成的，只是后面追加了一句系统提示）。

改动位置：

- CLI：`apps/kaidan/src/cli.ts` 的 `printResult`（现在无条件 `out("—— 内容由 AI 生成 · …")`）
- 飞书：`packages/surface-feishu/src/**` 里组装 reply 卡片的地方（页脚文案在 `cards.ts` 里拼）

**契约怎么说**：`packages/contracts/src/surface.ts` 只规定了「正常消息 → 先发 reply 卡片（正文 + 页脚模型公示）」
和页脚的格式，没有规定出错时也必须带页脚 → 本改动**不需要动契约**。
`tests/e2e/b6-feishu.test.ts` 断言的是正常路径的页脚，必须保持绿。

### 2. 管道输入时 chat 以退出码 1 结束

复现（当前基线）：

```
printf '/晨报\n:quit\n' | pnpm -s kaidan chat --config config/demo.mock.yaml --as ou_rep_zhang
```

末尾会打印「错误：readline was closed」，退出码 1。交互式使用不受影响，但**录演示脚本、写自动化都会被绊到**。
原因在 `apps/kaidan/src/cli.ts` 的 chat 循环：stdin 结束后 readline 已关闭，代码仍调用 `rl.prompt()`。

要求：`:quit` 退出与 stdin 读到 EOF 两条路径都正常收尾，**退出码 0**，且不打印这条错误。

## 可写文件（白名单，只有这些）

- `apps/kaidan/src/**`、`apps/kaidan/test/**`（`apps/kaidan/tsconfig.json` 已经 include 了 `test`，新建测试目录即可）
- `packages/surface-feishu/src/**`、`packages/surface-feishu/test/**`

## 禁改（改了就算这个任务失败）

- `.contracts.lock` 列出的全部路径：`packages/contracts/**`、`tests/e2e/**`、`config/**`、`docs/**`、
  `CLAUDE.md`、`README.md`、`.claude/**`、各 `package.json`、`pnpm-lock.yaml`、`tsconfig.base.json` 等
- 白名单以外的任何文件。特别是：`packages/governance/**`、`packages/mcp-server/**`、`deploy/**` 是 **T6** 的，
  `packages/skills/**` 是 **T7** 的，`packages/agent/**` 推迟到第 2 轮 —— 都不要碰。

契约不对就停下来报告，不要自己改。

## 验收（自己跑，全绿才算完）

1. `pnpm typecheck` → 退出码 0
2. `pnpm test` → 退出码 0，全绿。**新增 surface-feishu 用例，两个方向都要断言**：
   - `stoppedBy: "error"` 的一次 `agent.run` → reply 卡片正文仍然发出去了（内容是那句系统消息），但**不含**「内容由 AI 生成」；
   - 正常一次 `agent.run`（`final`）→ reply 卡片**仍然含**「内容由 AI 生成 · …」。
   只断言「不含」会被「卡片压根没发」蒙混过去，所以两条缺一不可。
3. `pnpm test:e2e` → `Tests  13 passed (13)`（B6 的页脚断言必须仍然通过）
4. CLI 出错路径实跑（**不需要真密钥**，bogus key 会拿到 401，不花钱）：

   ```
   KAIDAN_LLM_API_KEY=bogus-key printf '今天有什么安排\n:quit\n' \
     | pnpm -s kaidan chat --config config/demo.mock.yaml --as ou_rep_zhang; echo "exit=$?"
   ```

   期望：正文是「模型服务配置有误…」、**不带**「内容由 AI 生成」页脚、`exit=0`、不出现「readline was closed」。
   本机连不上网时，改用「脚本 provider + 会抛错的 fake」写单测覆盖同一条路径，并在回执里说明为什么换。
5. 管道收尾实跑：

   ```
   printf ':quit\n' | pnpm -s kaidan chat --config config/demo.mock.yaml --as ou_rep_zhang \
     --script apps/kaidan/test/fixtures/<你造的 steps>.json; echo "exit=$?"
   ```

   期望 `exit=0`，且没有「readline was closed」。steps 文件放白名单内的 `apps/kaidan/test/fixtures/`。
6. 冻结路径零改动：

   ```
   git diff --stat baseline-t0 -- packages/contracts tests/e2e config package.json pnpm-lock.yaml \
     pnpm-workspace.yaml tsconfig.base.json 'packages/*/package.json' apps/kaidan/package.json docs CLAUDE.md README.md
   ```

   → 输出为空

验收过不了就继续改。确信是验收标准本身写错了，停下来报告，不要改验收。

## 完成后

```
git add -A && git commit -m "t5: 出错回复不加 AI 公示页脚；chat 管道输入正常收尾"
```

然后输出回执，最后一行严格按这个格式：

```
RECEIPT T5 status=<done|blocked> commit=<短hash> checks=<通过数>/6 files=<改动文件数>
```

回执正文包含：

- 每条验收命令的**实际输出**关键行（不是「通过了」）。`pnpm test` 因为加了用例，总数会从 317 变大，写清楚新数字。
- 改了哪些文件
- 如果 blocked：卡在哪、试过什么、需要什么决定
