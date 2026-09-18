// `pnpm --filter @kaidan/eval gen`：用固定种子生成 fixtures/crm-demo.json（附录 E）。同种子输出字节一致。
import { writeFile } from "node:fs/promises";
import { DEFAULT_SEED, FIXTURE_PATH, generateDataset, serializeDataset } from "./dataset.js";

const ds = generateDataset(DEFAULT_SEED);
await writeFile(FIXTURE_PATH, serializeDataset(ds), "utf8");
process.stdout.write(
  `已生成 ${FIXTURE_PATH}（seed=${DEFAULT_SEED}）：` +
    `客户 ${ds.accounts.length}、联系人 ${ds.contacts.length}、商机 ${ds.opportunities.length}、` +
    `活动 ${ds.activities.length}、待办 ${ds.tasks.length}、日程 ${ds.calendar.length}\n`,
);
