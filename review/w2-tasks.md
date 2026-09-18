# 开单 Kaidan · W2 任务清单（你来跑）

> 2026-09-18 · 仓库 `~/Documents/Projects/Kaidan/kaidan`（私有远端 https://github.com/TomwaltW/kaidan）
> 下面所有命令都在仓库根目录执行。本地配置在 `~/Documents/Projects/Kaidan/local-config/`（不在 git 里，放了占位与模型配置，不放密钥）。

## 已经替你做完的

- 全部提交并推送：main + tag `baseline-t0` / `mvp-r1` 已在私有仓库 `TomwaltW/kaidan`。
- CI 首跑全绿：`verify`（A1–A5 + e2e）与 `image`（在 GitHub 上构建 `deploy/Dockerfile`，镜像里 `doctor` 输出 `adapter: mock`、`skills: 7`）。「镜像能不能建」「CI 能不能跑」这两件已经验证。
- bench：缺密钥时开跑前就退出（退出码 2），不再产出一份全是 0 分的报告；失败说明带上原因（限流 / 配置有误 / 暂时不可用）。
- chat 新增 `--now <ISO 时间>`：演示时把「现在」设到 Mock 数据集那天（2026-09-21 周一 09:00），晨报里才有当天日程（实测：真实时间下张三今天 0 个日程，`--now` 后 2 个）。
- `local-config/` 里的 4 份配置都已用 `doctor` 验过：`demo.qwen.yaml`、`demo.deepseek.yaml`、`tenant.feishu-test.yaml`、`mapping.feishu-test.yaml`。

---

## 任务 1 · 真实模型冒烟（约 30 分钟）

**要准备**：阿里云百炼的 API Key（百炼控制台 → API-KEY）。

```bash
cd ~/Documents/Projects/Kaidan/kaidan
export KAIDAN_LLM_API_KEY=sk-…
pnpm kaidan chat --config ../local-config/demo.qwen.yaml --as ou_rep_zhang --now 2026-09-21T09:00:00+08:00
```

依次输入：

```
/晨报
/会后 今天和嘉禾物流开会，对方确认方案，要求周三前出报价
:approve <上一步打印的提案 id>
:quit
```

**通过标准**
- `/晨报`：提到今天的两个日程（10:00 电话会·晨曦精密机械、14:00 拜访嘉禾物流）；金额、个数都来自工具，没有编的数字。
- `/会后`：生成一个针对嘉禾物流商机的提案，列出「原值 → 新值」；回复里提醒「点同意后才会写入」。
- `:approve`：提案 `committed`（已写入 CRM）。

**不对的时候**：「模型服务配置有误…」= 密钥 / 地址 / 模型 ID 有问题；「繁忙（限流）」= 稍后重试。

## 任务 2 · 模型基线与选型（1–2 小时）

**要准备**：百炼 + DeepSeek 两个 API Key（DeepSeek 开放平台 → API keys）。

```bash
export KAIDAN_LLM_API_KEY=sk-…          # 百炼
export KAIDAN_DEEPSEEK_API_KEY=sk-…     # DeepSeek
pnpm bench --config ../local-config/demo.qwen.yaml
pnpm bench --config ../local-config/demo.deepseek.yaml
```

- 报告在 `packages/eval/reports/<时间戳>.md`（不入库）。比这几项：成功率、越权数（必须为 0）、注入命中数（必须为 0）、平均工具调用数、token、P95 延迟。
- 所有任务都是 `stoppedBy=error` 且成功率 0% → 是密钥 / 接口问题，不是模型差（报告的「说明」列会写原因）。
- 选定模型后，把 `../local-config/tenant.feishu-test.yaml` 的 `llm` 段改成它。
- 想试 GLM / Kimi / 豆包：复制一份 `demo.deepseek.yaml`，改 `llm.baseURL` / `model` / `apiKeyEnv` / `disclosure`，地址与模型 ID 以各家控制台的 OpenAI 兼容接口为准。

**可以交给 Claude 的部分**：在同一个终端（环境变量要在）进仓库开会话，粘这段：

> 按 `packages/eval/reports/<报告文件>.md` 里失败的任务，改 `packages/skills/skills/*/SKILL.md` 的正文（frontmatter 按附录 B 不动，正文 ≤ 6000 字）。改完跑 `pnpm lint:skills`、`pnpm test`、`pnpm test:e2e`，再用同一个 config 跑 `pnpm bench` 对比前后成功率，越权与注入必须仍为 0，然后 commit。

## 任务 3 · 飞书测试企业 + 人工验收（约半天）

**要准备**：一个飞书测试企业的管理员账号，以及主管 / 销售 / 管理员三个测试账号。

1. 飞书开放平台创建企业自建应用：开启机器人，权限、事件与回调（都选「长连接」：接收消息 + 卡片回调）、发布，照 `deploy/README.md` §1 做，权限名以开放平台后台为准。
2. 用飞书官方「轻量级 CRM」模板建一个测试多维表格，录 5–10 条虚构的客户 / 商机 / 跟进；把应用加为协作者（可编辑），见 `deploy/README.md` §2。
3. 在 `../local-config/tenant.feishu-test.yaml` 填 `appToken`（多维表格网址里 `/base/` 后面那一段）。
4. 启动：

   ```bash
   export KAIDAN_LLM_API_KEY=sk-… FEISHU_APP_ID=cli_… FEISHU_APP_SECRET=…
   pnpm kaidan serve --config ../local-config/tenant.feishu-test.yaml
   ```

5. 三个测试账号各给机器人私聊一句话，终端会打出 `[surface-feishu] 未开通用户发来消息：open_id=ou_…`。把三个 open_id 填进配置的 `users`（替换 `TODO_`），Ctrl+C 后重新启动。
6. 管理员私聊机器人 `/初始化`，把回复里的 mapping.yaml 草稿贴进 `../local-config/mapping.feishu-test.yaml`，核对 tableId 与字段名，然后重启。
7. 按 `docs/manual-acceptance.md` 逐条打勾（最后一项 bench 在任务 2 已完成）。
8. 出问题时，记下现象和 serve 日志交给 Claude 修：多维表格读写在 `packages/adapters/src/bitable/**`，消息 / 卡片 / 回调在 `packages/surface-feishu/src/**`。还没真机验证过的点列在 `review/mvp-r1-report.md` 第 4 节。

## 任务 4 · 部署（试点前）

- 镜像已在 CI 里验证能构建。正式部署：在杭州区域的云服务器上按 `deploy/README.md` §4–5 构建、运行、升级。
- 服务器或本机拉不到 Docker Hub 时，先配镜像加速：用阿里云容器镜像服务给你的专属加速地址，加进 Docker 的 `registry-mirrors`（Docker Desktop：Settings → Docker Engine）。然后 `docker build -f deploy/Dockerfile -t kaidan:mvp-r1 .`。

## 任务 5 · 市场与合规（与上面并行，PLAN §7–8）

- 任务 1 跑通后，用带 `--now` 的那条命令录 CLI 演示；约访谈、现场演示，当场发 4 周固定价的试点报价。
- **Gate 1（W2 末）**：≥ 3 个付费试点（或带价格的意向书）→ 继续；1–2 个 → 收窄 ICP 再给 2 周；0 个 → 停止加码。
- 试点前：签委托处理协议；咨询属地网信办是否需要登记；配置里填所用模型的备案号；对外品牌另起并做商标检索。

---

**附：MCP 客户端接入**：`pnpm -s kaidan mcp --config <配置> --as <openId>`。必须带 `-s`，否则 pnpm 横幅会写进 stdout、破坏协议。
