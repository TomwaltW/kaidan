# 派单 T10 · 演示脚本 + 人工验收陪跑清单（不写代码）

> 开单 Kaidan · 2026-09-20 下午。第 1 轮的冻结（`.contracts.lock`）仍然有效。
> 基线：`5572244`（main HEAD，总管钉下）。
> 同时在跑：**T8 多维表格预检**、**T9 serve 真机排错输出**、**T10 演示脚本与验收陪跑清单**（本轨）。三轨文件互不重叠。
> **本轨一行代码都不改**，只产出两份文档。

## 这批活要解决的问题

1. 模型侧今天刚跑通（qwen-plus 全套评测 20/20，写入类 12/12，详见 `review/w2-run-2026-09-20.md`）。
   老板要用 CLI 录一段演示去约访谈——**Gate 1（W2 末 ≥ 3 个付费试点）卡在这件事上，不是卡在代码上**。
   现在没有脚本，录之前得现想说什么、现试哪条命令不炸。
2. 任务 3 要按 `docs/manual-acceptance.md` 的 12 项在真实飞书里逐条点。那份清单（冻结文件，**不许改**）
   只写了「检查什么」，没写**不过的时候要抓什么**。真机排错最贵的就是来回：一轮没抓到日志，就得重来一遍。

## 工作区（已建好，你就在里面）

- worktree：`/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t10`
- 分支：`t10` —— 不要改名、不要切分支、不要 merge / rebase / push；总管按分支名合流
- 基线：`5572244`
- 依赖已装；主仓库与另外两个 worktree（`task-t8`、`task-t9`）一律只读

## 第 1 步：开场自检（任一条对不上 → 停下，回执 `status=blocked` 并贴实际输出）

1. **守卫 hook**：用 Write 工具新建 `docs/.guard-probe`（`docs/**` 是冻结路径）。**被拦**才算通过。
   写成功了 = hook 没挂上：删掉探针，停下，回执 `status=blocked`。
   （本轨尤其要确认这条：你要写的 `review/**` 不冻结，但 `docs/**` 就在隔壁，手滑写进去会毁掉冻结。）
2. 位置与基线：`pwd` → `…/.worktrees/task-t10`；`git rev-parse --abbrev-ref HEAD` → `t10`；
   `git rev-parse --short HEAD` → `5572244`；`git status --short` → 空。
3. 先读（都在本 worktree 里，只读）：`review/w2-run-2026-09-20.md`（今天的实跑记录，数字以它为准）、
   `docs/manual-acceptance.md`（12 项清单）、`deploy/README.md` 第 1–3 节（飞书应用怎么建）、
   `review/w2-tasks.md`（任务 3 的步骤）。

## 产出 1：`review/demo-cli.md` —— CLI 演示脚本

目标：老板照着念、照着敲，**一次录完**，全程 5 分钟以内。

必须包含：

- **开录前的准备**：要导什么环境变量、用哪个配置（`/Users/shensikai/Documents/Projects/Kaidan/local-config/demo.qwen.yaml`，
  写绝对路径）、`--now 2026-09-21T09:00:00+08:00` 为什么必须带（Mock 数据集的「今天」是那天，不带的话晨报里没有日程）。
- **三幕**，每幕给：敲什么（可直接复制的命令 / 输入）、**画面上会出现什么**、**嘴上说什么**（一两句，讲给销售负责人听，不是讲给工程师听）：
  1. `/晨报` —— 今天两个日程、近期要成交、风险商机。卖点：**数字全部来自工具，不是模型编的**。
  2. `/会后 今天和嘉禾物流开会，对方确认方案，要求周三前出报价` —— 生成提案（改阶段 + 补下一步 + 建待办），
     列出「原值 → 新值」。卖点：**AI 只能提案，写入要人点同意**。
  3. `:approve <提案 id>` —— 变成 `committed（已写入 CRM）`。卖点：**审批留痕**。
- **每一幕的真实输出**：你要**自己跑一遍**，把真实输出贴进文档（不要凭想象写）。跑法见下面「怎么跑」。
- **风险与兜底**：模型限流 / 密钥失效时屏幕上会出现什么（「模型服务暂时不可用，请稍后再试。」，
  今天起这种系统提示**不会**再带「内容由 AI 生成」页脚），以及当场怎么圆场、怎么重录。
- **不要吹的东西**（老实写进去，免得现场被问穿）：飞书真机还没验；只在 Mock 数据上演示；
  评测 20/20 是单轮成绩，这套题单轮抖动 ±2～3。

### 怎么跑（本轨唯一要花钱的地方）

