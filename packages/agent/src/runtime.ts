// Agent 循环（spec 3.1 agent.ts「运行规则」、3.2 第 4 条、3.3 失败面）。
// 模型只能经 ToolRegistry 调用技能允许的工具；写 CRM 只会产生提案，提交不在这里发生。
import { z } from "zod";
import {
  ErrorCode,
  SECURITY_PREAMBLE,
  formatToolResultForModel,
  isKaidanError,
  type Actor,
  type AgentDeps,
  type AgentLimits,
  type AgentRunInput,
  type AgentRunResult,
  type AgentRuntime,
  type CreateAgentRuntime,
  type LlmMessage,
  type LlmToolSpec,
  type LlmUsage,
  type Proposal,
  type SkillManifest,
  type SkillName,
  type ToolInvokeResult,
} from "@kaidan/contracts";

export const DEFAULT_LIMITS: AgentLimits = { maxSteps: 8, maxToolCalls: 12, maxInputTokens: 80_000 };

const PROPOSE_TOOLS = new Set(["propose_update", "propose_create"]);

// 补救追问（dev-spec-2026-09-23 §2 R3）：技能允许 propose_*、本轮以 final 结束、0 个提案、回复却声称已生成 / 已更新 →
// 追加一条 user 消息，带 FOLLOW_UP_TOOL_CHOICE 再要一步；最多一次，计入 maxSteps。
/** 追问那一步的 tool_choice（2026-09-23 用户选定 "required"；百炼是否支持待真密钥核实，不支持时只改这一个常量） */
const FOLLOW_UP_TOOL_CHOICE = "required" as const;
const FOLLOW_UP_TRIGGER = /提案|已更新|已生成|已记录/;
const FOLLOW_UP_PROMPT = "你还没有调用写入工具，现在只输出工具调用";
const NO_PROPOSAL_REPLY = "这次没有生成提案。";

