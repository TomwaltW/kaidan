// 测试公共件：mini.json（只读）与四个身份。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RomDataset, type Actor } from "@kaidan/contracts";

export const MINI_PATH = fileURLToPath(new URL("../../../tests/e2e/fixtures/mini.json", import.meta.url));

export function loadMini(): RomDataset {
  return RomDataset.parse(JSON.parse(readFileSync(MINI_PATH, "utf8")));
}

const base = { tenantId: "demo" };
export const ZHANG: Actor = { ...base, userId: "ou_rep_zhang", displayName: "张三", roles: ["rep"], managerId: "ou_mgr_wang" };
export const LI: Actor = { ...base, userId: "ou_rep_li", displayName: "李四", roles: ["rep"], managerId: "ou_mgr_wang" };
export const WANG: Actor = {
  ...base,
  userId: "ou_mgr_wang",
  displayName: "王经理",
  roles: ["manager"],
  teamIds: ["ou_rep_zhang", "ou_rep_li"],
};
/** 没有下属的经理：只能看到自己的记录 */
export const LONELY_MGR: Actor = { ...base, userId: "ou_mgr_x", displayName: "孤单经理", roles: ["manager"], teamIds: [] };
export const ADMIN: Actor = { ...base, userId: "ou_admin", displayName: "管理员", roles: ["admin"] };

export const W = (key: string) => ({ idempotencyKey: key, proposalId: key });
