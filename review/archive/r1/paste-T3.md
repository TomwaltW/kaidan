# 派单 T3 · 技能包与评测（7 个 SKILL.md + 校验器 + 虚构数据集 + oracle + 20 个任务 + 跑分器）

> 开单 Kaidan 第 1 轮并行：T1–T4 同时开工，TΩ 最后按分支名合流。生成于 2026-09-18，基线 `6d41265`（= tag `baseline-t0`）。
> 本文件 = 抬头（工作区 + 开场自检）+ `docs/dispatch/T3.md` 原文。原文里的「## 工作区」一节已由抬头替代，其余一字未改。

## 工作区（已建好，你就在里面）

- worktree：`/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t3`
- 分支：`t3` —— TΩ 按分支名 `t3` 合流：不要改名、不要切分支、不要 merge / rebase / push
- 基线：`6d41265`（= `baseline-t0`，建 worktree 时主干 main 的 HEAD）
- 依赖已装（`pnpm install --frozen-lockfile` 退出码 0）；缺依赖 → 停下报告，不要 `pnpm add`
- 主仓库 `/Users/shensikai/Documents/Projects/Kaidan/kaidan` 和另外三个 worktree（`.worktrees/task-t*`）一律只读：不要在那里改文件、不要在那里 commit

## 第 1 步：开场自检（任一条对不上 → 停下，回执 `status=blocked` 并贴实际输出；不要去"修"基线）

1. **守卫 hook 挂上了没有**：用 Write 工具新建 `docs/.guard-probe`（内容随意；`docs/**` 是冻结路径）。
   **被拦**（提示含「已拦截」）才算通过。如果写成功了 = hook 没挂上，冻结路径此刻没有任何保护：
   删掉这个探针文件（它不在 git 里，删它不算改冻结路径），停下，回执 `status=blocked`，写明「guard hook 未生效」。
2. 位置与基线：`pwd` → `/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t3`；`git rev-parse --abbrev-ref HEAD` → `t3`；`git rev-parse --short HEAD` → `6d41265`；`git status --short` → 空。
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
| `pnpm --filter @kaidan/skills test` / `eval` | `No test files found, exiting with code 0`（0 个用例，从零写起） |
| `pnpm lint:skills` | 退出码 1：`@kaidan/skills lint 尚未实现`（T0 桩） |
| `pnpm eval:validate` | 退出码 1：`@kaidan/eval validate 尚未实现`（T0 桩） |
| `pnpm --filter @kaidan/eval gen` | 退出码 1：`@kaidan/eval gen 尚未实现`（T0 桩） |

## 并行须知

- 同时在跑：T1 数据与工具层（task-t1）、T2 运行时与治理（task-t2）、T3 技能包与评测（task-t3）、T4 飞书入口与部署（task-t4）。只写自己的白名单；别的包对你"不可见"（spec 3.4），测试一律用自己 test 目录里的 fake。
- 完成后按原文「完成后」在本 worktree 的 `t3` 分支上 commit，并输出回执；最后一行 `RECEIPT T3 status=… commit=… checks=…/… files=…`。

---

# 任务 T3 — 技能包与评测（7 个 SKILL.md + 校验器 + 虚构数据集 + oracle + 20 个任务 + 跑分器）

## 工作区
（已由本文件抬头替代：worktree 已建在 `/Users/shensikai/Documents/Projects/Kaidan/kaidan/.worktrees/task-t3`，分支 `t3`，基线 `6d41265`，依赖已装。不要执行 `git worktree add`，也不要 `cd ../kaidan-t3`。）

## 先读
docs/dev-spec-2026-09-18.md —— 本轮唯一权威文档。
重点读：第 3 节冻结契约（agent.ts 中 SKILL_NAMES 与 SkillFrontmatter、tools.ts、rom.ts、config.ts）、第 6 节 T3 那一行、附录 B（技能清单）、附录 E（评测集约定）、附录 G（mini.json 摘要）；以及根目录 CLAUDE.md 的硬规则。

## 目标
写出 7 个中文销售技能（packages/skills/skills/<name>/SKILL.md）与校验器（lintSkills + lint 命令）；写出评测包：固定种子的虚构数据集生成器与生成结果、oracle、20 个评测任务、validate 与 bench 命令，并写足单元测试。

