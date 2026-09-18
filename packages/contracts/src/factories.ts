// @kaidan/contracts — factories.ts（冻结）
// 每个包必须以这些名字、这些类型导出工厂函数。T0 写桩（throw notImplemented），各 track 实现。
import type { KaidanConfig } from "./config.js";
import type { MockRomAdapter, RomAdapter } from "./adapter.js";
import type { Actor, RomDataset } from "./rom.js";
import type { ContextProvider, ToolDeps, ToolRegistry } from "./tools.js";
import type { Governance, GovernanceDeps } from "./governance.js";
import type {
  AgentDeps, AgentRuntime, LlmProvider, ModelDisclosure, ScriptStep, ScriptedLlmProvider, SkillManifest,
} from "./agent.js";
import type { IdentityResolver, LarkClientLike, Surface, SurfaceDeps } from "./surface.js";

// @kaidan/adapters（T1）
export type CreateMockAdapter = (dataset: RomDataset) => MockRomAdapter;
/** kind=mock 时读取 datasetPath（或用 opts.dataset）；kind=bitable 时读取 mapping 并用飞书 SDK */
export type CreateAdapter = (cfg: KaidanConfig, opts?: { dataset?: RomDataset }) => Promise<RomAdapter>;
export type CreateMockContextProvider = (dataset: RomDataset) => ContextProvider;
/** bitable 模式在 MVP 阶段的日程来源：永远返回 []（飞书日历接入是 P1） */
export type CreateNullContextProvider = () => ContextProvider;

// @kaidan/tools（T1）
export type CreateToolRegistry = (deps: ToolDeps) => ToolRegistry;

// @kaidan/mcp-server（T1）
export type StartMcpServer = (deps: ToolDeps & { actor: Actor }) => Promise<{ close(): Promise<void> }>;

// @kaidan/governance（T2）
export type CreateGovernance = (deps: GovernanceDeps) => Governance;

// @kaidan/agent（T2）
export type CreateAgentRuntime = (deps: AgentDeps) => AgentRuntime;
export type CreateOpenAICompatibleProvider = (llm: KaidanConfig["llm"]) => LlmProvider;
export type CreateScriptedProvider = (steps: ScriptStep[], disclosure?: ModelDisclosure) => ScriptedLlmProvider;
/** 读取 dir 下每个子目录的 SKILL.md；frontmatter 不合法 → KaidanError(CONFIG)；按 name 排序 */
export type LoadSkills = (dir: string) => Promise<SkillManifest[]>;

// @kaidan/surface-feishu（T4）
export type CreateFeishuSurface = (deps: SurfaceDeps) => Surface;
export type CreateConfigIdentityResolver = (cfg: KaidanConfig) => IdentityResolver;

// @kaidan/app（T0 写组装，TΩ 修缝）
export interface AppOverrides {
  dataset?: RomDataset;
  provider?: LlmProvider;
  larkClient?: LarkClientLike;
  clock?: () => Date;
}
export interface App {
  config: KaidanConfig;
  adapter: RomAdapter;
  context: ContextProvider;
  governance: Governance;
  tools: ToolRegistry;
  agent: AgentRuntime;
  identity: IdentityResolver;
  surface: Surface; // 只有调用 start() 才会连飞书
  close(): Promise<void>;
}
export type BuildApp = (config: KaidanConfig, overrides?: AppOverrides) => Promise<App>;
