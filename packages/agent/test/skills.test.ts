// spec 第 6 节 T2 行②：loadSkills 正反例（spec 3.2 第 7 条）。技能文件写在临时目录，不依赖 packages/skills 的内容。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCode, isKaidanError, type KaidanError } from "@kaidan/contracts";
import { loadSkills } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "kaidan-skills-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  return root;
}

function skillMd(fm: string, body = "## 何时使用\n正文。\n"): string {
  return `---\n${fm.trim()}\n---\n\n${body}`;
}

const DAILY = skillMd(
  `
name: daily-brief
description: 每天早上给销售推送的晨报技能。
command: /晨报
allowed_tools: [pipeline_snapshot, calendar_today, crm_get, crm_timeline]
schedule: daily_brief
`,
  "## 何时使用\n早上。\n\n## 步骤\n1. 调用 pipeline_snapshot。\n",
);
const SETUP = skillMd(`
name: setup
description: 管理员初始化字段映射用的技能。
command: /初始化
allowed_tools:
  - schema_inspect
roles: [admin]
`);
const ASSISTANT = skillMd(`
name: assistant
description: 缺省技能，回答销售的一般问题。
allowed_tools: [crm_search, crm_get]
`);

async function caught(p: Promise<unknown>): Promise<KaidanError> {
  const e = await p.then(
    () => expect.fail("期望抛出 CONFIG"),
    (x: unknown) => x,
  );
  expect(isKaidanError(e), String(e)).toBe(true);
  expect((e as KaidanError).code).toBe(ErrorCode.CONFIG);
  return e as KaidanError;
}

describe("loadSkills", () => {
  it("读取每个子目录的 SKILL.md，映射字段并按 name 排序", async () => {
    const root = tmp({
      "setup/SKILL.md": SETUP,
      "daily-brief/SKILL.md": DAILY,
      "assistant/SKILL.md": ASSISTANT,
    });
    const skills = await loadSkills(root);
    expect(skills.map((s) => s.name)).toEqual(["assistant", "daily-brief", "setup"]);

    const daily = skills[1]!;
    expect(daily).toEqual({
      name: "daily-brief",
      description: "每天早上给销售推送的晨报技能。",
      command: "/晨报",
      allowedTools: ["pipeline_snapshot", "calendar_today", "crm_get", "crm_timeline"],
      schedule: "daily_brief",
      body: "## 何时使用\n早上。\n\n## 步骤\n1. 调用 pipeline_snapshot。\n",
      path: join(root, "daily-brief", "SKILL.md"),
    });
    expect(skills[2]).toMatchObject({ roles: ["admin"], allowedTools: ["schema_inspect"] });
    expect(skills[0]).not.toHaveProperty("command");
    expect(skills[0]).not.toHaveProperty("roles");
  });

  it("没有 SKILL.md 的子目录与根目录下的散文件被跳过；CRLF 与 BOM 也能解析", async () => {
    const root = tmp({
      "assistant/SKILL.md": "﻿" + ASSISTANT.replace(/\n/g, "\r\n"),
      "drafts/README.md": "not a skill",
      "notes.md": "---\nname: bogus\n---\n",
    });
    const skills = await loadSkills(root);
    expect(skills.map((s) => s.name)).toEqual(["assistant"]);
    expect(skills[0]!.allowedTools).toEqual(["crm_search", "crm_get"]);
  });

  it("空目录 → 空数组", async () => {
    expect(await loadSkills(tmp({}))).toEqual([]);
  });

  it("allowed_tools 含未知工具 → CONFIG，message 含文件路径", async () => {
    const root = tmp({
      "assistant/SKILL.md": skillMd(`
name: assistant
description: 缺省技能，回答销售的一般问题。
allowed_tools: [crm_search, crm_delete]
`),
    });
    const e = await caught(loadSkills(root));
    expect(e.message).toContain(join(root, "assistant", "SKILL.md"));
    expect(e.message).toContain("allowed_tools");
  });

  it("name 不在 SKILL_NAMES / description 过短 / command 不以 / 开头 → CONFIG", async () => {
    const bad = [
      `name: unknown-skill\ndescription: 这是一个不存在的技能名称。\nallowed_tools: [crm_get]`,
      `name: assistant\ndescription: 太短\nallowed_tools: [crm_get]`,
      `name: assistant\ndescription: 缺省技能，回答销售的一般问题。\ncommand: 晨报\nallowed_tools: [crm_get]`,
      `name: assistant\ndescription: 缺省技能，回答销售的一般问题。\nallowed_tools: []`,
    ];
    for (const fm of bad) {
      await caught(loadSkills(tmp({ "x/SKILL.md": skillMd(fm) })));
    }
  });

  it("缺少 frontmatter / frontmatter 未闭合 / YAML 语法错误 → CONFIG", async () => {
    const path = (root: string) => join(root, "a", "SKILL.md");
    const r1 = tmp({ "a/SKILL.md": "# 没有 frontmatter\n" });
    expect((await caught(loadSkills(r1))).message).toContain(path(r1));
    const r2 = tmp({ "a/SKILL.md": "---\nname: assistant\n正文\n" });
    expect((await caught(loadSkills(r2))).message).toContain(path(r2));
    const r3 = tmp({ "a/SKILL.md": "---\nname: [assistant\n---\n正文\n" });
    expect((await caught(loadSkills(r3))).message).toContain(path(r3));
  });

  it("两个子目录声明同一 name → CONFIG", async () => {
    const root = tmp({ "a/SKILL.md": ASSISTANT, "b/SKILL.md": ASSISTANT });
    expect((await caught(loadSkills(root))).message).toContain("assistant");
  });

  it("目录不存在 → CONFIG", async () => {
    await caught(loadSkills(join(tmpdir(), "kaidan-no-such-dir-" + Date.now())));
  });
});
