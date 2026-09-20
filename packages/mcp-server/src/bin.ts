// @kaidan/mcp-server 的占位入口：不再自己组装依赖。
//
// 组装 ToolDeps 需要适配器与治理（@kaidan/adapters、@kaidan/governance），它们不在本包的依赖清单里，
// 而依赖清单已冻结；此前这里靠运行时动态 import("@kaidan/app") 绕过，属于隐式依赖，已收口。
// 正式入口只有一个：`pnpm -s kaidan mcp --config <配置> --as <openId>`（在仓库根目录执行）。
//
// 本包 package.json 的 `start` 脚本指向本文件且属于冻结路径，所以文件保留，只打印指引并以退出码 2 结束。
// stdio 模式下 stdout 只允许协议消息 —— 这里一个字节都不写 stdout，指引一律走 stderr。
process.stderr.write(
  [
    "[mcp] 本入口已停用：它无法组装依赖（@kaidan/app 不在本包依赖清单里）。",
    "[mcp] 请使用 pnpm -s kaidan mcp --config <配置> --as <openId>（在仓库根目录执行）。",
    "[mcp] -s 不能省：否则 pnpm 的 `> kaidan@0.0.0 …` 横幅会写进 stdout，破坏 MCP 协议。",
    "",
  ].join("\n"),
);

// 不用 process.exit()：stderr 指向管道时是异步写，直接退出可能把上面的指引丢掉。
process.exitCode = 2;
