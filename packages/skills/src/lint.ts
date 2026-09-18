// `pnpm lint:skills` 入口：校验 SKILLS_DIR 下的技能，全部通过时最后一行输出 `skills: 7 OK`。
import { SKILLS_DIR, lintSkills } from "./index.js";

const r = await lintSkills(SKILLS_DIR);
if (!r.ok) {
  for (const e of r.errors) process.stderr.write(`✗ ${e}\n`);
  process.stdout.write(`skills: ${r.count} FAILED（${r.errors.length} 个问题）\n`);
  process.exit(1);
}
process.stdout.write(`skills: ${r.count} OK\n`);