```bash
source /private/tmp/claude-501/-Users-shensikai-Documents-Projects--------2/4693e716-8510-4135-9ed5-206268a755f4/scratchpad/kaidan-env.sh
CFG=/Users/shensikai/Documents/Projects/Kaidan/local-config/demo.qwen.yaml
printf '/晨报\n:quit\n' | pnpm -s kaidan chat --config $CFG --as ou_rep_zhang --now 2026-09-21T09:00:00+08:00
```

- 那个文件里是阿里云百炼的密钥（mode 600）。**不要把密钥写进任何文档、commit 或回执**，`echo` 也不要。
- 三幕各跑一次就够（第三幕的提案 id 从第二幕的输出里取，提案存在 SQLite 里，换一条命令 `:approve` 也认）。
- 一轮大约 1–2 万 token，很便宜。跑不通先看是不是忘了 `source`。

## 产出 2：`review/acceptance-companion.md` —— 12 项验收的陪跑清单

`docs/manual-acceptance.md` 是冻结文件，**一个字都不许改**。本文件是它的陪跑：**逐项**给出

| 列 | 内容 |
|---|---|
| 第几项 | 与 `docs/manual-acceptance.md` 的顺序**严格一一对应**（12 项，不多不少，不要重排） |
| 具体怎么做 | 谁（主管 / 销售 A / 管理员）、在哪（私聊 / 群里 / 多维表格里）、做什么 |
| 通过长什么样 | 屏幕上与 `serve` 日志里各自应该出现什么 |
| **不过的时候抓什么** | 要复制哪几行日志（飞书错误码 `code` / `msg` / `log_id` 是关键）、多维表格里对应记录的状态、复现步骤 |
| 大概率是谁的锅 | 多维表格读写 → `packages/adapters/src/bitable/**`；消息 / 卡片 / 回调 → `packages/surface-feishu/src/**` |

另外单列一节：**第 4 节未真机项对照表**。把 `review/mvp-r1-report.md` 第 4 节第 2 条列的那些没验过的点
（长连接、`card.action.trigger` 注册、空响应后换卡、`bot/v3/info`、`im.v1.message.create/patch`、
卡片 JSON 2.0 字段、按钮 value 形状、频控码、多维表格的人员 / 关联 / 日期写入形状、关联字段读取形状）
对应到 12 项里的**哪一项会first踩到它** —— 这样第一次踩雷就知道是哪个已知未知，而不是从头查。

开头写明前置：应用已发布、应用已是多维表格协作者、三个测试账号已私聊过机器人拿到 open_id、
`local-config/tenant.feishu-test.yaml` 与 `mapping.feishu-test.yaml` 已填好（`TODO_` 清零）。

## 可写文件（白名单，只有这些）

- `review/demo-cli.md`（新建）
- `review/acceptance-companion.md`（新建）

## 禁改（改了就算这个任务失败）

- **一行代码都不要改**：`apps/**`、`packages/**`、`deploy/**`、`config/**` 全部只读。
- `docs/**`（含 `docs/manual-acceptance.md`）是冻结路径；`review/` 下已有的文件
  （`w2-tasks.md`、`mvp-r1-report.md`、`w2-run-2026-09-20.md`、`archive/**`）也不要改，它们是别人的记录。
- `apps/kaidan/**` 与 `packages/adapters/**` 是 **T8** 的，`packages/surface-feishu/**` 是 **T9** 的。

## 验收

1. 两份文档都存在，且**不是空壳**：`demo-cli.md` 的三幕各自贴了**真实跑出来的输出**；
   `acceptance-companion.md` 的 12 项**逐条**都有「不过的时候抓什么」，没有「按提示操作即可」这种废话。
2. 项数对得上：`acceptance-companion.md` 的项数 = `docs/manual-acceptance.md` 「检查项」一节的条数（12），顺序一致。
3. 没碰代码，也没碰冻结路径：

   ```
   git diff --name-only 5572244..HEAD    # 只能出现 review/demo-cli.md 与 review/acceptance-companion.md
   git status --short                    # 干净
   ```

4. 文档里**没有密钥**：`grep -rn 'sk-' review/demo-cli.md review/acceptance-companion.md` → 无命中
5. 文档里的数字与 `review/w2-run-2026-09-20.md` 对得上（20/20 是单轮、写入类 12/12、飞书未真机），没有自己发明的成绩

## 完成后

`review/` 被 `.git/info/exclude` 忽略，所以要强制加：

```
git add -f review/demo-cli.md review/acceptance-companion.md
git commit -m "t10: CLI 演示脚本与 12 项人工验收陪跑清单"
```

回执最后一行严格按这个格式：

```
RECEIPT T10 status=<done|blocked> commit=<短hash> checks=<通过数>/5 files=<改动文件数>
```

回执正文包含：两份文档的大纲（各节标题）；三幕真实跑通的证据（贴关键行，不要贴密钥）；
`git diff --name-only` 的实际输出；如果 blocked：卡在哪、试过什么、需要什么决定。
