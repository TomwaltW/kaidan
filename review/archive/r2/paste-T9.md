# 派单 T9 · serve 的真机排错输出（飞书入口侧）

> 开单 Kaidan · 2026-09-20 下午。第 1 轮的冻结（`.contracts.lock`）仍然有效；结构性改动推迟到第 2 轮。
> 基线：`5572244`（main HEAD，总管钉下）。
> 同时在跑：**T8 多维表格预检**、**T9 serve 真机排错输出**（本轨）、**T10 演示脚本与验收陪跑清单**。三轨文件互不重叠。

## 这批活要解决的问题

任务 3 马上开始：用户要在飞书测试企业里把 `serve` 跑起来，按 `docs/manual-acceptance.md` 逐条验收。
第 1 轮报告第 4 节列的未真机项，**全都集中在本轨负责的这一侧**：长连接 `WSClient` + `EventDispatcher`、
卡片回调 `card.action.trigger` 的注册方式（SDK 类型里没有这个键，是照 SDK 源码写的）、
回调先返回空响应再单独换卡、`bot/v3/info` 取机器人 open_id、`im.v1.message.create/patch`、
卡片 JSON 2.0 的字段、按钮 value 的回传形状、频控码 `99991400` / `230020`。

这些**只能在真机上才知道对不对**。本轨不去猜它们对不对，而是保证**一旦不对，日志能一眼看出是哪一条**：
现在出问题多半只看到一句笼统的失败，用户没法把有用的信息贴回来，一轮排错就浪费半天。

## 工作区（已建好，你就在里面）

- worktree：`/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t9`
- 分支：`t9` —— 不要改名、不要切分支、不要 merge / rebase / push；总管按分支名合流
- 基线：`5572244`
- 依赖已装（`pnpm install --frozen-lockfile` 退出码 0）；缺依赖 → 停下报告，不要 `pnpm add`
- 主仓库与另外两个 worktree（`task-t8`、`task-t10`）一律只读

## 第 1 步：开场自检（任一条对不上 → 停下，回执 `status=blocked` 并贴实际输出）

1. **守卫 hook**：用 Write 工具新建 `docs/.guard-probe`（`docs/**` 是冻结路径）。**被拦**才算通过。
   写成功了 = hook 没挂上：删掉探针，停下，回执 `status=blocked`。
2. 位置与基线：`pwd` → `…/.worktrees/task-t9`；`git rev-parse --abbrev-ref HEAD` → `t9`；
   `git rev-parse --short HEAD` → `5572244`；`git status --short` → 空。
3. 基线期望值（总管 2026-09-20 下午实跑）：

| 命令 | 期望 |
|---|---|
| `pnpm install --frozen-lockfile` | 退出码 0 |
| `pnpm typecheck` | 退出码 0，`Scope: 10 of 11 workspace projects` |
| `pnpm test` | 退出码 0，合计 **326 passed**（其中 surface-feishu **60 passed**） |
| `pnpm test:e2e` | `Test Files  6 passed (6)`、`Tests  13 passed (13)` |
| `pnpm kaidan serve --config config/demo.mock.yaml`（缺飞书凭证） | 1 秒内报 `CONFIG：缺少环境变量 FEISHU_APP_ID`，不挂起 |

## 任务

让 `serve` 在真机上**可排错**。三件事：

### 1. 启动自述（一眼看出连上了没有）

`serve` 起来后，往 **stderr** 打一段结构清晰的启动自述，至少包含：

- 租户、adapter 类型、模型公示（沿用 `doctor` 的说法，不要另造一套）；
- **机器人自己的 open_id / name**（`bot/v3/info`；拿不到就明确写「取不到机器人信息：<原因>」，不要静默跳过）；
- 长连接状态：已连接 / 断开 / 重连中，以及订阅了哪些事件与回调（消息事件、`card.action.trigger`）；
- 配置里 `users` 的条数，以及**还有几个是 `TODO_` 占位符**（用户要按提示把 open_id 填进去，这条能省一轮来回）。

断线、重连、重连成功都要各打一行（`docs/manual-acceptance.md` 有一项就是「断网 30 秒再恢复」）。

### 2. 飞书接口出错时，把能查的信息全打出来

任何一次飞书 SDK 调用失败，stderr 至少给出：**哪个调用**（如 `im.v1.message.create`）、`code`、`msg`、`log_id`、
以及这次是**哪类操作**（回消息 / 换卡 / 读机器人信息）。`log_id` 尤其重要：找飞书支持只认它。

