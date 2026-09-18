// loadSkills（spec 3.2 第 7 条）：读取 dir 下每个子目录的 SKILL.md，校验 frontmatter，按 name 排序。
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { ErrorCode, KaidanError, SkillFrontmatter, type LoadSkills, type SkillManifest } from "@kaidan/contracts";

export const loadSkills: LoadSkills = async (dir) => {
  const root = resolve(dir);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    throw new KaidanError(ErrorCode.CONFIG, `技能目录无法读取：${root}`, { cause: e });
  }

  const skills: SkillManifest[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "SKILL.md");
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; // 没有 SKILL.md 的子目录跳过
      throw new KaidanError(ErrorCode.CONFIG, `技能文件无法读取：${path}`, { cause: e });
    }
    skills.push(parseSkill(text, path));
  }

  const seen = new Map<string, string>();
  for (const s of skills) {
    const prev = seen.get(s.name);
    if (prev) throw new KaidanError(ErrorCode.CONFIG, `技能名称重复：${s.name}（${prev} 与 ${s.path}）`);
    seen.set(s.name, s.path);
  }
  return skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};

function parseSkill(text: string, path: string): SkillManifest {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    throw new KaidanError(ErrorCode.CONFIG, `技能文件缺少 frontmatter（首行应为 ---）：${path}`);
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) throw new KaidanError(ErrorCode.CONFIG, `技能文件 frontmatter 未闭合（缺少结尾的 ---）：${path}`);

  let raw: unknown;
  try {
    raw = parse(lines.slice(1, end).join("\n"));
  } catch (e) {
    throw new KaidanError(ErrorCode.CONFIG, `技能文件 frontmatter 不是合法 YAML：${path}：${(e as Error).message}`, {
      cause: e,
    });
  }
  const fm = SkillFrontmatter.safeParse(raw);
  if (!fm.success) {
    const where = fm.error.issues.map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`).join("; ");
    throw new KaidanError(ErrorCode.CONFIG, `技能文件 frontmatter 不合法：${path}：${where}`);
  }
  const f = fm.data;
  return {
    name: f.name,
    description: f.description,
    ...(f.command !== undefined ? { command: f.command } : {}),
    allowedTools: [...f.allowed_tools],
    ...(f.schedule !== undefined ? { schedule: f.schedule } : {}),
    ...(f.roles !== undefined ? { roles: [...f.roles] } : {}),
    body: lines.slice(end + 1).join("\n").replace(/^\n+/, ""),
    path,
  };
}