export const createAgentRuntime: CreateAgentRuntime = (deps: AgentDeps): AgentRuntime => {
  const limits: AgentLimits = { ...DEFAULT_LIMITS, ...definedOnly(deps.limits ?? {}) };
  const clock = deps.clock ?? (() => new Date());
  const skills = [...deps.skills];
  const byName = new Map(skills.map((s) => [s.name, s]));
  // 命令按长度降序匹配，避免短命令抢先匹配到长命令的前缀
  const byCommand = skills
    .filter((s): s is SkillManifest & { command: string } => typeof s.command === "string" && s.command.length > 0)
    .sort((a, b) => b.command.length - a.command.length);

  function route(input: AgentRunInput): { skillName: SkillName; text: string } {
    const trimmed = input.text.trim();
    if (input.skill) {
      const cmd = byName.get(input.skill)?.command;
      return { skillName: input.skill, text: cmd && trimmed.startsWith(cmd) ? trimmed.slice(cmd.length).trim() : trimmed };
    }
    const hit = byCommand.find((s) => trimmed.startsWith(s.command));
    if (hit) return { skillName: hit.name, text: trimmed.slice(hit.command.length).trim() };
    return { skillName: "assistant", text: trimmed };
  }

  async function run(input: AgentRunInput): Promise<AgentRunResult> {
    const { actor, traceId } = input;
    const { skillName, text } = route(input);
    const usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
    const toolCalls: AgentRunResult["toolCalls"] = [];
    const proposalIds: string[] = [];
    let steps = 0;

    const finish = async (stoppedBy: AgentRunResult["stoppedBy"], reply: string): Promise<AgentRunResult> => ({
      traceId,
      skill: skillName,
      reply,
      proposals: await collectProposals(proposalIds),
      toolCalls,
      usage,
      steps,
      stoppedBy,
      disclosure: { ...deps.provider.disclosure },
    });

    const skill = byName.get(skillName);
    if (!skill) return finish("error", `技能「${skillName}」未加载，请联系管理员检查技能配置。`);

    if (skill.roles && !skill.roles.some((r) => actor.roles.includes(r))) {
      await audit(actor, traceId, "permission_denied", { skill: skill.name });
      return finish("forbidden", `你没有使用「${skill.name}」技能的权限。`);
    }

    await audit(actor, traceId, "skill_invoked", { skill: skill.name, channel: input.channel });

    const tools = toolSpecs(skill);
    const canPropose = skill.allowedTools.some((t) => PROPOSE_TOOLS.has(t));
    let followedUp = false;
    let toolChoice: typeof FOLLOW_UP_TOOL_CHOICE | undefined;
    const messages: LlmMessage[] = [
      { role: "system", content: systemPrompt(skill, actor) },
      { role: "user", content: text || skill.name },
    ];
    let lastContent = "";

    for (;;) {
      if (steps >= limits.maxSteps) {
        return finish("max_steps", withNote(lastContent, `已达到单次对话的步数上限（${limits.maxSteps} 步），已停止。请缩小问题范围后重试。`));
      }
      if (usage.inputTokens >= limits.maxInputTokens) {
        return finish("budget", withNote(lastContent, `本次对话的输入 token 已达上限（${limits.maxInputTokens}），已停止。请缩小问题范围后重试。`));
      }

      let res;
      try {
        res = await deps.provider.chat({
          messages: [...messages],
          ...(tools.length ? { tools } : {}),
          ...(tools.length && toolChoice ? { toolChoice } : {}),
        });
      } catch (e) {
        return finish("error", friendlyProviderError(e));
      }
      steps++;
      toolChoice = undefined;
      usage.inputTokens += res.usage.inputTokens;
      usage.outputTokens += res.usage.outputTokens;
      await audit(actor, traceId, "llm_call", {
        provider: deps.provider.id,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        finishReason: res.finishReason,
      });

      const msg = res.message;
      messages.push(msg);
      lastContent = msg.content ?? "";
      const calls = msg.toolCalls ?? [];
      if (calls.length === 0) {
        if (!followedUp && canPropose && proposalIds.length === 0 && FOLLOW_UP_TRIGGER.test(lastContent)) {
          followedUp = true;
          toolChoice = FOLLOW_UP_TOOL_CHOICE;
          messages.push({ role: "user", content: FOLLOW_UP_PROMPT });
          continue;
        }
        if (followedUp && proposalIds.length === 0) return finish("final", NO_PROPOSAL_REPLY);
        return finish("final", lastContent);
      }

      for (const call of calls) {
        if (toolCalls.length >= limits.maxToolCalls) {
          return finish("budget", withNote(lastContent, `本次对话的工具调用次数已达上限（${limits.maxToolCalls} 次），已停止。请缩小问题范围后重试。`));
        }
        const result = await invokeTool(call.name, call.arguments, {
          actor,
          traceId,
          now: clock(),
          skill: skill.name,
          allowedTools: skill.allowedTools,
        });
        toolCalls.push({
          name: call.name,
          ok: result.ok,
          ms: result.ms,
          ...(result.ok ? {} : { errorCode: result.error.code }),
        });
        if (result.ok && PROPOSE_TOOLS.has(call.name)) {
          const pid = (result.output as { proposalId?: unknown } | null)?.proposalId;
          if (typeof pid === "string") proposalIds.push(pid);
        }
        messages.push({ role: "tool", toolCallId: call.id, content: formatToolResultForModel(result) });
      }
    }
  }

  /** 技能边界（ctx.allowedTools）与参数解析都交给 registry（第 3 轮 R1）：模型给的原始参数字符串原样交过去，被拒的调用也由 registry 写 tool_call 审计 */
  async function invokeTool(
    name: string,
    rawArgs: string,
    ctx: Parameters<AgentDeps["tools"]["invoke"]>[0],
  ): Promise<ToolInvokeResult> {
    try {
      return await deps.tools.invoke(ctx, name, rawArgs);
    } catch (e) {
      // 契约规定 invoke 永不抛出；这里兜底，避免单个工具拖垮整次运行
      const code = isKaidanError(e) ? e.code : ErrorCode.UPSTREAM;
      return { ok: false, error: { code, message: "工具执行失败" }, ms: 0 };
    }
  }

  function toolSpecs(skill: SkillManifest): LlmToolSpec[] {
    return deps.tools.list({ names: skill.allowedTools }).map((def) => {
      const { $schema: _drop, ...parameters } = z.toJSONSchema(def.input, { io: "input" }) as Record<string, unknown>;
      return { name: def.name, description: def.description, parameters };
    });
  }

  function systemPrompt(skill: SkillManifest, actor: Actor): string {
    const parts: string[] = [];
    if (deps.systemPreamble) parts.push(deps.systemPreamble);
    parts.push(SECURITY_PREAMBLE, skill.body.trim());
    parts.push(
      [
        `当前时间：${formatNow(clock(), deps.timezone)}（${deps.timezone}）`,
        `当前用户：${actor.displayName}（${actor.roles.join("、")}）`,
      ].join("\n"),
    );
    return parts.join("\n\n");
  }

  async function audit(actor: Actor, traceId: string, type: "skill_invoked" | "llm_call" | "permission_denied", data: Record<string, unknown>) {
    await deps.audit.append({ tenantId: actor.tenantId, actorUserId: actor.userId, type, traceId, data });
  }

  async function collectProposals(ids: string[]): Promise<Proposal[]> {
    const out: Proposal[] = [];
    for (const id of ids) {
      const p = await deps.proposals.get(id);
      if (p) out.push(p);
    }
    return out;
  }

  return { run, skills: () => [...skills] };
};

function withNote(content: string, note: string): string {
  return content ? `${content}\n\n（${note}）` : note;
}

function friendlyProviderError(e: unknown): string {
  if (isKaidanError(e)) {
    if (e.code === ErrorCode.RATE_LIMITED) return "模型服务当前繁忙（限流），请稍后再试。";
    if (e.code === ErrorCode.CONFIG) return "模型服务配置有误，请联系管理员检查模型配置。";
  }
  return "模型服务暂时不可用，请稍后再试。";
}

function formatNow(d: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      weekday: "long",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return `${parts["year"]}-${parts["month"]}-${parts["day"]} ${parts["hour"]}:${parts["minute"]} ${parts["weekday"]}`;
}

function definedOnly<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
