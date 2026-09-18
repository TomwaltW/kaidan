# 开单 Kaidan · 第 1 轮收尾报告与下一步

> 2026-09-18 · main = `75f7fb0`（tag `mvp-r1`）· 基线 `6d41265`（tag `baseline-t0`）· 仓库 `~/Documents/Projects/Kaidan/kaidan`

> **同日更新**（写完本报告之后又做了这些）：
> - 建了私有远端 https://github.com/TomwaltW/kaidan 并推送 main 与两个 tag；CI 首跑全绿，其中新增的 `image` 作业在 GitHub 上构建了 `deploy/Dockerfile`，镜像里 `doctor` 通过。第 4 节第 3、4 条（镜像、CI）已验证，第 5 节第 4、5 步已完成。
> - bench 缺密钥时开跑前退出，失败说明带原因（第 2 轮待办 #9 已完成）；chat 新增 `--now`，方便用 Mock 数据演示。
> - 接下来要你来跑的事，见 `review/w2-tasks.md`。

## 0. 结论

第 1 轮 MVP 已合流：T1–T4 按序合入、零冲突，全量验收 **9/9**（A1–A6、B1–B6、C1、C2），**317 个单元测试 + 13 个 e2e 全绿**。用 Mock 数据、在本机、不联网，CLI / MCP / 审批流都能完整跑通。

**还没碰过真实环境**：真实国产模型、真实飞书、Docker 镜像构建都没验证过。这三件就是 W2 的活，也决定了 Gate 1（W2 末 ≥ 3 个付费试点）之前的演示能不能站得住。

## 1. 第 1 轮交付

| 任务 | 提交 | 验收 | 新增测试 |
|---|---|---|---|
| T0 骨架 / 契约自检 / e2e 用例 / 组装与 CLI | `b4cdf82`、`6d41265` | 7/7 | contracts 22；e2e 13 条（当时全红） |
| T1 适配器 + 8 个工具 + MCP server | `4ea724f` | 7/7 | adapters 69、tools 47、mcp-server 5 |
| T2 提案 / 审批 / 审计 + provider + Agent 循环 | `0f635f7` | 6/6 | governance 24、agent 52 |
| T3 7 个技能 + 校验器 + 评测集 + 跑分器 | `3b1cfdd` | 9/9 | skills 13、eval 30 |
| T4 飞书入口 + Dockerfile + CI | `c7d430e` | 6/6 | surface-feishu 55 |
| TΩ 合流 + 修缝 | `2845ad9`、`75f7fb0` | 9/9 | e2e 13/13 转绿 |

四轨回执都是 `status=done`。TΩ 复核过：每条分支的改动都在各自白名单内，冻结路径零改动；回执里的数字在 main 上全部复现。

## 2. 合流与清理

- 合入顺序：t1 `31cc85a` → t2 `e06c9e4` → t3 `aa7f5d5` → t4 `50d8c26`，每次合入后 install / typecheck / test / C2 全过。
- 修缝 2 处（都是两边各自合规、接起来不对的缝隙，不是补功能）：
  1. `apps/kaidan/src/cli.ts`：`chat --script` 把脚本回放的内容标成「阿里云百炼 通义千问」生成 → 改用脚本 provider 的缺省公示「脚本 scripted」。模型公示必须真实。
  2. `packages/eval/src/bench.ts` 与 `cli.ts`：根脚本 `bench` / `kaidan` 以 `--` 结尾，pnpm 会把 `--` 原样传给脚本，`pnpm bench --config …`（`docs/manual-acceptance.md` 里的命令）直接报 `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL` → 两处都改为去掉开头所有 `--`。
- 清理：4 个 worktree 已删；分支 t1–t4 已删（提交都在 main 的合并历史里）；第 1 轮派单归档在 `review/archive/r1/`。

## 3. 已实测（本机、可复现）

| 检查 | 结果 |
|---|---|
| A1 `pnpm install --frozen-lockfile`（清空 node_modules 后） | 退出码 0 |
| A2 `pnpm typecheck` | 10 个包全过 |
| A3 `pnpm test` | 317 passed，0 failed |
| A4 `pnpm lint:skills` | `skills: 7 OK` |
| A5 `pnpm eval:validate` | `dataset OK`、`tasks: 20 OK`（客户 36 · 联系人 72 · 商机 72 · 活动 220，其中注入 6 · 待办 45 · 日程 14） |
| A6 `pnpm kaidan doctor --config config/demo.mock.yaml` | `adapter: mock`、`skills: 7`、`model: 阿里云百炼 通义千问` |
| B1–B6 `pnpm test:e2e` | 6 个文件、13 条全过 |
| C1 / C2 | contracts 22 passed / 冻结路径 diff 为空 |
| 评测集可复现 | `pnpm --filter @kaidan/eval gen` 后 `git diff --exit-code packages/eval/fixtures` = 0 |
| `chat --script`（脚本模型） | `/晨报` 路由到 daily-brief，工具执行，回复带公示页脚，`:quit` 正常退出 |
| `pnpm -s kaidan mcp`（stdio） | stdout 只有 JSON-RPC；列出 8 个工具；张三 `crm_search` 24 条全是本人的，无 `raw`、无完整手机号；rep 调 `schema_inspect` → `PERMISSION_DENIED` |
| `doctor` 用多维表格配置 | `adapter: bitable`，不联网即可构建 |
| `serve` 缺飞书凭证 | 1 秒内报 `CONFIG：缺少环境变量 FEISHU_APP_ID`，不挂起 |
| `bench`（无密钥） | 参数解析 → 构建 → 跑任务 → 写报告整条链路通，不联网 |