已知错误码翻译成人话，并给出下一步：

| code | 说明 | 建议 |
|---|---|---|
| `99991400` | 频控 | 稍后重试；短时间大量消息会触发 |
| `230020` | 机器人没在会话里 / 无权发消息 | 检查应用可用范围与发布版本 |
| 其它 | 原样打印 code + msg + log_id | —— |

没见过的码不要瞎猜含义，原样打印就行。

### 3. 卡片回调链路的可观测性

审批卡按钮（「同意 / 拒绝」）走的是 `card.action.trigger`，这条链路真机上最容易出问题。
收到回调时打一行：回调类型、提案 id、操作人 open_id、处理结果（committed / rejected / 报错码）。
**提案里的 CRM 正文、手机号一律不许进日志**（硬规则第 5 条）。

### 硬要求

- **日志一律 stderr**，stdout 保持干净（硬规则第 9 条）。
- **不许打印个人信息**：手机号、联系人姓名、CRM 正文不进日志；open_id 可以。
- **不猜 SDK**：方法名与参数以 `node_modules/@larksuiteoapi/node-sdk` 的类型定义为准；
  `card.action.trigger` 的注册方式现在是照 SDK 源码写的，**不要凭记忆改它**——真机没验之前，改它风险比留着大。
  确实要改，停下来报告。
- 离线可测：真实 SDK 调用封装在接口后面，测试用 fake（`packages/surface-feishu/test` 现有测试就是这么写的）。
- 日志噪音要可控：默认不刷屏；详细模式用环境变量（例如 `KAIDAN_LOG_LEVEL=debug`）打开，默认 info。

## 可写文件（白名单，只有这些）

- `packages/surface-feishu/src/**`、`packages/surface-feishu/test/**`

## 禁改（改了就算这个任务失败）

- `.contracts.lock` 列出的全部路径。`SurfaceHandlers` 的行为规则写在冻结的 `packages/contracts/src/surface.ts` 注释里：
  **本轨只加日志与错误信息，不改任何对外行为**（发几张卡、卡片长什么样、回调返回什么，一律照旧）。
  需要改行为 → 停下来报告。
- 白名单以外：`apps/kaidan/**` 与 `packages/adapters/**` 是 **T8** 的，`review/**` 是 **T10** 的，
  `packages/agent/**` 推迟到第 2 轮。

## 验收（自己跑，全绿才算完）

1. `pnpm typecheck` → 退出码 0
2. `pnpm test` → 全绿。新增测试至少覆盖：
   - 启动自述包含机器人信息、长连接状态、`TODO_` 占位符计数（用 fake 客户端）；
   - 取机器人信息失败时，自述里明确写「取不到机器人信息：<原因>」而不是静默；
   - SDK 调用失败 → 日志里同时出现 `code`、`msg`、`log_id` 与调用名；
   - `99991400` / `230020` 各自翻译成对应建议；
   - **PII 反向验证**：构造一条带手机号（如 `13800000001`）和 CRM 正文的提案，跑完整条回调链路后，
     断言日志里**不含**这串数字、也不含正文原文。这条要能反向验证：把某处日志改成打印整个提案对象，它必须变红。
3. `pnpm test:e2e` → `Tests  13 passed (13)`（B6 的六种情形不许变）
4. 行为没变：`git diff` 里不出现卡片结构、发卡张数、回调返回值的改动（自己 review 一遍 diff，在回执里说明）
5. 缺凭证时的老行为还在：`pnpm kaidan serve --config config/demo.mock.yaml` → 1 秒内报 `CONFIG：缺少环境变量 FEISHU_APP_ID`
6. C2 冻结路径 diff 为空（命令同 T8 第 6 条）

**真机怎么办**：你手上没有飞书测试企业。把 fake 测试写扎实，在回执里明确写「真机未验证」，
并列出本轨碰到的每一个 SDK 调用点、它依赖什么权限、真机上可能怎么坏。
**不要为了「能跑通」去伪造一个假的成功路径。**

## 完成后

```
git add -A && git commit -m "t9: serve 启动自述、飞书错误码与回调链路的可排错日志"
```

回执最后一行严格按这个格式：

```
RECEIPT T9 status=<done|blocked> commit=<短hash> checks=<通过数>/6 files=<改动文件数>
```

回执正文包含：每条验收命令的**实际输出**关键行；启动自述的样例输出（fake 跑出来的）；
你碰到的 SDK 调用点清单与各自的权限依赖；如果 blocked：卡在哪、试过什么、需要什么决定。
