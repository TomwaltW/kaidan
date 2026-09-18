// @kaidan/skills —— SKILLS_DIR 由 T0 实现，语义冻结（T3 不得改变取值方式）；lintSkills 为 T0 桩，由 T3 实现。
import { fileURLToPath } from "node:url";
import { notImplemented } from "@kaidan/contracts";

/** 本包根目录下 skills/ 的绝对路径（packages/skills/skills）；每个子目录一个技能，目录名 = 技能名，内含 SKILL.md */
export const SKILLS_DIR: string = fileURLToPath(new URL("../skills", import.meta.url));

/** 校验 dir 下的全部技能（附录 B 规则）；由 T3 实现 */
export async function lintSkills(dir: string): Promise<{ ok: boolean; count: number; errors: string[] }> {
  void dir;
  return notImplemented("@kaidan/skills.lintSkills");
}
