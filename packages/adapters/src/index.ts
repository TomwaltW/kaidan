// @kaidan/adapters —— T0 桩：导出名与类型冻结（spec 3.2），由 T1 替换为实现。
import {
  notImplemented,
  type CreateAdapter,
  type CreateMockAdapter,
  type CreateMockContextProvider,
  type CreateNullContextProvider,
} from "@kaidan/contracts";

export const createAdapter: CreateAdapter = async () => notImplemented("@kaidan/adapters.createAdapter");

export const createMockAdapter: CreateMockAdapter = () => notImplemented("@kaidan/adapters.createMockAdapter");

export const createMockContextProvider: CreateMockContextProvider = () =>
  notImplemented("@kaidan/adapters.createMockContextProvider");

export const createNullContextProvider: CreateNullContextProvider = () =>
  notImplemented("@kaidan/adapters.createNullContextProvider");
