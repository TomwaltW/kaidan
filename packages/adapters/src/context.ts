// 日程来源：Mock（读数据集 calendar）与空实现（bitable 模式在 MVP 阶段没有日历，飞书日历是 P1）。
import type { CalendarEvent, CreateMockContextProvider, CreateNullContextProvider } from "@kaidan/contracts";

export const createMockContextProvider: CreateMockContextProvider = (dataset) => {
  const events: CalendarEvent[] = structuredClone(dataset.calendar);
  return {
    async calendarToday(actor, date) {
      // 日程时间自带偏移（数据集统一写 +08:00），按其书写的本地日期匹配
      return structuredClone(
        events
          .filter((e) => e.ownerId === actor.userId && e.start.slice(0, 10) === date)
          .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || (a.id < b.id ? -1 : 1)),
      );
    },
  };
};

export const createNullContextProvider: CreateNullContextProvider = () => ({
  async calendarToday() {
    return [];
  },
});
