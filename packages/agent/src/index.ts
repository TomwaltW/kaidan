// @kaidan/agent —— T0 桩：导出名与类型冻结（spec 3.2），由 T2 替换为实现。
import {
  notImplemented,
  type CreateAgentRuntime,
  type CreateOpenAICompatibleProvider,
  type CreateScriptedProvider,
  type LoadSkills,
} from "@kaidan/contracts";

export const createAgentRuntime: CreateAgentRuntime = () => notImplemented("@kaidan/agent.createAgentRuntime");

export const createOpenAICompatibleProvider: CreateOpenAICompatibleProvider = () =>
  notImplemented("@kaidan/agent.createOpenAICompatibleProvider");

export const createScriptedProvider: CreateScriptedProvider = () =>
  notImplemented("@kaidan/agent.createScriptedProvider");

export const loadSkills: LoadSkills = async () => notImplemented("@kaidan/agent.loadSkills");