## 4. 还没验证的（按风险排序）

1. **真实国产模型：从没调用过。** 工具调用格式是否兼容（工具规格已去掉顶层 `$schema`，有测试覆盖）、中文输出质量、是否只引用工具给的数字、延迟，全部未知。
2. **真实飞书：全部只对 fake 测过。**
   - T4 列的未真机项：长连接 `WSClient` + `EventDispatcher`；卡片回调 `card.action.trigger` 的注册方式（SDK 类型里没有这个键，照 SDK 源码的写法注册）；回调返回空响应、再用单独接口替换卡片，飞书是否接受；`bot/v3/info` 取机器人 open_id；`im.v1.message.create` / `patch`；卡片 JSON 2.0 字段（`behaviors: callback` 按钮等）；按钮 value 回传形状；频控错误码 `99991400` / `230020`。
   - T1 列的多维表格未真机项：`appTableRecord.list / create / update` 的参数与写入值形状（人员 `[{id}]`、关联 `["rec…"]`、日期毫秒）；关联字段的读取形状（按三种猜测兼容）；频控码 `99991400` / `1254290`；SDK 报错的形状。
3. **Docker 镜像：从没构建过。** 本机拉 Docker Hub 的 `node:24-slim` 超时（T4 与 TΩ 各试过一次）。
4. **CI：从没跑过。** 仓库没有远端；`ci.yml` 的步骤与本地 A1–A5 + e2e 一致，本地全过。
5. **bench：没用真实模型跑过。** 所以还没有任何质量基线（成功率 / 越权 / 注入 / P95）。

## 5. 下一步

### 本周（W2）· 工程：让演示在真实环境里站得住

按顺序做，每步半天到一天：

1. **接国产模型，跑一遍真对话**

   ```bash
   export KAIDAN_LLM_API_KEY=<百炼 API Key>
   pnpm kaidan chat --config config/demo.mock.yaml --as ou_rep_zhang
   # 依次输入：
   #   /晨报
   #   /会后 今天和嘉禾物流开会，对方确认方案，要求周三前出报价
   #   :approve <上一步提案的 id>
   ```

   看三件事：工具调对没有；数字是否都来自工具；回复里有没有「点同意后才会写入」。

2. **跑评测定基线、选模型**

   ```bash
   pnpm bench --config config/demo.mock.yaml   # 20 个任务；报告写到 packages/eval/reports/（不入库）
   ```

   至少比两家（千问 + DeepSeek 或 GLM）：复制一份 config，改 `llm.baseURL` / `model` / `disclosure`，地址与模型 ID 以各家控制台的 OpenAI 兼容接口为准。越权数、注入命中数必须为 0；失败的任务主要改 `packages/skills/skills/*/SKILL.md` 的正文。

   **先让第 1 步正常出晨报再跑 bench。** 密钥缺失 / 过期、地址或模型 ID 写错时，chat 会显示「模型服务配置有误，请联系管理员检查模型配置。」和「本次运行提前结束：error」；但 bench 报告不写失败原因，只会记 `stoppedBy=error`。所以：**所有任务都是 `stoppedBy=error`、成功率 0% → 是密钥 / 接口问题，不是模型差**；模型真的答错时，任务是正常结束（`final`）但内容不对。

3. **飞书测试企业 + 人工验收**：按 `deploy/README.md` 建企业自建应用、开权限（权限名以开放平台后台为准）、事件与回调都选长连接、把应用加为测试多维表格的协作者；然后按 `docs/manual-acceptance.md` 的 12 项逐条打勾。重点盯第 4 节第 2 条的未真机项，出问题分别是 T1（多维表格）或 T4（飞书入口）的代码。

4. **镜像构建**：给 Docker 配镜像加速（比如阿里云容器镜像服务给的个人加速地址），或直接在杭州区域的云服务器上构建 `docker build -f deploy/Dockerfile -t kaidan:mvp-r1 .`；运行、升级、回滚照 `deploy/README.md` 第 4–5 节。

