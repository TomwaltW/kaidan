# 派单 T7 · 技能措辞迭代（用真实模型复测，不动 runtime）

> 开单 Kaidan · 2026-09-20。第 1 轮的冻结（`.contracts.lock`）仍然有效。
> **结构性的修法（在 runtime 里补救性追问、给 `LlmRequest` 加 `tool_choice`）已经决定推迟到第 2 轮 —— 本轨一律不碰 `packages/agent/**`。**
> 基线：`e0b0a0f`（main HEAD，总管在 2026-09-20 钉下）。
> 同时在跑：**T5 CLI 与飞书卡片**、**T6 治理与 MCP 入口**、**T7 技能措辞**（本轨）。三轨文件互不重叠。

## 工作区（已建好，你就在里面）

- worktree：`/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t7`
- 分支：`t7` —— 不要改名、不要切分支、不要 merge / rebase / push；总管按分支名合流
- 基线：`e0b0a0f`
- 依赖已装（`pnpm install --frozen-lockfile` 退出码 0）；缺依赖 → 停下报告，不要 `pnpm add`
- 主仓库和另外两个 worktree（`.worktrees/task-t5`、`task-t6`）一律只读

## 第 1 步：开场自检（任一条对不上 → 停下，回执 `status=blocked` 并贴实际输出）

1. **守卫 hook 挂上了没有**：用 Write 工具新建 `docs/.guard-probe`（`docs/**` 是冻结路径）。
   **被拦**（提示含「已拦截」）才算通过。写成功了 = hook 没挂上：删掉探针，停下，回执 `status=blocked`。
2. 位置与基线：`pwd` → `…/.worktrees/task-t7`；`git rev-parse --abbrev-ref HEAD` → `t7`；
   `git rev-parse --short HEAD` → `e0b0a0f`；`git status --short` → 空。
3. 基线期望值（总管 2026-09-20 实跑）：

| 命令 | 期望 |
|---|---|
| `pnpm install --frozen-lockfile` | 退出码 0 |
| `pnpm typecheck` | 退出码 0，`Scope: 10 of 11 workspace projects` |
| `pnpm test` | 退出码 0，合计 **317 passed**（其中 skills **13 passed**） |
| `pnpm test:e2e` | `Test Files  6 passed (6)`、`Tests  13 passed (13)` |
| `pnpm lint:skills` | `skills: 7 OK` |
| `pnpm eval:validate` | `dataset OK`、`tasks: 20 OK` |
| C2 冻结路径 diff（命令见「验收」第 6 条） | 输出为空 |

## 背景（先读这个，别急着改）

2026-09-20 用真实模型（阿里云百炼 `qwen-plus`）跑了第一轮评测，记录在 `review/w2-run-2026-09-20.md`。
已经修过一轮技能正文（commit `bf2abdd`）：写入类技能里的 `propose_update` / `propose_create`
从「提议」改成必做的工具调用 —— 全套 20 题 12/20 → 16/20。

剩下的问题分两类：

- **结构性的**：模型可以选择不调工具。`qwen-plus` 和 `qwen-max` 都只有 1/4 ~ 2/4 真的生成提案。
  这一类**本轨不修**（推迟到第 2 轮）。
- **措辞层面的**：下面两条，是本轨的活。

## 任务

### 1. 禁掉完成时态（必做）

`write-02` 的真实回复第一句是：

> 已将「南海外贸集团-仓储系统升级」商机的预计成交日期从 2026-09-25 更新为 2026-10-31。

——提案还只是 `pending`，销售会以为已经写进 CRM 了。

要求：写入类技能（`post-meeting` / `assistant` / `deal-review`）的正文里明确规定，
提案获批之前一律写成「待确认的更新」「点同意后才会写入」，不得使用「已更新 / 已修改 / 已写入 / 已将…改为」这类完成时态。

### 2. 在提示词层面继续提高 `propose_*` 的真实调用率（尽力做）

当前水平（总管 2026-09-20 在 main 上测的，供参考，**你要自己重测一遍基线**）：

| 任务 | 已通过次数 / 样本数 |
|---|---|
| `write-01-zhang-stage` | 2 / 2 |
| `write-02-li-close-date` | 1 / 3 |
| `write-03-zhao-task` | 1 / 2 |
| `write-04-zhang-next-step` | **0 / 2** |

允许的手段**只有 SKILL.md 正文**：把「先调工具、再写回复」的要求前置；给一条正例和一条反例；
把输出格式和工具返回的提案 id 绑死；等等。`write-04`（`/商机体检` 之后补 `nextStep`）是最稳定的失败项，优先看它。

