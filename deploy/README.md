# 开单 Kaidan 部署手册（飞书自建应用 + Docker）

一个实例 = 一个客户。开单通过**飞书长连接**接收消息与卡片回调，**不需要公网 IP、域名或开放入站端口**，只需要能访问飞书开放平台与所配置的国产模型接口。

> 权限、事件、菜单的名称以飞书开放平台后台当前显示为准；本文写的是 2026-09 时的名称。

---

## 1. 在飞书开放平台创建应用

1. 打开 [飞书开放平台](https://open.feishu.cn/app) → **创建企业自建应用**，填写名称（如「开单助手」）、描述、图标。
2. **添加应用能力 → 机器人**：开启机器人能力。
3. **凭证与基础信息**：记下 `App ID` 与 `App Secret`，稍后放进环境变量（不要写进配置文件或提交到仓库）。

### 1.1 权限管理（开通以下权限）

| 用途 | 权限（以后台显示名称为准） |
|---|---|
| 接收用户私聊机器人的消息 | 读取用户发给机器人的单聊消息（`im:message.p2p_msg:readonly`） |
| 接收群里 @机器人 的消息 | 接收群聊中 @机器人消息事件（`im:message.group_at_msg:readonly`） |
| 发送回复卡片、晨报 / 周报 | 以应用的身份发消息（`im:message:send_as_bot`） |
| 审批后更新原卡片 | 获取与发送单聊、群组消息（`im:message`） |
| 读写多维表格 CRM（`adapter.kind: bitable`） | 查看、评论、编辑和管理多维表格（`bitable:app`） |

> 开单只以**应用身份**（tenant_access_token）访问数据；不申请用户授权类权限（P1 再做）。

### 1.2 事件与回调（都选「长连接」）

1. **事件与回调 → 事件配置**：订阅方式选择 **使用长连接接收事件**，添加事件 **接收消息 `im.message.receive_v1`**。
2. **事件与回调 → 回调配置**：订阅方式选择 **使用长连接接收回调**，添加回调 **卡片回传交互 `card.action.trigger`**（审批卡片上的「同意 / 拒绝」按钮靠它）。
3. 注意：飞书要求保存长连接配置时**应用进程已经在线**。可以先按第 4 节把容器跑起来，再回来保存。

### 1.3 发布

**版本管理与发布 → 创建版本**，可用范围选择要使用开单的销售团队成员，提交发布并由企业管理员审核通过。之后权限或事件有变更，都要重新发版才生效。

## 2. 把应用加为多维表格协作者（`adapter.kind: bitable` 时）

应用身份默认看不到任何多维表格：

1. 打开客户的 CRM 多维表格 → 右上角 **「…」→「更多」→「添加文档应用」**。
2. 搜索并添加「开单助手」，权限给 **可编辑**（审批通过的提案要写回表格）。
3. 多维表格 URL 里 `/base/` 后面那一段就是配置里的 `adapter.bitable.appToken`。

字段映射写在 `mapping.yaml`（样例：`config/mapping.example.yaml`）。管理员可以在飞书里对机器人发 `/初始化`，让它读表结构并生成一份 mapping 草稿。

## 3. 准备配置

复制 `config/tenant.example.yaml` 与 `config/mapping.example.yaml` 到一个**只属于这个客户**的目录，例如：

```
/srv/kaidan/acme/
├── tenant.yaml     # 由 tenant.example.yaml 修改
└── mapping.yaml    # 由 mapping.example.yaml 修改；tenant.yaml 里 mappingPath: ./mapping.yaml
```

要点：

- `users`：每个可以使用开单的人一行，`openId` 是该用户在**本应用下**的 open_id（不同应用下同一个人的 open_id 不同）。
  拿不到时：让对方先私聊机器人一句话，容器日志（stderr）会打印 `未开通用户发来消息：open_id=ou_…`，把它加进配置后重启即可。
- `managerOpenId` 决定团队视角与审批权；`scheduled: true` 的人会收到晨报 / 周报。
- `schedules`：cron 表达式，时区取 `timezone`（如 `"30 8 * * 1-5"` = 工作日 8:30 晨报）。
- `governance.dbPath` 写 `../.data/<客户>.db`：配置挂载在 `/app/config`，数据库就会落在 `/app/.data`（数据卷）。
- `llm`：只接国产已备案模型的 OpenAI 兼容接口；`disclosure` 会显示在每张回复卡片页脚（生成式 AI 公示），有备案号请填 `filingNo`。

### 环境变量（密钥只放这里）

| 变量 | 说明 |
|---|---|
| `FEISHU_APP_ID` | 应用 App ID（变量名 = 配置里的 `feishu.appIdEnv`） |
| `FEISHU_APP_SECRET` | 应用 App Secret（= `feishu.appSecretEnv`） |
| `KAIDAN_LLM_API_KEY` | 模型接口密钥（= `llm.apiKeyEnv`） |

建议写进 `/srv/kaidan/acme/.env`（权限 600），不要提交到任何仓库。

## 4. 构建与运行

在仓库根目录构建镜像（构建上下文必须是仓库根；忽略规则在 `deploy/Dockerfile.dockerignore`）：

```bash
docker build -f deploy/Dockerfile -t kaidan:$(git rev-parse --short HEAD) -t kaidan:latest .
```

先自检（不连飞书、不调模型）：

```bash
docker run --rm \
  -v /srv/kaidan/acme:/app/config:ro \
  kaidan:latest pnpm kaidan doctor --config /app/config/tenant.yaml
```

正式运行（默认命令就是 `pnpm kaidan serve --config /app/config/tenant.yaml`）：

```bash
docker run -d --name kaidan-acme --restart unless-stopped \
  --env-file /srv/kaidan/acme/.env \
  -v /srv/kaidan/acme:/app/config:ro \
  -v kaidan-acme-data:/app/.data \
  kaidan:latest
docker logs -f kaidan-acme      # 看到「已连接飞书；定时任务 2 个」即上线
```

然后在飞书里私聊机器人 `/晨报` 验证；群里需要 **@开单助手** 才会响应。

**同一个应用只跑一个实例。** 多个实例同时在线时，定时晨报会被每个实例各发一遍。

## 5. 升级

```bash
git pull
docker build -f deploy/Dockerfile -t kaidan:$(git rev-parse --short HEAD) -t kaidan:latest .
docker run --rm -v /srv/kaidan/acme:/app/config:ro kaidan:latest pnpm kaidan doctor --config /app/config/tenant.yaml
docker stop kaidan-acme && docker rm kaidan-acme
# 再执行第 4 节的「正式运行」命令
```

- 提案、审计记录在数据卷 `kaidan-acme-data` 里，升级不丢；未过期的待审批卡片升级后仍可点。
- 回滚：用上一个 `kaidan:<短 hash>` 标签重新 `docker run`。
- 只改配置（加人、改晨报时间）不用重建镜像：改完 `docker restart kaidan-acme`。

## 6. 排障

| 现象 | 排查 |
|---|---|
| 启动报 `错误 [CONFIG]：缺少环境变量 …` | `--env-file` 没带上，或变量名与配置里的 `*Env` 不一致 |
| 私聊没反应 | 应用是否已发版、用户是否在可用范围；事件是否选了长连接并订阅 `im.message.receive_v1` |
| 群里 @ 了没反应 | 是否开通「接收群聊中 @机器人消息事件」权限；机器人是否已被拉进群 |
| 回复「你还没有开通开单助手」 | 该用户的 open_id 不在 `users` 里（见日志里打印的 open_id） |
| 点「同意」没反应 | 回调是否选了长连接并添加 `card.action.trigger`；看日志「处理卡片回调失败」 |
| 读不到 / 写不进多维表格 | 应用是否已被添加为该多维表格的协作者且有编辑权限；`appToken` 是否正确 |
| 日志出现 `RATE_LIMITED` | 飞书频控，已自动重试 3 次（0.5s / 1s / 2s）仍失败；降低并发或错开定时任务时间 |

## 7. 接入 MCP 客户端（可选）

开单也能以 MCP 服务端的身份，把工具暴露给别的 MCP 客户端（stdio 传输）。客户端里的启动命令**必须**写成：

```bash
pnpm -s kaidan mcp --config <配置文件> --as <openId>
```

- `-s`（`--silent`）**不能省**。省掉之后 pnpm 会把 `> kaidan@0.0.0 …` 这样的横幅写进 **stdout**，
  而 stdio 传输下 stdout 只允许出现 MCP 协议消息，横幅会直接把握手打断（客户端表现为连不上或解析失败）。
  这是 pnpm 的行为，代码里修不掉，只能靠命令里的 `-s`。
- 工作目录要是仓库根目录（或容器里的 `/app`），否则 `pnpm` 找不到 `kaidan` 这个脚本。
- `--as <openId>` 指定以哪个销售的身份提供工具，这个 open_id 必须在配置的 `users` 里。
- `pnpm --filter @kaidan/mcp-server start` **不是**入口：它只会往 stderr 打印上面这条指引并以退出码 2 结束。
- 该进程的日志一律走 stderr，stdout 只有协议消息；stdin 关闭即退出。

任何支持 stdio 传输的 MCP 客户端都能接，配置形如 `{ command, args, cwd }`：

```json
{
  "mcpServers": {
    "kaidan": {
      "command": "pnpm",
      "args": ["-s", "kaidan", "mcp", "--config", "config/demo.mock.yaml", "--as", "ou_rep_zhang"],
      "cwd": "<仓库根目录，容器里是 /app>"
    }
  }
}
```
