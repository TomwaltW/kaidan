# 派单 T8 · `doctor --online`：多维表格侧的真机预检

> 开单 Kaidan · 2026-09-20 下午。第 1 轮的冻结（`.contracts.lock`）仍然有效；结构性改动推迟到第 2 轮。
> 基线：`5572244`（main HEAD，总管钉下）。
> 同时在跑：**T8 多维表格预检**（本轨）、**T9 serve 真机排错输出**、**T10 演示脚本与验收陪跑清单**。三轨文件互不重叠。

## 这批活要解决的问题

任务 3（飞书测试企业 + 人工验收）马上开始。第 1 轮报告第 4 节列了十几个**从没在真机上跑过**的接口点，
现在的做法是「按 `docs/manual-acceptance.md` 12 项一条条点，坏了再回来查」——一轮要半天。
本轨把多维表格这一侧的检查压缩成**一条只读命令**：配置填错、协作者没加、字段名对不上，30 秒之内就能看出来，
而不是等到销售发 `/晨报` 才报错。

## 工作区（已建好，你就在里面）

- worktree：`/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t8`
- 分支：`t8` —— 不要改名、不要切分支、不要 merge / rebase / push；总管按分支名合流
- 基线：`5572244`
- 依赖已装（`pnpm install --frozen-lockfile` 退出码 0）；缺依赖 → 停下报告，不要 `pnpm add`
- 主仓库与另外两个 worktree（`task-t9`、`task-t10`）一律只读

## 第 1 步：开场自检（任一条对不上 → 停下，回执 `status=blocked` 并贴实际输出）

1. **守卫 hook**：用 Write 工具新建 `docs/.guard-probe`（`docs/**` 是冻结路径）。**被拦**（提示含「已拦截」）才算通过。
   写成功了 = hook 没挂上：删掉探针，停下，回执 `status=blocked`。
2. 位置与基线：`pwd` → `…/.worktrees/task-t8`；`git rev-parse --abbrev-ref HEAD` → `t8`；
   `git rev-parse --short HEAD` → `5572244`；`git status --short` → 空。
3. 基线期望值（总管 2026-09-20 下午在 task-t8 实跑）：

| 命令 | 期望 |
|---|---|
| `pnpm install --frozen-lockfile` | 退出码 0 |
| `pnpm typecheck` | 退出码 0，`Scope: 10 of 11 workspace projects` |
| `pnpm test` | 退出码 0，合计 **326 passed**（contracts 22 / adapters 69 / tools 47 / governance 25 / agent 52 / skills 13 / surface-feishu 60 / mcp-server 5 / apps-kaidan 3 / eval 30） |
| `pnpm test:e2e` | `Test Files  6 passed (6)`、`Tests  13 passed (13)` |
| `pnpm kaidan doctor --config config/demo.mock.yaml` | `adapter: mock`、`skills: 7`、`users: 5`，退出码 0 |

## 任务

给 `doctor` 加一个 **`--online`** 开关：不带它时行为**一个字都不能变**（现在的离线自检是 T0 定下的验收项）；
带上它时，在离线检查之后，用**应用身份**对真实的多维表格做一轮**只读**检查。

### 要检查什么（按这个顺序，每条单独出一行结果）

1. **凭证**：`FEISHU_APP_ID` / `FEISHU_APP_SECRET` 在不在环境里；能不能换到 tenant_access_token。
2. **appToken 可达**：配置里的 `adapter.bitable.appToken` 能不能读到（应用是不是这张表的协作者）。
3. **表齐不齐**：`mapping.yaml` 里每个 `tableId` 是否存在。
4. **字段齐不齐**：每张表里 mapping 写到的字段名是否存在；类型对不对得上（人员 / 关联 / 日期 / 单选这几类尤其要看）。
5. **抽样读**：每张表读 1 条记录，确认解析不炸；**只打印条数与字段名，不打印任何记录内容**。
6. **汇总**：全过 → 退出码 0；有问题 → 退出码 1，并且每条问题都给**一句可执行的修法**
   （例：「表 `tbl_xxx` 找不到字段「客户名称」：请在多维表格里核对字段名，或改 mapping.yaml 的 `account.name`」）。

