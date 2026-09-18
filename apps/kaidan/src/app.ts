// @kaidan/app —— 组装（spec 附录 F）：只调用各包工厂，不含业务逻辑。T0 编写，TΩ 仅修集成缝隙。
import { createAdapter, createMockContextProvider, createNullContextProvider } from "@kaidan/adapters";
import { createAgentRuntime, createOpenAICompatibleProvider, loadSkills } from "@kaidan/agent";
import {
  ErrorCode,
  KaidanError,
  type AppOverrides,
  type BuildApp,
  type ContextProvider,
  type KaidanConfig,
  type LlmProvider,
  type MockRomAdapter,
  type RomAdapter,
} from "@kaidan/contracts";
import { createGovernance } from "@kaidan/governance";
import { SKILLS_DIR } from "@kaidan/skills";
import { createConfigIdentityResolver, createFeishuSurface } from "@kaidan/surface-feishu";
import { createToolRegistry } from "@kaidan/tools";

export const buildApp: BuildApp = async (config, overrides = {}) => {
  const clock = overrides.clock;

  // 1. 适配器：overrides.dataset 优先；否则由 createAdapter 按 config 读取数据集（mock）或 mapping（bitable）
  const adapter = await createAdapter(config, overrides.dataset ? { dataset: overrides.dataset } : undefined);

  // 2. 日程来源：mock 用同一数据集；bitable 在 MVP 阶段恒为空
  const context = createContext(adapter, overrides);

  // 3. 治理（提案 / 审批 / 审计），clock 透传
  const governance = createGovernance({
    adapter,
    dbPath: config.governance.dbPath,
    proposalTtlMinutes: config.governance.proposalTtlMinutes,
    clock,
  });

  try {
    // 4. 工具
    const tools = createToolRegistry({
      adapter,
      proposals: governance.proposals,
      audit: governance.audit,
      context,
      risk: config.risk,
      timezone: config.timezone,
      proposalTtlMinutes: config.governance.proposalTtlMinutes,
      clock,
    });

    // 5. 模型：overrides.provider 优先
    const provider = overrides.provider ?? createProvider(config.llm);

    // 6. 技能
    const skills = await loadSkills(config.skillsDir ?? SKILLS_DIR);

    // 7. Agent
    const agent = createAgentRuntime({
      provider,
      tools,
      audit: governance.audit,
      proposals: governance.proposals,
      skills,
      timezone: config.timezone,
      clock,
    });

    // 8. 身份
    const identity = createConfigIdentityResolver(config);

    // 9. 飞书入口：client 透传；这里不启动，只有 surface.start() 才连飞书
    const surface = createFeishuSurface({ agent, governance, identity, config, client: overrides.larkClient });

    let closed = false;
    return {
      config,
      adapter,
      context,
      governance,
      tools,
      agent,
      identity,
      surface,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await surface.stop();
        } finally {
          await governance.close();
        }
      },
    };
  } catch (e) {
    // 组装中途失败：释放已打开的数据库，再把原错误抛出
    await governance.close().catch(() => undefined);
    throw e;
  }
};

function createContext(adapter: RomAdapter, overrides: AppOverrides): ContextProvider {
  if (adapter.kind === "bitable") return createNullContextProvider();
  if (overrides.dataset) return createMockContextProvider(overrides.dataset);
  if (!isMockAdapter(adapter)) {
    throw new KaidanError(ErrorCode.CONFIG, "adapter.kind=mock 但适配器没有 snapshot()，无法为日程提供同一数据集");
  }
  return createMockContextProvider(adapter.snapshot());
}

function isMockAdapter(a: RomAdapter): a is MockRomAdapter {
  return a.kind === "mock" && typeof (a as Partial<MockRomAdapter>).snapshot === "function";
}

function createProvider(llm: KaidanConfig["llm"]): LlmProvider {
  if (llm.kind === "openai_compatible") return createOpenAICompatibleProvider(llm);
  throw new KaidanError(
    ErrorCode.CONFIG,
    "llm.kind=scripted 时必须通过 AppOverrides.provider 注入脚本 provider（CLI 用 chat --script <steps.json>）",
  );
}
