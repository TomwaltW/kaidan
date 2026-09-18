# 派单 T4 · 飞书入口与部署（长连接 + 消息 + 卡片 + 审批回调 + 定时 + 身份解析 + Dockerfile + CI）

> 开单 Kaidan 第 1 轮并行：T1–T4 同时开工，TΩ 最后按分支名合流。生成于 2026-09-18，基线 `6d41265`（= tag `baseline-t0`）。
> 本文件 = 抬头（工作区 + 开场自检）+ `docs/dispatch/T4.md` 原文。原文里的「## 工作区」一节已由抬头替代，其余一字未改。

## 工作区（已建好，你就在里面）

- worktree：`/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t4`
- 分支：`t4` —— TΩ 按分支名 `t4` 合流：不要改名、不要切分支、不要 merge / rebase / push
- 基线：`6d41265`（= `baseline-t0`，建 worktree 时主干 main 的 HEAD）
- 依赖已装（`pnpm install --frozen-lockfile` 退出码 0）；缺依赖 → 停下报告，不要 `pnpm add`
- 主仓库 `/Users/shensikai/Documents/Projects/Kaidan/kaidan` 和另外三个 worktree（`.worktrees/task-t*`）一律只读：不要在那里改文件、不要在那里 commit

## 第 1 步：开场自检（任一条对不上 → 停下，回执 `status=blocked` 并贴实际输出；不要去"修"基线）

1. **守卫 hook 挂上了没有**：用 Write 工具新建 `docs/.guard-probe`（内容随意；`docs/**` 是冻结路径）。
   **被拦**（提示含「已拦截」）才算通过。如果写成功了 = hook 没挂上，冻结路径此刻没有任何保护：
   删掉这个探针文件（它不在 git 里，删它不算改冻结路径），停下，回执 `status=blocked`，写明「guard hook 未生效」。
2. 位置与基线：`pwd` → `/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t4`；`git rev-parse --abbrev-ref HEAD` → `t4`；`git rev-parse --short HEAD` → `6d41265`；`git status --short` → 空。
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
| `pnpm --filter @kaidan/surface-feishu test` | `No test files found, exiting with code 0`（0 个用例，从零写起） |
| `ls deploy .github/workflows` | 各只有一个 T0 占位 `.gitkeep`（可保留，也可在交付时删掉） |

## 并行须知

- 同时在跑：T1 数据与工具层（task-t1）、T2 运行时与治理（task-t2）、T3 技能包与评测（task-t3）、T4 飞书入口与部署（task-t4）。只写自己的白名单；别的包对你"不可见"（spec 3.4），测试一律用自己 test 目录里的 fake。
- 完成后按原文「完成后」在本 worktree 的 `t4` 分支上 commit，并输出回执；最后一行 `RECEIPT T4 status=… commit=… checks=…/… files=…`。

---

# 任务 T4 — 飞书入口与部署（长连接 + 消息 + 卡片 + 审批回调 + 定时 + 身份解析 + Dockerfile + CI）

## 工作区
（已由本文件抬头替代：worktree 已建在 `/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t4`，分支 `t4`，基线 `6d41265`，依赖已装。不要执行 `git worktree add`，也不要 `cd ../kaidan-t4`。）

## 先读
docs/dev-spec-2026-09-18.md —— 本轮唯一权威文档。
重点读：第 3 节冻结契约（surface.ts、agent.ts 中 AgentRuntime / AgentRunResult / ModelDisclosure、governance.ts 中 Governance / ApprovalService、config.ts、factories.ts）、第 3.2 节行为约定第 8 条、第 3.3 节失败面、第 2.2 节 B6、第 6 节 T4 那一行、附录 D；以及根目录 CLAUDE.md 的硬规则。

