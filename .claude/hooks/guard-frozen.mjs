#!/usr/bin/env node
// PreToolUse 守卫：当仓库根目录存在 .contracts.lock 时，拦截对其中冻结路径的写入（Edit / Write / MultiEdit / NotebookEdit）。
// 退出码 2 = 拦截，stderr 内容会反馈给 Claude。T0 完成时创建 .contracts.lock；删除该文件即解除冻结。
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // "**/" 也匹配零层目录
      } else re += "[^/]*";
    } else if ("\\^$+?.()|{}[]".includes(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp("^" + re + "$");
}

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {
  process.exit(0);
}
const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const lockPath = resolve(root, ".contracts.lock");
if (!existsSync(lockPath)) process.exit(0);

let lock;
try {
  lock = JSON.parse(readFileSync(lockPath, "utf8"));
} catch {
  process.stderr.write(".contracts.lock 不是合法 JSON，已拦截所有写入，请人工修复。\n");
  process.exit(2);
}
const patterns = (lock.frozen || []).map((g) => [g, globToRegExp(g)]);
const ti = input.tool_input || {};
const targets = [ti.file_path, ti.notebook_path].filter((p) => typeof p === "string" && p.length > 0);

for (const p of targets) {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs).split(sep).join("/");
  if (rel.startsWith("..")) continue; // 仓库外文件不管
  for (const [g, re] of patterns) {
    if (re.test(rel)) {
      process.stderr.write(
        `【已拦截】${rel} 属于冻结路径（${g}，见 .contracts.lock）。` +
          `契约/骨架/验收用例在本轮不可修改：请停止，并在回执里以 status=blocked 报告你需要的改动。\n`,
      );
      process.exit(2);
    }
  }
}
process.exit(0);