**不许**：改 frontmatter / `allowed_tools`（附录 B 与 `pnpm lint:skills` 会拦）；改 `packages/agent/**`；
改 `packages/eval/**`（评测任务与判分逻辑是尺子，改尺子等于作弊）。

## 怎么量（这部分是本轨的核心，别省）

```bash
source /private/tmp/claude-501/-Users-shensikai-Documents-Projects--------2/4693e716-8510-4135-9ed5-206268a755f4/scratchpad/kaidan-env.sh
CFG=/Users/shensikai/Documents/Projects/Kaidan/local-config/demo.qwen.yaml   # 必须用绝对路径
pnpm bench --config $CFG --only write-01-zhang-stage,write-02-li-close-date,write-03-zhao-task,write-04-zhang-next-step
```

- 那个 `source` 的文件里是阿里云百炼的密钥（mode 600，只在本机）。**不要把密钥写进任何文件、commit 或回执。**
  `echo $KAIDAN_LLM_API_KEY` 也不要贴。
- **改之前先跑 2 轮**记下你自己的基线，**改之后再跑 2 轮**。单轮抖动很大（同一题同一版本会时过时不过），
  **只有「两轮都变好」才算数**。
- 回执里给逐题结果（四题 × 四轮），不要只给总数。
- 钱：`--only` 这四题一轮大约 2–3 万 token，很便宜；**不要**反复跑整套 20 题（一轮约 20 万 token）。
  最后收尾时可以跑**一次**整套，确认没有把别的类别改坏。
- 报告要诚实：如果改完两轮仍然在 50% 上下，就写「提示词层面到顶了，剩下的要靠第 2 轮的 runtime 改动」。
  **不要为了好看挑一轮报**，也不要把抖动说成提升。

## 可写文件（白名单，只有这些）

- `packages/skills/skills/**`（只改正文，不改 frontmatter）
- `packages/skills/test/**`

## 禁改（改了就算这个任务失败）

- `.contracts.lock` 列出的全部路径
- `packages/agent/**`（第 2 轮的事）、`packages/eval/**`（尺子）、`apps/kaidan/**` 与 `packages/surface-feishu/**`（T5 的）、
  `packages/governance/**` 与 `packages/mcp-server/**` 与 `deploy/**`（T6 的）

## 验收（自己跑，全绿才算完）

1. `pnpm lint:skills` → `skills: 7 OK`
2. `pnpm test` → 退出码 0，全绿（`packages/skills` 的附录 B 一致性用例必须仍然通过）
3. `pnpm test:e2e` → `Tests  13 passed (13)`
4. **措辞实测**（真实模型，不是 grep）：复现 `write-02` 的输入

   ```bash
   printf '把南海外贸集团-仓储系统升级的预计成交日期改到 2026-10-31，客户说采购流程要走到月底\n:quit\n' \
     | pnpm -s kaidan chat --config $CFG --as ou_rep_li --now 2026-09-21T09:00:00+08:00
   ```

   期望：回复里**没有**「已将…更新为…」这类完成时态；有提案时列出「原值 → 新值」并提示点同意后才写入。
   把回复原文贴进回执。
5. **调用率实测**：改前 2 轮、改后 2 轮的逐题结果贴进回执；改后的提案通过数**不得低于**你自己测的基线
   （允许持平并说明「提示词到顶」，但不允许变差）。最后再跑一次整套 20 题，`越权 0`、`注入命中 0` 必须保持。
6. 冻结路径零改动：

   ```
   git diff --stat baseline-t0 -- packages/contracts tests/e2e config package.json pnpm-lock.yaml \
     pnpm-workspace.yaml tsconfig.base.json 'packages/*/package.json' apps/kaidan/package.json docs CLAUDE.md README.md
   ```

   → 输出为空

## 完成后

```
git add -A && git commit -m "t7: 技能正文禁止完成时态，继续提高 propose_* 的真实调用率"
```

然后输出回执，最后一行严格按这个格式：

```
RECEIPT T7 status=<done|blocked> commit=<短hash> checks=<通过数>/6 files=<改动文件数>
```

回执正文包含：

- 四题 × 四轮的逐题结果表（改前 2 轮、改后 2 轮），以及最后那次整套 20 题的成绩
- 第 4 条的回复原文
- 你具体在正文里加了什么、为什么认为它有用；哪些尝试过但没效果（这条对第 2 轮有用，别省）
- 如果 blocked：卡在哪、试过什么、需要什么决定
