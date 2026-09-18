// @kaidan/contracts — agent.ts（冻结）
import { z } from "zod";
import { Role, type Actor } from "./rom.js";
import { ToolName, type ToolRegistry } from "./tools.js";
import type { AuditLog, Proposal, ProposalService } from "./governance.js";

export interface LlmToolCall {
  id: string;
  name: string;
  arguments: string; // JSON 字符串
}

export type LlmMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; toolCalls?: LlmToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export type AssistantMessage = Extract<LlmMessage, { role: "assistant" }>;

export interface LlmToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema（由 zod 的 z.toJSONSchema 生成）
}

export interface LlmRequest {
  messages: LlmMessage[];
  tools?: LlmToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse {
  message: AssistantMessage;
  usage: LlmUsage;
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
}

/** 生成式 AI 合规公示：界面上必须能展示所用模型名称与备案/登记编号 */
export interface ModelDisclosure {
  providerName: string;
  modelName: string;
  filingNo?: string;
}

export interface LlmProvider {
  readonly id: string;
  readonly disclosure: ModelDisclosure;
  chat(req: LlmRequest): Promise<LlmResponse>;
}

/** 测试与演示用：按顺序吐出预设步骤，不看输入；requests 记录收到的每次请求 */
export interface ScriptStep {
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  content?: string;
}
export interface ScriptedLlmProvider extends LlmProvider {
  readonly requests: LlmRequest[];
  /** 剩余未消费的步骤数；步骤耗尽后再被调用 → 抛 KaidanError(CONFIG) */
  remaining(): number;
}

/** 技能名称是冻结契约的一部分：e2e 与 eval 都按名字引用 */
export const SKILL_NAMES = [
  "assistant", // 缺省技能（无命令）
  "daily-brief", // /晨报
  "call-prep", // /会前
  "deal-review", // /商机体检
  "post-meeting", // /会后
  "weekly-review", // /周报
  "setup", // /初始化（仅 admin）
] as const;
export type SkillName = (typeof SKILL_NAMES)[number];

/** SKILL.md 的 YAML frontmatter */
export const SkillFrontmatter = z.object({
  name: z.enum(SKILL_NAMES),
  description: z.string().min(10).max(400),
  command: z.string().regex(/^\/\S+$/).optional(),
  allowed_tools: z.array(ToolName).min(1),
  schedule: z.enum(["daily_brief", "weekly_review"]).optional(),
  roles: z.array(Role).optional(), // 缺省 = 所有角色
});
export type SkillFrontmatter = z.infer<typeof SkillFrontmatter>;

export interface SkillManifest {
  name: SkillName;
  description: string;
  command?: string;
  allowedTools: ToolName[];
  schedule?: "daily_brief" | "weekly_review";
  roles?: Array<"rep" | "manager" | "admin">;
  body: string; // frontmatter 之后的 Markdown 正文
  path: string;
}

export interface AgentRunInput {
  actor: Actor;
  text: string;
  traceId: string;
  channel: "feishu" | "cli" | "eval" | "schedule";
  /** 显式指定技能时跳过路由 */
  skill?: SkillName;
}

export interface AgentRunResult {
  traceId: string;
  skill: SkillName;
  reply: string; // Markdown
  proposals: Proposal[]; // 本次运行产生的提案（均为 pending）
  toolCalls: { name: string; ok: boolean; ms: number; errorCode?: string }[];
  usage: LlmUsage;
  steps: number; // LLM 调用次数
  stoppedBy: "final" | "max_steps" | "budget" | "error" | "forbidden";
  disclosure: ModelDisclosure;
}

export interface AgentLimits {
  maxSteps: number; // 缺省 8
  maxToolCalls: number; // 缺省 12
  maxInputTokens: number; // 缺省 80000（按 usage 累计）
}

/**
 * 运行规则：
 *  - 路由：input.skill > 文本以某技能 command 开头（去掉命令后作为用户文本）> "assistant"
 *  - 技能 roles 不含 actor 任一角色 → 不调模型，stoppedBy="forbidden"，写 audit permission_denied
 *  - 系统提示 = systemPreamble? + SECURITY_PREAMBLE + 技能正文 + 当前时间/用户信息
 *  - 只把 skill.allowedTools 暴露给模型；模型调用其他工具 → 工具消息返回 VALIDATION 错误
 *  - 工具消息内容 = formatToolResultForModel(result)
 *  - 每次 LLM 调用写 audit llm_call（data: {provider, inputTokens, outputTokens, finishReason}）；开始时写 skill_invoked
 *  - 超过 limits → 停止并在 reply 里说明；provider 抛错 → stoppedBy="error"，reply 给出友好提示，不抛出
 */
export interface AgentRuntime {
  run(input: AgentRunInput): Promise<AgentRunResult>;
  skills(): SkillManifest[];
}

export interface AgentDeps {
  provider: LlmProvider;
  tools: ToolRegistry;
  audit: AuditLog;
  proposals: ProposalService;
  skills: SkillManifest[];
  limits?: Partial<AgentLimits>;
  systemPreamble?: string;
  timezone: string;
  clock?: () => Date;
}
