# 任务 TΩ — 集成与合流

## 工作区
主仓库根目录，main 分支，当前应位于 baseline-t0。先确认 `git status --short` 为空。

## 先读
docs/dev-spec-2026-09-18.md 第 2 节（全部验收）、第 3.4 节（文件归属表）；以及根目录 CLAUDE.md 的硬规则。

## 待合分支
按顺序：
1. t1（数据与工具层）
2. t2（运行时与治理）
3. t3（技能包与评测）
4. t4（飞书入口与部署）

## 做法
一次合一个：`git merge --no-ff <分支> -m "merge <分支>"`。每合完一个，立刻跑下面"每次合入后"的检查，再合下一个。不要全合完再跑——坏了你会分不清是谁。

出现文件冲突时：按 spec 第 3.4 节归属表判定谁该赢。归属表里没写的，停下来报告（这说明切分时漏了，不要在合流现场临时划边界）。

## 每次合入后
- `pnpm install --frozen-lockfile` → 退出码 0
- `pnpm typecheck` → 退出码 0
- `pnpm test` → 退出码 0
- C2：`git diff --stat baseline-t0 -- packages/contracts tests/e2e config package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json 'packages/*/package.json' apps/kaidan/package.json` → 输出为空

## 全量验收（四个都合完后）
1. A1 `pnpm install --frozen-lockfile` → 退出码 0
2. A2 `pnpm typecheck` → 退出码 0
3. A3 `pnpm test` → 退出码 0，0 failed
4. A4 `pnpm lint:skills` → 最后一行 `skills: 7 OK`
5. A5 `pnpm eval:validate` → 含 `dataset OK` 与 `tasks: 20 OK`
6. A6 `pnpm kaidan doctor --config config/demo.mock.yaml` → 退出码 0，含 `adapter: mock`、`skills: 7`、`model: 阿里云百炼 通义千问`
7. B1–B6 `pnpm test:e2e` → 6 个文件全部通过
8. C1 `pnpm --filter @kaidan/contracts test` → 通过
9. C2 同上 → 输出为空

## 允许的改动
只允许改"集成缝隙"——两个 track 各自符合 spec、但接起来不对的地方，优先改 apps/kaidan/src/**。不允许修改任何冻结路径（契约、验收用例、根配置、各包 package.json），不允许在这里补任何一个 track 漏掉的功能——漏了就在回执里写明，退回给那个 track。

## 完成后
git add -A && git commit -m "TΩ: 集成合流" && git tag mvp-r1

输出回执，最后一行严格按这个格式：
RECEIPT TΩ status=<done|blocked> merged=<合入数>/4 checks=<通过数>/9

回执正文包含：每次合入后的检查结果；遇到的冲突及判定依据；为修缝改了哪些文件、为什么；全量验收 1–9 的实际输出关键行；还差什么（退回给哪个 track）。
