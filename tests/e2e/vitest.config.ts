// 验收用例（spec 2.2）的 vitest 配置；根脚本 `pnpm test:e2e` = `vitest run --root tests/e2e`
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    environment: "node",
    env: { TZ: "Asia/Shanghai" },
    testTimeout: 20_000,
  },
});