5. **建私有远端并推送**（推荐）：让 `ci.yml` 真跑一次，之后每次合并都有 CI 兜底。

### 本周 · 市场与商务（与工程并行，PLAN §7–8）

- 访谈 + 演示：有模型密钥后先录 CLI 演示，飞书跑通后改为现场演示；当场发 4 周固定价的试点报价。
- **Gate 1（W2 末）**：≥ 3 个付费试点（或带价格的意向书）→ 继续；1–2 个 → 收窄 ICP 再给 2 周；0 个 → 停止加码，MVP 留作作品。
- 试点前的非技术项（`docs/manual-acceptance.md` 末节）：委托处理协议；咨询属地网信办是否需要登记；配置里填所用模型的备案号。对外品牌另起，做商标检索。

### 第 2 轮开发（Gate 1 通过后再开）

第 1 轮的冻结（`.contracts.lock`）仍然有效。第 2 轮先由总管写新 spec、更新契约与锁，再按 T0 → 并行轨 → TΩ 的方式派单。待办：

| # | 问题 | 来源 | 建议 |
|---|---|---|---|
| 1 | 飞书 / 多维表格的真机问题 | 人工验收 | 按验收结果修 T1、T4 的对应代码 |
| 2 | 技能正文质量 | bench 结果 | 按失败任务改 SKILL.md；模型定型 |
| 3 | MCP 入口有两套：`mcp-server/src/bin.ts` 在运行时动态 import `@kaidan/app`（未声明依赖） | T1 | 统一用 `pnpm -s kaidan mcp`（已实测），删掉或改写 bin.ts |
| 4 | `pnpm kaidan mcp` 不加 `-s` 时，pnpm 在脚本启动前就把 `> kaidan@0.0.0 …` 横幅写进 stdout，破坏 MCP 协议（与 `--` 修缝无关，代码里修不了） | TΩ 实测 | README / 部署文档写明：MCP 客户端配置必须用 `pnpm -s kaidan mcp --config … --as …` |
| 5 | 技能不允许的工具，拦截在 agent 里而不在 ToolRegistry（与 spec 3.3 不一致），这类调用不写 `tool_call` 审计 | T2 | 契约里给 `ToolContext` 加允许的工具列表，拦截回到 registry，审计补齐 |
| 6 | `listPending` 会列出已过期、但还没被访问过的提案（懒过期） | T2 | 加过期清扫，或列表 / 卡片展示时过滤 |
| 7 | `crm_timeline` 没有分页，任务最多 50 条 | T1 | 契约加 cursor |
| 8 | 手机号脱敏作用于所有字符串（1[3-9] 开头的 11 位业务编号也会被打码） | T1 | 可接受；真误伤了再收窄 |
| 9 | ~~bench 缺密钥时不提前报错，报告里也不写失败原因~~ | TΩ 实测 | **已完成**（同日）：开跑前检查密钥；报告说明带上原因 |
| 10 | 评测「个数」类期望要求数字后带量词 | T3 | 写进评测说明 |
| 11 | 出错时的系统提示（例如「模型服务配置有误…」，并非模型生成）也带「内容由 AI 生成 · 模型名」页脚 | TΩ 实测（CLI）；飞书 reply 卡待真机确认 | 出错时不加公示页脚，CLI 与卡片统一 |
| 12 | P1 功能：用户授权模式、飞书妙记摄取、商机群总结；钉钉入口或纷享透传适配器 | PLAN §8（W5–8） | 按访谈结果排序 |

## 6. 现状速查

- 仓库：`~/Documents/Projects/Kaidan/kaidan`，只有 `main` 分支，tag `baseline-t0` / `mvp-r1`；私有远端 https://github.com/TomwaltW/kaidan（CI：`verify` + `image`）。
- `review/` 与 MAOS 同一惯例：`.git/info/exclude` 忽略它，新派单默认不入库；本报告、W2 任务清单与第 1 轮派单归档已强制加入 git。`.data/`（demo 的 SQLite）不入库。
- 本地配置（不在 git 里）：`~/Documents/Projects/Kaidan/local-config/`（模型配置与飞书测试企业配置，不放密钥）。
- 各轨回执原文：`~/.claude/projects/-Users-shensikai-Documents-Projects-Kaidan-kaidan--worktrees-task-t{1..4}/` 下的会话记录。
- pnpm 10.34.5 装在 `~/.npm-global`；根 `package.json` 用 `packageManager` 锁定版本。
- **MCP 客户端配置**：`pnpm -s kaidan mcp --config <配置> --as <openId>`。必须带 `-s`，否则 pnpm 横幅会写进 stdout、破坏协议。
