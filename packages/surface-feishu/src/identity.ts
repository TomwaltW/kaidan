// 身份解析（spec 3.2 第 8 条）：Actor.userId = openId，tenantId = config.tenantId；
// manager 的 teamIds = 所有 managerOpenId 指向他的用户（按 config 顺序）；listScheduled 按 config 顺序。
import type { Actor, CreateConfigIdentityResolver, KaidanConfig } from "@kaidan/contracts";

type ConfigUser = KaidanConfig["users"][number];

function toActor(cfg: KaidanConfig, u: ConfigUser): Actor {
  const actor: Actor = {
    tenantId: cfg.tenantId,
    userId: u.openId,
    displayName: u.displayName,
    roles: [...u.roles],
  };
  if (u.managerOpenId) actor.managerId = u.managerOpenId;
  if (u.roles.includes("manager")) {
    actor.teamIds = cfg.users.filter((x) => x.managerOpenId === u.openId).map((x) => x.openId);
  }
  return actor;
}

export const createConfigIdentityResolver: CreateConfigIdentityResolver = (cfg) => ({
  async resolveByOpenId(openId) {
    const u = cfg.users.find((x) => x.openId === openId);
    return u ? toActor(cfg, u) : null;
  },
  async listScheduled() {
    return cfg.users.filter((u) => u.scheduled === true).map((u) => toActor(cfg, u));
  },
});
