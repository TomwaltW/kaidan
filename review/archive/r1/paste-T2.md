# 派单 T2 · 运行时与治理（提案 / 审批 / 审计 + provider + 技能加载 + Agent 循环）

> 开单 Kaidan 第 1 轮并行：T1–T4 同时开工，TΩ 最后按分支名合流。生成于 2026-09-18，基线 `6d41265`（= tag `baseline-t0`）。
> 本文件 = 抬头（工作区 + 开场自检）+ `docs/dispatch/T2.md` 原文。原文里的「## 工作区」一节已由抬头替代，其余一字未改。

## 工作区（已建好，你就在里面）

- worktree：`/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t2`
- 分支：`t2` —— TΩ 按分支名 `t2` 合流：不要改名、不要切分支、不要 merge / rebase / push
- 基线：`6d41265`（= `baseline-t0`，建 worktree 时主干 main 的 HEAD）
- 依赖已装（`pnpm install --frozen-lockfile` 退出码 0）；缺依赖 → 停下报告，不要 `pnpm add`
- 主仓库 `/Users/shensikai/Documents/Projects/Kaidan/kaidan` 和另外三个 worktree（`.worktrees/task-t*`）一律只读：不要在那里改文件、不要在那里 commit

## 第 1 步：开场自检（任一条对不上 → 停下，回执 `status=blocked` 并贴实际输出；不要去"修"基线）

1. **守卫 hook 挂上了没有**：用 Write 工具新建 `docs/.guard-probe`（内容随意；`docs/**` 是冻结路径）。
   **被拦**（提示含「已拦截」）才算通过。如果写成功了 = hook 没挂上，冻结路径此刻没有任何保护：
   删掉这个探针文件（它不在 git 里，删它不算改冻结路径），停下，回执 `status=blocked`，写明「guard hook 未生效」。
2. 位置与基线：`pwd` → `/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t2`；`git rev-parse --abbrev-ref HEAD` → `t2`；`git rev-parse --short HEAD` → `6d41265`；`git status --short` → 空。
3. 基线期望值（总管在 task-t1 实跑、可复现；四个 worktree 同一基线，结果相同）：

| 命令 | 期望 |
|---|---|
| `pnpm install --frozen-lockfile` | 退出码 0 |
| `pnpm typecheck` | 退出码 0，`Scope: 10 of 11 workspace projects` |
| `pnpm test` | 退出码 0：contracts `Tests  22 passed (22)`，其余 9 个包 `No test files found, exiting with code 0` |
| `pnpm --filter @kaidan/contracts test` | `Tests  22 passed (22)` |
| `pnpm test:e2e` | 退出码 1：`Test Files  6 failed (6)`、`Tests  13 failed (13)`，13 条都是 `KaidanError: @kaidan/agent.createScriptedProvider 尚未实现`。基线本来就红，TΩ 合流后才会绿；不是你的回归，也不在你的验收里 |
| `pnpm kaidan doctor --config config/demo.mock.yaml` | 退出码 1：`错误 [NOT_IMPLEMENTED]：@kaidan/adapters.createAdapter 尚未实现` |
| C2 `git diff --stat baseline-t0 -- packages/contracts tests/e2e config package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json 'packages/*/package.json' apps/kaidan/package.json` | 输出为空 |
| `pnpm --filter @kaidan/governance test` / `agent` | `No test files found, exiting with code 0`（0 个用例，从零写起） |

## 并行须知

- 同时在跑：T1 数据与工具层（task-t1）、T2 运行时与治理（task-t2）、T3 技能包与评测（task-t3）、T4 飞书入口与部署（task-t4）。只写自己的白名单；别的包对你"不可见"（spec 3.4），测试一律用自己 test 目录里的 fake。
- 完成后按原文「完成后」在本 worktree 的 `t2` 分支上 commit，并输出回执；最后一行 `RECEIPT T2 status=… commit=… checks=…/… files=…`。

---

# 任务 T2 — 运行时与治理（提案 / 审批 / 审计 + provider + 技能加载 + Agent 循环）

## 工作区
（已由本文件抬头替代：worktree 已建在 `/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t2`，分支 `t2`，基线 `6d41265`，依赖已装。不要执行 `git worktree add`，也不要 `cd ../kaidan-t2`。）

## 先读
docs/dev-spec-2026-09-18.md —— 本轮唯一权威文档。
重点读：第 3 节冻结契约（governance.ts、agent.ts、tools.ts 中的 ToolRegistry、format.ts、factories.ts）、第 3.2 节行为约定第 1、4、5、6、7、9 条、第 3.3 节失败面、第 6 节 T2 那一行；以及根目录 CLAUDE.md 的硬规则。

## 目标
实现 @kaidan/governance（createGovernance：基于 node:sqlite 的 ProposalService、ApprovalService、AuditLog）与 @kaidan/agent（createAgentRuntime、createOpenAICompatibleProvider、createScriptedProvider、loadSkills），并写足单元测试。

## 可写文件（白名单，只有这些）
- packages/governance/src/**、packages/governance/test/**
- packages/agent/src/**、packages/agent/test/**

## 禁改（改了就算这个任务失败）
- docs/dev-spec-2026-09-18.md 与 .contracts.lock 列出的全部路径（契约、根配置、各包 package.json、tests/e2e、config）
- 白名单以外的任何文件（包括 apps/kaidan/** 与其他包）

契约不对就停下来报告，不要自己改。你改通了，其他三个 track 会全挂，而且要到合流才发现。

## 实现要点
- governance 测试用内存版 fake RomAdapter（自己写在 test 目录），不依赖 @kaidan/adapters（T1 正在并行实现）；数据库一律 ":memory:"；时间注入 clock。
- 审批规则、幂等、过期、乐观并发严格按 governance.ts 中 ApprovalService 的注释实现；提交时以 approver 身份调用 adapter，idempotencyKey = proposalId；比较 before 与当前值时，before 为 null 与字段不存在视为相等。
- agent 测试用 fake ToolRegistry 与真实的 governance（同包内可用）或 fake；技能测试文件放在 test 目录的临时目录里，不依赖 packages/skills 的内容（T3 正在并行编写）。
- OpenAI 兼容 provider 只用 Node 内置 fetch；测试用 vi.stubGlobal("fetch", …) 或内部可注入 fetch 的工厂，覆盖 tool_calls 映射、usage 映射、429、500、超时、缺密钥。
- 工具规格的 parameters 去掉顶层 "$schema" 键（部分国产模型接口不接受）。

## 验收（自己跑，全绿才算完）
1. `pnpm install --frozen-lockfile` → 退出码 0
2. `pnpm typecheck` → 退出码 0
3. `pnpm test` → 退出码 0
4. `pnpm --filter @kaidan/governance test` → ≥ 15 passed，覆盖第 6 节 T2 行①列出的全部情形
5. `pnpm --filter @kaidan/agent test` → ≥ 20 passed，覆盖第 6 节 T2 行②列出的全部情形
6. `git diff --stat baseline-t0 -- packages/contracts tests/e2e config package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json 'packages/*/package.json' apps/kaidan/package.json` → 输出为空

验收过不了就继续改。确信是验收标准本身写错了，停下来报告，不要改验收。

## 完成后
git add -A && git commit -m "t2: 运行时与治理（governance + agent）"

然后输出回执，最后一行严格按这个格式：
RECEIPT T2 status=<done|blocked> commit=<短hash> checks=<通过数>/<总数> files=<改动文件数>

回执正文包含：
- 每条验收命令的实际输出（真实输出的关键几行，不是"通过了"）
- 改了哪些文件
- 如果 blocked：卡在哪、试过什么、需要什么决定