### 硬要求

- **只读。** 一条写操作都不许发（不许建记录、不许改记录、不许「写一条再删掉」来测权限）。
  客户的 CRM 不是试验田，写入只能走提案 + 人点同意。
- **不许打印个人信息**：手机号、联系人姓名、CRM 正文一律不进 stdout/stderr。字段**名**可以，字段**值**不行。
- **不猜 SDK**：飞书 SDK 的方法名与参数以 `node_modules/@larksuiteoapi/node-sdk` 里的**类型定义**为准。
  拿不准就写清楚 TODO 并在回执里列出来，不要凭记忆编 API。
- **错误要能看懂**：飞书返回的错误至少打印 `code` / `msg` / `log_id`；已知的频控码（`99991400`、`1254290`）
  要翻译成「触发频控，稍后重试」这种人话。
- 离线也要能跑测试：真实 SDK 调用封装在一个接口后面，测试用 fake 实现（`packages/adapters` 现有测试就是这么写的）。

## 可写文件（白名单，只有这些）

- `apps/kaidan/src/**`、`apps/kaidan/test/**`
- `packages/adapters/src/**`、`packages/adapters/test/**`

## 禁改（改了就算这个任务失败）

- `.contracts.lock` 列出的全部路径（`packages/contracts/**`、`tests/e2e/**`、`config/**`、`docs/**`、各 `package.json` 等）。
  **契约不够用就停下来报告**，不要自己改：`--online` 是 CLI 层的开关，不应该需要动契约。
- 白名单以外：`packages/surface-feishu/**` 是 **T9** 的，`review/**` 是 **T10** 的，`packages/agent/**` 推迟到第 2 轮。

## 验收（自己跑，全绿才算完）

1. `pnpm typecheck` → 退出码 0
2. `pnpm test` → 全绿。新增测试至少覆盖：
   - 凭证缺失 → 明确报缺哪个环境变量，退出码 1；
   - 表缺失 / 字段缺失 → 各自报出是哪张表哪个字段，并给出修法那句话；
   - 全部通过 → 退出码 0；
   - **只读断言**：用 fake 适配器记录所有写方法的调用次数，跑完 `--online` 后**写调用必须为 0**
     （这条是反向可验证的：把任何一处写调用加进去，这条测试必须变红）。
3. `pnpm test:e2e` → `Tests  13 passed (13)`
4. **不带 `--online` 的行为没变**：`pnpm kaidan doctor --config config/demo.mock.yaml` 的输出与基线逐行一致，退出码 0
5. `--online` 对 mock 适配器的行为：`pnpm kaidan doctor --config config/demo.mock.yaml --online`
   → 明确说明「当前 adapter 是 mock，没有可联网检查的项」，退出码 0（不要假装检查过）
6. C2 冻结路径 diff 为空：

   ```
   git diff --stat baseline-t0 -- packages/contracts tests/e2e config package.json pnpm-lock.yaml \
     pnpm-workspace.yaml tsconfig.base.json 'packages/*/package.json' apps/kaidan/package.json docs CLAUDE.md README.md
   ```

**真机怎么办**：你手上没有飞书测试企业，跑不了真的 `--online`。这是预期内的 —— 把 fake 测试写扎实，
然后在回执里写明「真机未验证」，并列出你调用了哪些 SDK 方法、各自依赖什么权限，
方便总管在用户搭好测试企业之后第一时间验。**不要为了「能跑通」去伪造一个假的成功路径。**

## 完成后

```
git add -A && git commit -m "t8: doctor --online —— 多维表格侧只读真机预检"
```

回执最后一行严格按这个格式：

```
RECEIPT T8 status=<done|blocked> commit=<短hash> checks=<通过数>/6 files=<改动文件数>
```

回执正文包含：每条验收命令的**实际输出**关键行（`pnpm test` 的新总数写清楚）；
`--online` 的输出样例（用 fake 跑出来的）；调用了哪些 SDK 方法、依赖哪些权限、哪些没真机验证过；
如果 blocked：卡在哪、试过什么、需要什么决定。
