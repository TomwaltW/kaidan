// @kaidan/tools —— createToolRegistry：8 个工具 + 统一 invoke（校验、权限、审计、出口净化）。
import {
  ErrorCode,
  KaidanError,
  ToolName,
  isKaidanError,
  type CreateToolRegistry,
  type ToolContext,
  type ToolDef,
  type ToolInvokeResult,
} from "@kaidan/contracts";
import { buildTools } from "./tools.js";
import { sanitize } from "./util.js";

export { riskReasons } from "./risk.js";
export { maskPhonesInText, sanitize } from "./util.js";

/** 读取不可见记录时的固定文案：不带任何记录内容（spec 3.3） */
export const DENIED_MESSAGE = "无权限访问该记录";

function summarizeIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 5)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

export const createToolRegistry: CreateToolRegistry = (deps) => {
  const tools = buildTools(deps);
  const byName = new Map<string, ToolDef>(tools.map((t) => [t.name, t]));

  async function audit(ctx: ToolContext, type: "tool_call" | "permission_denied", data: Record<string, unknown>) {
    try {
      await deps.audit.append({
        tenantId: ctx.actor.tenantId,
        actorUserId: ctx.actor.userId,
        type,
        traceId: ctx.traceId,
        data,
      });
    } catch (e) {
      // 审计失败不能让 invoke 抛出；只记 stderr（不含正文）
      process.stderr.write(`[tools] 审计写入失败：${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  async function run(ctx: ToolContext, name: string, rawInput: unknown): Promise<unknown> {
    // 技能边界（第 3 轮 R1）：先于「未知工具」检查，技能外的未知工具名得到的也是这句文案（与第 2 轮 agent 侧逐字一致）；
    // ctx.allowedTools 不存在（MCP）= 不限技能边界
    if (ctx.allowedTools && !ctx.allowedTools.includes(name as ToolName)) {
      throw new KaidanError(ErrorCode.VALIDATION, `当前技能不允许调用工具 ${name}`);
    }
    const tool = ToolName.safeParse(name).success ? byName.get(name) : undefined;
    if (!tool) throw new KaidanError(ErrorCode.VALIDATION, `未知工具：${name}`);
    // 模型给的原始参数串由 registry 解析（第 3 轮 R1）：空串 / 纯空白视为 {}；非字符串照旧直接交给 zod
    let input = rawInput;
    if (typeof rawInput === "string") {
      try {
        input = rawInput.trim() === "" ? {} : JSON.parse(rawInput);
      } catch {
        throw new KaidanError(ErrorCode.VALIDATION, `工具 ${name} 的参数不是合法 JSON`);
      }
    }
    const parsed = tool.input.safeParse(input ?? {});
    if (!parsed.success) {
      throw new KaidanError(ErrorCode.VALIDATION, `工具 ${name} 的参数不合法：${summarizeIssues(parsed.error.issues)}`);
    }
    const output = await tool.handler(ctx, parsed.data);
    const checked = tool.output.safeParse(output);
    if (!checked.success) {
      throw new KaidanError(ErrorCode.UPSTREAM, `工具 ${name} 的输出不符合契约：${summarizeIssues(checked.error.issues)}`);
    }
    return sanitize(checked.data);
  }

  return {
    list(filter) {
      if (!filter?.names) return [...tools];
      const wanted = new Set<string>(filter.names);
      return tools.filter((t) => wanted.has(t.name));
    },

    get(name) {
      return byName.get(name);
    },

    async invoke(ctx, name, rawInput): Promise<ToolInvokeResult> {
      const started = performance.now();
      const ms = () => Math.round((performance.now() - started) * 100) / 100;
      let result: ToolInvokeResult;
      try {
        result = { ok: true, output: await run(ctx, name, rawInput), ms: 0 };
      } catch (e) {
        let code: ErrorCode;
        let message: string;
        if (isKaidanError(e)) {
          code = e.code;
          // 适配器抛出的无权限一律用固定文案；工具层自己的检查（details.public）可以说明原因
          message = code === ErrorCode.PERMISSION_DENIED && e.details?.["public"] !== true ? DENIED_MESSAGE : e.message;
        } else {
          code = ErrorCode.UPSTREAM;
          message = "工具执行出错，请稍后再试";
          process.stderr.write(`[tools] ${name} 异常：${e instanceof Error ? e.message : String(e)}\n`);
        }
        result = { ok: false, error: { code, message: sanitize(message) as string }, ms: 0 };
      }
      result.ms = ms();
      const tool = String(name).slice(0, 64); // 未知工具名来自模型输入，截断后再进审计
      await audit(ctx, "tool_call", {
        tool,
        ok: result.ok,
        ms: result.ms,
        ...(result.ok ? {} : { errorCode: result.error.code }),
      });
      if (!result.ok && result.error.code === ErrorCode.PERMISSION_DENIED) {
        await audit(ctx, "permission_denied", { tool });
      }
      return result;
    },
  };
};
