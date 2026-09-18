// 技能包校验（spec 附录 B）：frontmatter 合契约、与附录 B 冻结表一致、正文章节 / 长度 / 工具名约束。
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { SKILL_NAMES, SkillFrontmatter, ToolName, type SkillName } from "@kaidan/contracts";

/** 附录 B：name / command / allowed_tools / schedule / roles 冻结 */
export interface AppendixBRow {
  command?: string;
  allowedTools: readonly ToolName[];
  schedule?: "daily_brief" | "weekly_review";
  roles?: readonly ("rep" | "manager" | "admin")[];
}

export const APPENDIX_B: Readonly<Record<SkillName, AppendixBRow>> = {
  assistant: {
    allowedTools: ["crm_search", "crm_get", "crm_timeline", "pipeline_snapshot", "calendar_today", "propose_update", "propose_create"],
  },
  "daily-brief": {
    command: "/晨报",
    allowedTools: ["pipeline_snapshot", "calendar_today", "crm_get", "crm_timeline"],
    schedule: "daily_brief",
  },
  "call-prep": {
    command: "/会前",
    allowedTools: ["calendar_today", "crm_search", "crm_get", "crm_timeline", "propose_create"],
  },
  "deal-review": {
    command: "/商机体检",
    allowedTools: ["crm_search", "crm_get", "crm_timeline", "propose_update", "propose_create"],
  },
  "post-meeting": {
    command: "/会后",
    allowedTools: ["crm_search", "crm_get", "crm_timeline", "propose_update", "propose_create"],
  },
  "weekly-review": {
    command: "/周报",
    allowedTools: ["pipeline_snapshot", "crm_search", "crm_timeline"],
    schedule: "weekly_review",
  },
  setup: {
    command: "/初始化",
    allowedTools: ["schema_inspect"],
    roles: ["admin"],
  },
};

export const REQUIRED_SECTIONS = ["何时使用", "步骤", "输出格式", "写入规则", "边界"] as const;
export const MAX_BODY_CHARS = 6000;

export interface LintResult {
  ok: boolean;
  count: number;
  errors: string[];
}

export interface ParsedSkillFile {
  frontmatter: unknown;
  body: string;
}

/** 拆出 `---` 包裹的 YAML frontmatter 与正文；没有 frontmatter → null */
export function splitSkillFile(text: string): ParsedSkillFile | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  return { frontmatter: parse(m[1] ?? ""), body: text.slice(m[0].length) };
}

/** 正文字符数（按 Unicode 码点计） */
export function bodyLength(body: string): number {
  return [...body.trim()].length;
}

/** 正文里出现的工具名（按 ToolName 全集扫描，前后不能紧邻标识符字符） */
export function toolNamesInBody(body: string): ToolName[] {
  return ToolName.options.filter((t) => new RegExp(`(?<![A-Za-z0-9_])${t}(?![A-Za-z0-9_])`).test(body));
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");
}

/** 校验单个技能文件，返回错误列表（不含跨技能规则） */
export function lintSkillText(dirName: string, text: string): { errors: string[]; name?: string; command?: string } {
  const where = `${dirName}/SKILL.md`;
  const errors: string[] = [];
  const parsed = splitSkillFile(text);
  if (!parsed) return { errors: [`${where}: 缺少 --- 包裹的 YAML frontmatter`] };

  const fm = SkillFrontmatter.safeParse(parsed.frontmatter);
  if (!fm.success) {
    for (const i of fm.error.issues) errors.push(`${where}: frontmatter.${i.path.join(".")}: ${i.message}`);
    return { errors };
  }
  const f = fm.data;
  if (f.name !== dirName) errors.push(`${where}: name "${f.name}" 与目录名 "${dirName}" 不符`);

  const row = APPENDIX_B[f.name];
  if (f.command !== row.command) {
    errors.push(`${where}: command 应为 ${row.command ?? "（无）"}，实际为 ${f.command ?? "（无）"}`);
  }
  if (!sameSet(f.allowed_tools, row.allowedTools)) {
    errors.push(`${where}: allowed_tools 应为 [${row.allowedTools.join(", ")}]，实际为 [${f.allowed_tools.join(", ")}]`);
  }
  if (new Set(f.allowed_tools).size !== f.allowed_tools.length) errors.push(`${where}: allowed_tools 有重复`);
  if (f.schedule !== row.schedule) {
    errors.push(`${where}: schedule 应为 ${row.schedule ?? "（无）"}，实际为 ${f.schedule ?? "（无）"}`);
  }
  if (!sameSet(f.roles ?? [], row.roles ?? [])) {
    errors.push(`${where}: roles 应为 [${(row.roles ?? []).join(", ")}]，实际为 [${(f.roles ?? []).join(", ")}]`);
  }

  const headings = new Set(
    parsed.body
      .split(/\r?\n/)
      .map((l) => /^##\s+(.+?)\s*$/.exec(l)?.[1])
      .filter((h): h is string => h !== undefined),
  );
  for (const s of REQUIRED_SECTIONS) if (!headings.has(s)) errors.push(`${where}: 缺少章节「## ${s}」`);

  const len = bodyLength(parsed.body);
  if (len > MAX_BODY_CHARS) errors.push(`${where}: 正文 ${len} 字符，超过上限 ${MAX_BODY_CHARS}`);

  const allowed = new Set<string>(f.allowed_tools);
  for (const t of toolNamesInBody(parsed.body)) {
    if (!allowed.has(t)) errors.push(`${where}: 正文提到了未授权工具 ${t}`);
  }

  return { errors, name: f.name, ...(f.command !== undefined ? { command: f.command } : {}) };
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** 校验 dir 下的全部技能：每个子目录一个 SKILL.md；7 个技能齐全；命令不重复 */
export async function lintSkills(dir: string): Promise<LintResult> {
  const errors: string[] = [];
  let entries: string[];
  try {
    entries = (await readdir(dir)).sort();
  } catch {
    return { ok: false, count: 0, errors: [`技能目录不存在：${dir}`] };
  }

  const seenNames = new Set<string>();
  const commands = new Map<string, string>();
  let count = 0;
  for (const entry of entries) {
    const sub = join(dir, entry);
    if (!(await isDir(sub))) continue;
    let text: string;
    try {
      text = await readFile(join(sub, "SKILL.md"), "utf8");
    } catch {
      errors.push(`${entry}: 缺少 SKILL.md`);
      continue;
    }
    count++;
    const r = lintSkillText(entry, text);
    errors.push(...r.errors);
    if (r.name) seenNames.add(r.name);
    if (r.command) {
      const prev = commands.get(r.command);
      if (prev) errors.push(`${entry}/SKILL.md: 命令 ${r.command} 与 ${prev} 重复`);
      else commands.set(r.command, entry);
    }
  }
  for (const n of SKILL_NAMES) if (!seenNames.has(n)) errors.push(`缺少技能：${n}`);

  return { ok: errors.length === 0, count, errors };
}
