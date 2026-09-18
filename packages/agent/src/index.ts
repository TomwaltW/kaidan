// @kaidan/agent —— Agent 循环、模型 provider、技能加载（导出名与类型冻结，见 spec 3.2）。
import type { CreateOpenAICompatibleProvider } from "@kaidan/contracts";
import { openAICompatibleProvider } from "./openai-provider.js";

export { createAgentRuntime } from "./runtime.js";
export { createScriptedProvider } from "./scripted.js";
export { loadSkills } from "./skills.js";

export const createOpenAICompatibleProvider: CreateOpenAICompatibleProvider = (llm) => openAICompatibleProvider(llm);
