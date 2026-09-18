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

    const allowed = new Set<string>(skill.allowedTools);
    const tools = toolSpecs(skill);
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
        res = await deps.provider.chat({ messages: [...messages], ...(tools.length ? { tools } : {}) });
      } catch (e) {
        return finish("error", friendlyProviderError(e));
      }
      steps++;
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
      if (calls.length === 0) return finish("final", lastContent);

      for (const call of calls) {
        if (toolCalls.length >= limits.maxToolCalls) {
          return finish("budget", withNote(lastContent, `本次对话的工具调用次数已达上限（${limits.maxToolCalls} 次），已停止。请缩小问题范围后重试。`));
        }
        const result = await invokeTool(call.name, call.arguments, allowed, {
          actor,
          traceId,
          now: clock(),
          skill: skill.name,
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

  /** 技能不允许的工具 / 参数不是 JSON → 直接给模型 VALIDATION 工具消息（不进 registry，因为 registry 不知道技能边界） */
  async function invokeTool(
    name: string,
    rawArgs: string,
    allowed: Set<string>,
    ctx: Parameters<AgentDeps["tools"]["invoke"]>[0],
  ): Promise<ToolInvokeResult> {
    if (!allowed.has(name)) {
      return { ok: false, error: { code: ErrorCode.VALIDATION, message: `当前技能不允许调用工具 ${name}` }, ms: 0 };
    }
    let args: unknown;
    try {
      args = rawArgs.trim() === "" ? {} : JSON.parse(rawArgs);
    } catch {
      return { ok: false, error: { code: ErrorCode.VALIDATION, message: `工具 ${name} 的参数不是合法 JSON` }, ms: 0 };
    }
    try {
      return await deps.tools.invoke(ctx, name, args);
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
