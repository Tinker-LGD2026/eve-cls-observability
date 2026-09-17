# 最小接入示例

前提：已经有一个用 `npx eve init` 创建的 eve agent 项目（eve >= 0.56）。

## 步骤

1. 在你的 agent 项目中安装插件：

   ```bash
   npm install eve-cls-observability
   ```

2. 把本目录下的两个文件合并到你的 agent 目录：

   | 本示例文件 | 合并方式 |
   |---|---|
   | `agent/agent.ts` | 只需把 `experimental: { instrumentationProviders: true }` 合并进你已有的 `defineAgent` 配置 |
   | `agent/instrumentation/cls.ts` | 新文件，直接复制 |

3. 复制 `.env.example` 为 `.env.local`，填入真实值：

   ```bash
   cp .env.example .env.local
   ```

4. 正常启动你的 agent，触发一次对话，然后到
   [CLS 控制台](https://console.cloud.tencent.com/cls)的 Agent 可观测应用中查看调用链。

看不到数据时，先 `CLS_OBS_DEBUG=1` 再跑一遍，然后对照根目录 README 的「排障」章节。