## 可写文件（白名单，只有这些）
- packages/skills/skills/**、packages/skills/src/**、packages/skills/test/**
- packages/eval/src/**、packages/eval/test/**、packages/eval/fixtures/**、packages/eval/tasks/**

## 禁改（改了就算这个任务失败）
- docs/dev-spec-2026-09-18.md 与 .contracts.lock 列出的全部路径（契约、根配置、各包 package.json、tests/e2e、config）
- 白名单以外的任何文件（包括 apps/kaidan/** 与其他包）
- packages/skills/src/index.ts 中 SKILLS_DIR 的取值方式（可在同文件实现 lintSkills 的导出）

契约不对就停下来报告，不要自己改。你改通了，其他三个 track 会全挂，而且要到合流才发现。

## 技能写作要求（面向销售与主管，中文，简洁可执行）
- frontmatter 严格按附录 B（name / command / allowed_tools / schedule / roles），description 用一句话说清"什么时候用"。
- 正文五个二级标题：## 何时使用、## 步骤、## 输出格式、## 写入规则、## 边界；≤ 6000 字符；正文里出现的工具名必须在该技能的 allowed_tools 内（没有写入工具的技能不要提到 propose_update / propose_create 这两个名字）。
- 方法论：资格四要素 pain / decision_maker / budget / timeline 逐项判定"已确认 / 部分 / 缺失"；数字只引用工具返回值；看不到的数据直说看不到；工具返回无权限时只说无权限。
- 各技能要点：
  - assistant：通用问答；先查再答；需要改数据时生成提案并提示"点同意后才会写入"；一次只追问一个问题。
  - daily-brief：今日日程 → 近期要成交 → 风险商机（每条一句原因 + 一个建议动作）→ 今天最重要的三件事；适合飞书卡片阅读，控制在 400 字内；周五额外提示可用 /周报。
  - call-prep：定位今天的会议或指定客户 → 客户与商机现状 → 最近三次跟进 → 未决问题 → 3–5 个建议提问；发现 CRM 里没有的联系人时，用提案建议新增。
  - deal-review：按四要素打分、列风险与下一步；可提议补 qualification / nextStep，或提议新建任务。
  - post-meeting：从用户笔记里抽取结论 → 找到对应商机 → 提议更新阶段 / 下一步 / 预计成交日期 / 资格字段与待办 → 起草一段发给客户的跟进消息（微信口吻）→ 提醒点同意后才会写入。
  - weekly-review：面向主管的周报——按阶段的数量与金额、可能滑单的商机及原因、本周推进与新增、下周重点；给出可直接转发的周报正文。
  - setup（仅 admin）：读取表结构，识别客户 / 商机 / 联系人 / 跟进 / 待办表与字段，产出 mapping.yaml 草稿（代码块）与需要人工确认的字段清单；声明"草稿不会自动生效"。

## 评测要求（附录 E 为准）
- src/gen.ts：纯函数 PRNG（如 mulberry32，固定种子），生成 packages/eval/fixtures/crm-demo.json；同种子两次输出字节一致；用户 id 与名字严格按附录 E。
- src/oracle.ts：从 RomDataset 计算 closingSoon、atRisk、byStage、openAmount 等，规则与 tools.ts 注释一致（时区 Asia/Shanghai）；测试里用 mini.json 复算出 B1 / B2 的全部数值。
- tasks/*.yaml：恰 20 个，类别与数量按附录 E。
- src/validate.ts：校验数据集（RomDataset + 引用完整 + 数量下限 + "（虚构）" + 注入样本数）与任务文件；成功时输出 `dataset OK` 与 `tasks: 20 OK`。
- src/bench.ts：`--config <path> [--only id,...]`，通过 @kaidan/app 的 buildApp 用真实 provider 跑任务并写报告；需要密钥，不在你的验收里运行，但必须通过类型检查；跑分逻辑本身抽成纯函数，用 fake AgentRuntime 测。

## 验收（自己跑，全绿才算完）
1. `pnpm install --frozen-lockfile` → 退出码 0
2. `pnpm typecheck` → 退出码 0
3. `pnpm test` → 退出码 0
4. `pnpm lint:skills` → 退出码 0，最后一行为 `skills: 7 OK`
5. `pnpm eval:validate` → 退出码 0，输出含 `dataset OK` 与 `tasks: 20 OK`
6. `pnpm --filter @kaidan/skills test` → ≥ 5 passed（缺章节 / 未授权工具 / 命令重复 / 名称与目录不符 / 缺 schedule 各有反例）
7. `pnpm --filter @kaidan/eval test` → ≥ 10 passed
8. `pnpm --filter @kaidan/eval gen && git diff --exit-code packages/eval/fixtures` → 退出码 0
9. `git diff --stat baseline-t0 -- packages/contracts tests/e2e config package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json 'packages/*/package.json' apps/kaidan/package.json` → 输出为空

验收过不了就继续改。确信是验收标准本身写错了，停下来报告，不要改验收。

## 完成后
git add -A && git commit -m "t3: 技能包与评测（skills + eval）"

然后输出回执，最后一行严格按这个格式：
RECEIPT T3 status=<done|blocked> commit=<短hash> checks=<通过数>/<总数> files=<改动文件数>

回执正文包含：
- 每条验收命令的实际输出（真实输出的关键几行，不是"通过了"）
- 7 个技能各自的字符数与 allowed_tools
- 数据集的对象数量统计
- 如果 blocked：卡在哪、试过什么、需要什么决定
