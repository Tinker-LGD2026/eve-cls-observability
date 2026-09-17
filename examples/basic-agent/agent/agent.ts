import { defineAgent } from "eve";

// 示意文件：不要整体替换你的 agent.ts，
// 只需把 experimental 这一段合并进你已有的 defineAgent 配置。
export default defineAgent({
  // ...你原有的 model / instructions / tools 等配置保持不变...
  experimental: {
    // provider 事件仅在此布局下分发，必须开启，否则插件收不到任何事件
    instrumentationProviders: true,
  },
});
