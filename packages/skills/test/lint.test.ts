import { cp, mkdtemp, readFile, rm, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SKILL_NAMES } from "@kaidan/contracts";
import { SKILLS_DIR, lintSkills } from "../src/index.js";
import { APPENDIX_B, splitSkillFile, toolNamesInBody } from "../src/lint-skills.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kaidan-skills-"));
  await cp(SKILLS_DIR, dir, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = (name: string) => join(dir, name, "SKILL.md");
async function edit(name: string, fn: (text: string) => string): Promise<void> {
  const p = file(name);
  const before = await readFile(p, "utf8");
  const after = fn(before);
  expect(after).not.toBe(before); // 确认反例真的改到了内容
  await writeFile(p, after);
}

describe("lintSkills：正例", () => {
  it("仓库里的 7 个技能全部通过", async () => {
    const r = await lintSkills(SKILLS_DIR);
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ ok: true, count: 7 });
  });

  it("每个技能的 frontmatter 与附录 B 一致，正文 ≤ 6000 字符", async () => {
    for (const name of SKILL_NAMES) {
      const parsed = splitSkillFile(await readFile(join(SKILLS_DIR, name, "SKILL.md"), "utf8"));
      expect(parsed).not.toBeNull();
      const fm = parsed!.frontmatter as Record<string, unknown>;
      expect(fm.name).toBe(name);
      expect(fm.command).toBe(APPENDIX_B[name].command);
      expect([...(fm.allowed_tools as string[])].sort()).toEqual([...APPENDIX_B[name].allowedTools].sort());
      expect([...parsed!.body.trim()].length).toBeLessThanOrEqual(6000);
    }
  });

  it("没有写入工具的技能不提到 propose_update / propose_create", async () => {
    for (const name of ["daily-brief", "weekly-review", "setup"] as const) {
      const parsed = splitSkillFile(await readFile(join(SKILLS_DIR, name, "SKILL.md"), "utf8"));
      const used = toolNamesInBody(parsed!.body);
      expect(used).not.toContain("propose_update");
      expect(used).not.toContain("propose_create");
    }
  });
});

describe("lintSkills：反例", () => {
  it("缺章节 → 报缺少「## 边界」", async () => {
    await edit("deal-review", (t) => t.replace("## 边界", "## 其他"));
    const r = await lintSkills(dir);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([expect.stringContaining("deal-review/SKILL.md: 缺少章节「## 边界」")]);
  });

  it("正文提到未授权工具 → 报错（daily-brief 提到 propose_update）", async () => {
    await edit("daily-brief", (t) => t.replace("晨报只读不写", "晨报只读不写，不要调用 propose_update"));
    const r = await lintSkills(dir);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([expect.stringContaining("正文提到了未授权工具 propose_update")]);
  });

  it("frontmatter 的 allowed_tools 超出附录 B → 报错", async () => {
    await edit("weekly-review", (t) => t.replace("allowed_tools: [pipeline_snapshot,", "allowed_tools: [crm_get, pipeline_snapshot,"));
    const r = await lintSkills(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("weekly-review/SKILL.md: allowed_tools 应为"))).toBe(true);
  });

  it("命令重复 → 报重复", async () => {
    await edit("call-prep", (t) => t.replace("command: /会前", "command: /晨报"));
    const r = await lintSkills(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes("命令 /晨报") && e.includes("重复"))).toBe(true);
  });

  it("名称与目录不符 → 报错", async () => {
    await rename(join(dir, "deal-review"), join(dir, "deal-check"));
    const r = await lintSkills(dir);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('deal-check/SKILL.md: name "deal-review" 与目录名 "deal-check" 不符');
  });

  it("缺 schedule → 报错（daily-brief 必须是 daily_brief）", async () => {
    await edit("daily-brief", (t) => t.replace("schedule: daily_brief\n", ""));
    const r = await lintSkills(dir);
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual([expect.stringContaining("daily-brief/SKILL.md: schedule 应为 daily_brief，实际为 （无）")]);
  });

  it("setup 丢了 roles: [admin] → 报错", async () => {
    await edit("setup", (t) => t.replace("roles: [admin]\n", ""));
    const r = await lintSkills(dir);
    expect(r.errors.some((e) => e.includes("setup/SKILL.md: roles 应为 [admin]"))).toBe(true);
  });

  it("正文超过 6000 字符 → 报错", async () => {
    await edit("assistant", (t) => t + "\n" + "长".repeat(6001));
    const r = await lintSkills(dir);
    expect(r.errors.some((e) => e.includes("assistant/SKILL.md: 正文") && e.includes("超过上限 6000"))).toBe(true);
  });

  it("frontmatter 不合契约 / 缺失 → 报错", async () => {
    await edit("assistant", (t) => t.replace("name: assistant", "name: helper"));
    await edit("setup", (t) => t.replace(/^---\n[\s\S]*?\n---\n/, ""));
    const r = await lintSkills(dir);
    expect(r.errors.some((e) => e.startsWith("assistant/SKILL.md: frontmatter.name"))).toBe(true);
    expect(r.errors).toContain("setup/SKILL.md: 缺少 --- 包裹的 YAML frontmatter");
  });

  it("缺少技能目录 / 缺 SKILL.md → 报错", async () => {
    await rm(join(dir, "weekly-review", "SKILL.md"));
    const r = await lintSkills(dir);
    expect(r.count).toBe(6);
    expect(r.errors).toEqual(["weekly-review: 缺少 SKILL.md", "缺少技能：weekly-review"]);
    expect((await lintSkills(join(dir, "nope"))).ok).toBe(false);
  });
});
