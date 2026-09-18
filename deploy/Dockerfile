# 开单 Kaidan 运行镜像（一个实例 = 一个客户）
# 构建（在仓库根目录执行，构建上下文 = 仓库根）：
#   docker build -f deploy/Dockerfile -t kaidan:latest .
# 忽略规则见同目录的 Dockerfile.dockerignore（BuildKit 会自动使用与 Dockerfile 同名的 .dockerignore）。
# 运行方式见 deploy/README.md。
FROM node:24-slim

# COREPACK_HOME 放在共享目录：构建时（root）下载的 pnpm，运行时（node 用户）直接复用，不再联网
ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/usr/local/share/corepack \
    TZ=Asia/Shanghai

WORKDIR /app

# 先只拷依赖清单，利用层缓存：依赖不变时改源码不必重新安装
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./

# pnpm 版本由根 package.json 的 packageManager 字段锁定
RUN corepack enable && corepack install && chmod -R a+rX "$COREPACK_HOME"

COPY apps/kaidan/package.json apps/kaidan/
COPY packages/contracts/package.json packages/contracts/
COPY packages/adapters/package.json packages/adapters/
COPY packages/tools/package.json packages/tools/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/governance/package.json packages/governance/
COPY packages/agent/package.json packages/agent/
COPY packages/skills/package.json packages/skills/
COPY packages/surface-feishu/package.json packages/surface-feishu/
COPY packages/eval/package.json packages/eval/

# 运行时用 tsx 直接跑 TS 源码（tsx 在根 devDependencies 里），所以装全量依赖
RUN pnpm install --frozen-lockfile --prod=false

COPY . .

# 治理库（SQLite）与客户配置都挂载进来；配置里 governance.dbPath 建议写 ../.data/<客户>.db
RUN mkdir -p /app/.data /app/config && chown -R node:node /app/.data
VOLUME ["/app/.data"]

USER node

# 密钥只走环境变量：FEISHU_APP_ID / FEISHU_APP_SECRET / KAIDAN_LLM_API_KEY（变量名以配置文件为准）
CMD ["pnpm", "kaidan", "serve", "--config", "/app/config/tenant.yaml"]
