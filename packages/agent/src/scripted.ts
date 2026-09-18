// 脚本 provider（spec 3.2 第 6 条）：按顺序吐出预设步骤，不看输入；requests 记录每次请求的深拷贝。
import {
  ErrorCode,
  KaidanError,
  type AssistantMessage,
  type CreateScriptedProvider,
  type LlmRequest,
  type LlmResponse,
  type ModelDisclosure,
  type ScriptStep,
  type ScriptedLlmProvider,
} from "@kaidan/contracts";

const DEFAULT_DISCLOSURE: ModelDisclosure = { providerName: "脚本", modelName: "scripted" };

export const createScriptedProvider: CreateScriptedProvider = (steps, disclosure) => {
  const script: ScriptStep[] = structuredClone(steps);
  const requests: LlmRequest[] = [];
  let next = 0;

  const provider: ScriptedLlmProvider = {
    id: "scripted",
    disclosure: { ...(disclosure ?? DEFAULT_DISCLOSURE) },
    requests,
    remaining: () => script.length - next,
    async chat(req: LlmRequest): Promise<LlmResponse> {
      requests.push(copyRequest(req));
      const i = next;
      const step = script[i];
      if (!step) {
        throw new KaidanError(ErrorCode.CONFIG, `脚本 provider 的 ${script.length} 个步骤已用完（第 ${i + 1} 次调用）`);
      }
      next++;
      const calls = step.toolCalls ?? [];
      if (calls.length > 0) {
        const message: AssistantMessage = {
          role: "assistant",
          content: step.content ?? null,
          toolCalls: calls.map((c, j) => ({ id: `call_${i}_${j}`, name: c.name, arguments: JSON.stringify(c.arguments) })),
        };
        return { message, usage: { inputTokens: 0, outputTokens: 0 }, finishReason: "tool_calls" };
      }
      return {
        message: { role: "assistant", content: step.content ?? "" },
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: "stop",
      };
    },
  };
  return provider;
};

/** AbortSignal 不能 structuredClone：只拷贝可序列化的部分 */
function copyRequest(req: LlmRequest): LlmRequest {
  const copy: LlmRequest = { messages: structuredClone(req.messages) };
  if (req.tools !== undefined) copy.tools = structuredClone(req.tools);
  if (req.temperature !== undefined) copy.temperature = req.temperature;
  if (req.maxTokens !== undefined) copy.maxTokens = req.maxTokens;
  return copy;
}
