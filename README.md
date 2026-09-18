# 开单 Kaidan — 启动包（2026-09-18）

中国版「Claudeforce / Salesforce in Claude」的第一轮工程启动包：方案书 + 冻结契约 + Claude Code 并行派工提示词。

## 包里有什么

| 路径 | 用途 |
|---|---|
| `docs/PLAN.md` | 方案书：Claudeforce 拆解、中国市场调研、定位、商业模式、路线图、风险 |
| `docs/dev-spec-2026-09-18.md` | 本轮开发唯一权威文档：验收标准、冻结契约、文件归属表、任务表 |
| `docs/dispatch/T0.md … TOmega.md` | 可直接粘进 Claude Code 的派工提示词（整份文件就是提示词） |
| `docs/manual-acceptance.md` | 合流后在真实飞书环境里的人工验收清单 |
| `packages/contracts/src/` | 冻结契约源码（已用 TypeScript 7.0.2 + zod 4.6.5 严格模式通过类型检查） |
| `tests/e2e/fixtures/mini.json` | 验收用最小虚构数据集 |
| `config/` | 演示配置、试点客户配置样例、多维表格字段映射样例 |
| `CLAUDE.md` / `.claude/` | Claude Code 工作规则 + 契约冻结 hook（有 `.contracts.lock` 时拦截写入冻结路径） |

## 怎么开工

1. 准备环境：Node ≥ 22.13（推荐 24 LTS）、pnpm 10、git。解压后 `cd kaidan`。
2. 在仓库根目录打开 Claude Code，粘贴 `docs/dispatch/T0.md` 的全部内容。T0 会 `git init`、搭骨架、装依赖、写验收用例、打 tag `baseline-t0` 并创建 `.contracts.lock`。
3. T0 回执 `status=done` 后，开 4 个新的 Claude Code 会话，分别粘贴 `T1.md`～`T4.md`（每个任务自己开 git worktree，互不打架）。
4. 四条回执都 `done` 后，在主仓库新会话里粘贴 `TOmega.md` 合流。只把每条回执的最后一行 `RECEIPT ...` 贴回来就能判断进度。
5. 合流后本地演示（需要一个国产模型的 API Key）：

```bash
export KAIDAN_LLM_API_KEY=你的密钥
pnpm kaidan chat --config config/demo.mock.yaml --as ou_rep_zhang
# 输入：/晨报    /会后 今天和华东精密开会，对方确认方案，要求周三前出报价
```

6. 飞书试点：复制 `config/tenant.example.yaml` 与 `config/mapping.example.yaml`，按客户的多维表格填写，然后 `pnpm kaidan serve --config config/<客户>.yaml`。

## 注意

- 产品运行时只接国产已备案模型（见 `docs/PLAN.md` 第 3 节）。
- "开单 / Kaidan" 只是工作代号；对外品牌不要使用 Claude、Claudeforce 或 "-force" 字样，上线前做商标检索。