## 目标
实现 @kaidan/surface-feishu：createConfigIdentityResolver、createFeishuSurface（handleMessage / handleCardAction / runScheduled 三个处理器 + start / stop）、三类卡片构建、飞书事件与回调载荷解析、真实的 LarkClientLike 实现、定时任务；并交付 deploy/Dockerfile、deploy/README.md（飞书应用配置与上线步骤）与 .github/workflows/ci.yml。

## 可写文件（白名单，只有这些）
- packages/surface-feishu/src/**、packages/surface-feishu/test/**
- deploy/**
- .github/workflows/**

## 禁改（改了就算这个任务失败）
- docs/dev-spec-2026-09-18.md 与 .contracts.lock 列出的全部路径（契约、根配置、各包 package.json、tests/e2e、config）
- 白名单以外的任何文件（包括 apps/kaidan/** 与其他包）

契约不对就停下来报告，不要自己改。你改通了，其他三个 track 会全挂，而且要到合流才发现。

## 实现要点
- 三个处理器写成只依赖 SurfaceDeps 的纯逻辑，测试注入 fake agent（返回预设 AgentRunResult）、fake governance、fake LarkClientLike；不依赖其他 track 的实现（它们正在并行开发）。
- 构造时不联网、不读密钥；start() 才用 @larksuiteoapi/node-sdk 建立长连接（WSClient + EventDispatcher），注册 im.message.receive_v1 与卡片回调 card.action.trigger，并用 croner 按 config.schedules 与 config.timezone 注册晨报 / 周报。SDK 的类名、方法与载荷字段一律以 node_modules 中的类型定义为准。
- 载荷解析抽成纯函数并用样例载荷测试：文本消息 content 是 JSON 字符串；群聊里去掉 @ 占位符并判断是否 @ 了机器人（机器人自身 open_id 在 start() 时获取，解析函数以参数传入）。
- 卡片按附录 D；reply 卡页脚公示文案取 AgentRunResult.disclosure；proposal 卡按钮 value 为 ProposalButtonValue。
- 发送与更新遇到频控最多重试 3 次（0.5s / 1s / 2s），测试用可注入的 sleep，不真的等待。
- deploy/Dockerfile：node:24-slim，启用 corepack，`pnpm install --frozen-lockfile`，默认命令 `pnpm kaidan serve --config /app/config/tenant.yaml`；忽略规则写在 deploy/Dockerfile.dockerignore。deploy/README.md 写清：创建企业自建应用、开启机器人、需要的权限（名称以开放平台后台为准）、事件与回调选择长连接、把应用加为多维表格协作者、环境变量、运行与升级方式。
- CI：Node 24 + pnpm，依次运行 A1–A5 与 `pnpm test:e2e`。

## 验收（自己跑，全绿才算完）
1. `pnpm install --frozen-lockfile` → 退出码 0
2. `pnpm typecheck` → 退出码 0
3. `pnpm test` → 退出码 0
4. `pnpm --filter @kaidan/surface-feishu test` → ≥ 20 passed，覆盖第 6 节 T4 行①列出的全部情形（B6 六种情形各至少一个用例）
5. `test -f deploy/Dockerfile && test -f deploy/README.md && test -f .github/workflows/ci.yml && echo OK` → 输出 OK
6. `git diff --stat baseline-t0 -- packages/contracts tests/e2e config package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json 'packages/*/package.json' apps/kaidan/package.json` → 输出为空

验收过不了就继续改。确信是验收标准本身写错了，停下来报告，不要改验收。

## 完成后
git add -A && git commit -m "t4: 飞书入口与部署（surface-feishu + deploy + CI）"

然后输出回执，最后一行严格按这个格式：
RECEIPT T4 status=<done|blocked> commit=<短hash> checks=<通过数>/<总数> files=<改动文件数>

回执正文包含：
- 每条验收命令的实际输出（真实输出的关键几行，不是"通过了"）
- 改了哪些文件
- 尚未真机验证的飞书 SDK 调用与卡片字段清单
- 如果 blocked：卡在哪、试过什么、需要什么决定
