# eve-cls-observability

[![npm version](https://img.shields.io/npm/v/eve-cls-observability.svg)](https://www.npmjs.com/package/eve-cls-observability)
[![license](https://img.shields.io/npm/l/eve-cls-observability.svg)](./LICENSE)

给 [eve](https://github.com/vercel/eve) agent 应用接入**腾讯云 CLS Agent 可观测**的插件。

两行代码接入，业务代码零改动：会话、轮次、模型调用、工具调用的完整调用链自动出现在 CLS 控制台的 Agent 可观测应用里。

```ts
// agent/instrumentation/cls.ts
import { clsObservability } from "eve-cls-observability";
export default clsObservability(); // 配置走环境变量，开箱即用
```

## 目录

- [它能给你什么](#它能给你什么)
- [快速开始（5 分钟）](#快速开始5-分钟)
- [工作原理](#工作原理)
- [完整配置项](#完整配置项)
- [客户可以自定义什么](#客户可以自定义什么)
- [内容采集与隐私](#内容采集与隐私)
- [部署：物理机 / 虚拟机 / 容器 / K8s](#部署物理机--虚拟机--容器--k8s)
- [对你的应用有多大影响](#对你的应用有多大影响)
- [兼容性](#兼容性)
- [排障](#排障)
- [许可证](#许可证)

## 它能给你什么

接入后在 CLS 控制台即可获得：

| 能力 | 说明 |
|---|---|
| 完整调用链 | 一次用户请求从入口到每次模型调用、工具调用的五层 span 树（entry → agent → step → chat / tool） |
| 多轮会话聚合 | 同一会话的多轮对话聚合为一个 Session，按 `session.id` 检索 |
| Token 与成本 | 每次模型调用的输入/输出 token 数，agent 级自动汇总 |
| 失败可定位 | 模型/工具调用失败带 `error.*` 分类字段，step 级 `finish_reason` |
| 工具调用详情 | 工具名、入参、返回结果、耗时，子 agent 派发自动嵌套为 `invoke_subagent` 子树 |
| 思考过程 | step 级 `react.thought` / `react.observation`（推理与工具观察回填） |
| 正文可选 | 输入/输出消息正文默认关闭，按需开启，支持字段级脱敏 |

**设计上的几个取舍**：

- **不侵入业务代码**：span 数据来自 eve 框架自身的生命周期事件，插件只做"翻译"，你不需要在任何业务逻辑里埋点。
- **传输零依赖**：内置 CLS UploadLog 客户端（protobuf 编码 + TC3-HMAC-SHA256 签名，只用 `node:crypto` + `fetch`），不引入腾讯云 SDK 等重型依赖，方便依赖审计。
- **不给应用添新故障点**：导出失败只告警重试，绝不向你的 agent 运行抛出异常（详见[对你的应用有多大影响](#对你的应用有多大影响)）。

## 快速开始（5 分钟）

### 第 1 步：安装

```bash
npm install eve-cls-observability
# 或 pnpm add eve-cls-observability / yarn add eve-cls-observability
```

要求 Node.js >= 24，eve >= 0.56（eve 是本插件的 peer dependency，你的项目应该已经装了）。

### 第 2 步：在 CLS 控制台创建 Agent 可观测应用

1. 登录[腾讯云 CLS 控制台](https://console.cloud.tencent.com/cls)，进入「Agent 可观测」
2. 创建一个 Agent 应用，系统会自动生成对应的日志主题（**日志主题不用手工建**）
3. 复制**日志主题 ID**（UUID 格式，形如 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`）

> **最容易踩的坑**：配置里要填的是**日志主题 ID（topic ID）**，不是应用 ID。填错是"控制台看不到数据"的头号原因。

### 第 3 步：配置环境变量

在 agent 项目的 `.env.local`（或部署环境的环境变量）中配置 4 个变量：

```bash
CLS_TOPIC_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx   # 第 2 步拿到的日志主题 ID
CLS_REGION=ap-shanghai                               # 主题所在地域
CLS_SECRET_ID=AKIDxxxxxxxxxxxxxxxx                   # 腾讯云访问密钥
CLS_SECRET_KEY=xxxxxxxxxxxxxxxx                      # 腾讯云访问密钥
```

> **密钥最小权限建议**：建议创建 CAM 子账号密钥，只授予 `cls:PushLog`（或对应日志主题的写日志权限），不要给主账号全权限密钥。使用 STS 临时密钥时可额外配置 `CLS_TOKEN`。

### 第 4 步：加两行代码

第一处，`agent/agent.ts` 开启 instrumentation provider 布局（provider 事件仅在此布局下分发）：

```ts
export default defineAgent({
  model: /* ...你原有的配置... */,
  experimental: { instrumentationProviders: true },  // 只加这一行
});
```

第二处，新建 `agent/instrumentation/cls.ts`：

```ts
import { clsObservability } from "eve-cls-observability";
export default clsObservability();
```

### 第 5 步：验证

正常触发一次 agent 对话，然后：

1. 等约 2~5 秒（批量导出默认 2 秒一批）
2. 到 CLS 控制台你的 Agent 可观测应用里查看：应该能看到一个新的 Session，点进去是完整的调用链时间线

如果看不到数据，先开诊断日志再跑一遍：

```bash
CLS_OBS_DEBUG=1 npm run dev
```

然后对照[排障](#排障)章节逐项检查。

> 进程退出时的缓冲排空由 eve 框架的 provider `flush`/`shutdown` 生命周期自动完成，**不需要你手动调用任何清理函数**。

## 工作原理

### 数据流

```
你的 agent 业务代码（零改动）
  → eve 框架生命周期事件（session / turn / step / model.call / tool.call 等 18 类）
  → 本插件：span 状态机按 CLS Agent Trace 规范组装五层 span 树
  → 独立 TracerProvider（不注册全局，对你的应用零干扰）
  → BatchSpanProcessor（后台批量导出，默认 2 秒一批）
  → CLS UploadLog API（protobuf + TC3-HMAC-SHA256 签名，HTTPS）
  → CLS Agent 可观测应用（控制台可视化）
```

### 事件到 CLS 的映射

**为什么不需要你埋点**：eve 框架在运行 agent 时本身就会派发 `turn.started`、`model.call.completed`、`tool.call.failed` 等生命周期事件。插件通过 eve 公开的 `defineInstrumentation` API 订阅这些事件，把它们"翻译"成 CLS Agent Trace 规范的 span：

| eve 框架事件 | CLS span 类型 | span 名称 | 关键字段 |
|---|---|---|---|
| session 开始/结束 | `entry`（应用入口） | `enter_application` | `session.id`、`turn.id`、轮级输入/输出消息 |
| turn 开始/结束 | `agent` | `invoke_agent {name}` | agent 名称、usage 汇总、消息数、工具调用数 |
| step 尝试开始/结束 | `step`（ReAct 轮次） | `react round_{N}` | `step.id`、轮次号、`finish_reason` |
| model.call 开始/结束 | `chat`（模型调用） | `chat {model}` | 模型名、输入/输出消息、token usage、耗时 |
| tool.call 开始/结束 | `tool`（工具调用） | `execute_tool {name}` | 工具名、入参、结果、耗时、错误分类 |
| 子 agent 派发 | `tool` + 子树 | `invoke_subagent` | 子 agent 的完整调用链嵌套在派发它的 tool span 下 |

span 之间通过 ID 链关联：`turn.id = {sessionId}:t{N}`、`step.id = {turnId}:s{N}`，控制台上因此能还原出完整的树状时间线。属性命名遵循 `gen_ai.*` 协议命名空间（OpenTelemetry GenAI 语义约定），eve 框架的扩展信息放在 `agent.eve.*` 下（如 `agent.eve.turn.sequence`、`agent.eve.channel.type`）。

## 完整配置项

以下所有选项都是**本插件自己的参数**，通过 `clsObservability({...})` 传参，**代码传参优先级高于环境变量**。除连接配置外，其余均有安全的生产默认值，一般只需要配置第 3 步的 4 个环境变量。

### 连接配置（必填，缺失时启动即报错）

| 选项 | 环境变量 | 说明 |
|---|---|---|
| `topicId` | `CLS_TOPIC_ID` | CLS trace 日志主题 ID（UUID 格式，启动校验） |
| `region` | `CLS_REGION` | 主题所属地域，如 `ap-shanghai` |
| `secretId` / `secretKey` | `CLS_SECRET_ID` / `CLS_SECRET_KEY` | 腾讯云密钥（建议最小权限子账号） |
| `token` | `CLS_TOKEN` | 可选，STS 临时密钥的 session token |
| `apiHost` | `CLS_API_HOST` | API 域名覆盖，默认 `cls.{region}.tencentcloudapi.com`；自定义域名需同时设 `allowCustomEndpoint: true`（SSRF 防护，见下） |

### 服务标识（在 CLS 控制台区分你的应用）

| 选项 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `serviceName` | `CLS_SERVICE_NAME` | = `agentType` | `service.name`，**建议设为你的应用名**，如 `"customer-service-bot"` |
| `agentType` | — | `"eve"` | `gen_ai.agent.type` |
| `serviceVersion` | — | — | 应用版本号，写入 resource |
| `environment` | — | — | 部署环境标识，如 `"production"` / `"staging"` |

### 内容采集与隐私（详见下一章）

| 选项 | 默认 | 说明 |
|---|---|---|
| `recordInputs` / `recordOutputs` | `false` | 是否采集输入/输出消息正文 |
| `recordReasoning` | `false` | 是否采集模型推理过程 |
| `recordSessionTitle` | `false` | 是否采集会话标题 |
| `recordUserId` | `false` | 是否采集用户 ID |
| `hashUserId` | `true` | 用户 ID 默认 SHA-256 哈希后上报 |
| `redact(key, value)` | — | 字段级脱敏函数，见[自定义脱敏](#自定义脱敏) |
| `maxContentLength` | `32768` | 单属性 UTF-8 字节上限（1 KiB–1 MiB），截断后始终保持合法 JSON |

### 行为与资源上界

| 选项 | 默认 | 说明 |
|---|---|---|
| `scheduledDelayMillis` | `2000` | 批量导出间隔；普通对话轮不等待网络 |
| `requestTimeoutMs` | `10000` | 单次上报请求超时（100–60000 ms） |
| `maxRetries` | `2` | 失败后的指数退避重试次数（0–10） |
| `maxBatchBytes` | `4.5 MiB` | 单个上报请求的字节上限（CLS 硬限制 5 MiB，超出自动分包） |
| `maxTrackedSessions` | `1000` | 内存中跟踪的会话状态上限（LRU 淘汰） |
| `stateTtlMs` | `30 min` | 空闲会话状态的过期时间 |
| `messageDelta` | `true` | 会话消息增量上报（首次全量 + md5 校验，前缀扩展后只发增量，断裂自动回落全量）；设为 `false` 则每次全量 |
| `debug` | `false` | 诊断日志（也可用 `CLS_OBS_DEBUG=1`） |

## 客户可以自定义什么

### 自定义脱敏

开启内容采集后，任何字段在发送前都会经过 `redact` 函数（在内置开关之后执行）：

```ts
export default clsObservability({
  recordInputs: true,
  recordOutputs: true,
  redact: (key, value) => {
    // 删除整个字段：返回 undefined
    if (key.includes("phone")) return undefined;
    // 改写字段值
    if (typeof value === "string") return value.replace(/\d{11}/g, "***");
    return value;
  },
});
```

`redact` 抛出异常时按 **fail-closed** 处理（该字段被丢弃而不是原样发出），避免脱敏逻辑出错反而泄露数据。

### OTLP 镜像双写

把 span 以 OTLP 协议额外写一份到其他 CLS 主题（例如备份留存、多主题分发）：

```ts
export default clsObservability({
  otlpMirrors: [{
    topicId: "yyyyyyyy-yyyy-yyyy-yyyy-yyyyyyyyyyyy",
    region: "ap-shanghai",
    headers: { "x-custom-auth": "..." }, // 镜像使用独立鉴权，绝不复用主 CLS 密钥
  }],
});
```

自定义（非腾讯云官方）endpoint 必须显式 `allowCustomEndpoint: true` 且使用 HTTPS——这是 SSRF 防护设计，防止配置错误把 trace 数据发往意外目的地。

### 服务标识与环境区分

多套环境共用一个主题时，用 `serviceName` + `environment` 区分：

```ts
export default clsObservability({
  serviceName: "customer-service-bot",
  serviceVersion: "1.4.2",
  environment: "production",
});
```

之后可在 CLS 检索中按 `resource.service.name`、`resource.deployment.environment` 过滤。

## 内容采集与隐私

**默认行为：不采集任何消息正文**——不上报输入、输出、推理过程、会话标题、用户 ID，只上报结构化字段（span 名称、耗时、token 数、错误分类等），调用链功能完全不受影响。想看正文，按下面两步操作：

### 第一步：打开插件的采集开关

这些开关都是本插件的参数，在 `agent/instrumentation/cls.ts` 里设置：

```ts
export default clsObservability({
  recordInputs: true,        // 采集输入消息正文
  recordOutputs: true,       // 采集输出消息正文
  // recordReasoning: true,      // 可选：模型推理过程
  // recordSessionTitle: true,   // 可选：会话标题
  // recordUserId: true,         // 可选：用户 ID（默认 SHA-256 哈希后上报）
});
```

### 第二步：确认你的环境放行正文

打开插件开关后如果还看不到正文，是被 eve 框架自带的隐私闸拦住了：**非 development 环境下，只有 audience 为 `"public"` 的会话才放行正文**（eve 的隐私设计，插件无法也不应绕过）。按你的部署环境对号入座：

| 你的环境 | 要做的操作 |
|---|---|
| 本地开发（`eve dev`） | **无需操作**——`eve dev` 自动按 development 环境放行 |
| Vercel preview / development | **无需操作**——非 production 自动放行 |
| 自托管生产（物理机 / 虚机 / 容器 / K8s） | 在 `agent/channels/` 的会话配置中把 `audience` 设为 `"public"` |
| Vercel production | 同上：会话 `audience` 设为 `"public"` |

> **生产环境放开正文前，请先评估隐私合规与日志成本**：正文是日志写流量的主要来源。建议先只开 `recordOutputs`（模型输出通常比全量输入上下文小得多），并配合 [`redact`](#自定义脱敏) 做字段级脱敏（如手机号、身份证号打码）。

## 部署：物理机 / 虚拟机 / 容器 / K8s

### 集成模型（先说清一件事）

本插件**不是独立服务**，它是编译进你的 eve 应用里的一个库。所谓"集成到某种环境"，本质只有三件事：

1. 应用装了 `eve-cls-observability`（`npm install`，随 `eve build` 一起打进产物）
2. 进程启动时能拿到 4 个 `CLS_*` 环境变量
3. 进程能出网访问 `cls.{region}.tencentcloudapi.com:443`（HTTPS）

eve 应用的生产形态：`eve build` 产出标准 Nitro server（`.output/` 目录），`eve start` 以**长驻 Node 进程**运行（Node.js >= 24）。以下各环境只是这三件事的不同落地方式。

**所有环境共通的原则**：

- **密钥不进代码、不进镜像**：运行时注入环境变量，优先级为代码传参 > 环境变量
- **启动即校验**：必填配置缺失、格式错误会在 `clsObservability()` 调用时直接抛错——宁可启动时明确失败，也不要上线后才发现一直没数据
- **退出无需手写清理**：进程退出时 eve 框架自动调用插件的 `flush`/`shutdown` 生命周期排空缓冲
- **内存有界**：`maxTrackedSessions`（默认 1000，LRU 淘汰）+ `stateTtlMs`（默认 30 分钟）双重约束，长跑服务不会因状态累积涨内存

### 物理机 / 虚拟机（systemd）

```bash
# 1. 安装 Node.js >= 24，拉代码，装依赖，构建
npm ci
npx eve build

# 2. 写环境文件（独立文件、权限 600，不要写进 unit 文件本体）
sudo install -m 600 /dev/null /etc/myagent/env
sudo tee /etc/myagent/env <<'EOF'
CLS_TOPIC_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
CLS_REGION=ap-shanghai
CLS_SECRET_ID=AKIDxxxxxxxxxxxxxxxx
CLS_SECRET_KEY=xxxxxxxxxxxxxxxx
EOF
```

`/etc/systemd/system/myagent.service`：

```ini
[Unit]
Description=My eve agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/myagent/env
WorkingDirectory=/opt/myagent
ExecStart=/usr/bin/npx eve start --host 0.0.0.0 --port 3000
Restart=always
RestartSec=3
# eve 收到 SIGTERM 后内部需要最多约 20 秒优雅退出（含插件缓冲排空），systemd 默认 90 秒足够；
# 如果你全局收紧过 TimeoutStopSec，这里不要低于 30
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now myagent
journalctl -u myagent -f   # 开了 CLS_OBS_DEBUG=1 时，插件诊断日志在这里看
```

> 如果前面挂了 Nginx 反向代理，必须同时转发 `/eve/` 和 `/.well-known/workflow/` 两个前缀（eve workflow 回调的要求），漏配会让 agent run 卡住——这与本插件无关，但自托管时经常一起踩到。

### Docker 容器

多阶段 Dockerfile——**构建期不需要任何密钥，密钥只在 `docker run` 时注入**：

```dockerfile
# ---------- 构建 ----------
FROM node:24-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx eve build          # 产物在 .output/

# ---------- 运行 ----------
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev      # eve start 需要 CLI
COPY --from=build /app/.output ./.output
EXPOSE 3000
STOPSIGNAL SIGTERM
CMD ["npx", "eve", "start", "--host", "0.0.0.0", "--port", "3000"]
```

```bash
docker build -t myagent:1.0.0 .
docker run -d --name myagent \
  -p 3000:3000 \
  -e CLS_TOPIC_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx \
  -e CLS_REGION=ap-shanghai \
  -e CLS_SECRET_ID=AKIDxxxxxxxxxxxxxxxx \
  -e CLS_SECRET_KEY=xxxxxxxxxxxxxxxx \
  --stop-timeout 30 \
  myagent:1.0.0
```

要点：

- **密钥绝不进镜像层**：不要 `ENV CLS_SECRET_KEY=...`，也不要把 `.env.local` COPY 进镜像（确认 `.dockerignore` 覆盖了 `.env*`）；用 `-e`、权限受控的 `--env-file` 或编排平台的 Secret 注入
- **停止宽限**：`docker stop` 默认 10 秒，可能截断退出时的缓冲排空，建议 `--stop-timeout 30`
- 镜像基于 `node:24-slim` 即可，插件无原生扩展、无额外系统依赖

### Kubernetes / TKE

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: myagent-cls
type: Opaque
stringData:
  CLS_TOPIC_ID: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  CLS_REGION: ap-shanghai
  CLS_SECRET_ID: AKIDxxxxxxxxxxxxxxxx
  CLS_SECRET_KEY: xxxxxxxxxxxxxxxx
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: myagent
spec:
  replicas: 2
  selector:
    matchLabels: { app: myagent }
  template:
    metadata:
      labels: { app: myagent }
    spec:
      terminationGracePeriodSeconds: 30   # 覆盖 eve 优雅退出 + 插件缓冲排空
      containers:
        - name: myagent
          image: registry.example.com/myagent:1.0.0
          ports: [{ containerPort: 3000 }]
          envFrom:
            - secretRef: { name: myagent-cls }
          env:
            - name: CLS_SERVICE_NAME      # 可选：在 CLS 侧区分应用
              value: customer-service-bot
          readinessProbe:
            httpGet: { path: /, port: 3000 }
```

**多副本无需特殊处理**：span 状态在进程内维护（LRU + TTL 上限），同一会话被路由到不同副本时会自然开始新的 span 上下文，不影响 CLS 侧按 `session.id` 检索聚合，**不需要 sticky session**。

### Vercel（Serverless）

`eve deploy` 部署到 Vercel 时：

- 4 个 `CLS_*` 变量配在 Vercel 项目的 Environment Variables（Production / Preview 分开配置）
- Serverless 没有可靠的"进程退出"时机，但 eve 会在**每个 turn / 会话结束时自动调用插件 flush**，数据不会因实例冻结而滞留——这是框架托管生命周期的价值，你无需任何额外代码
- 内容采集的环境判定按 `VERCEL_ENV` 进行：`production` 环境下只有 public audience 会话放行正文（见[内容采集与隐私](#内容采集与隐私)）

### 网络与出网要求

| 项 | 值 |
|---|---|
| 目的地址 | `cls.{region}.tencentcloudapi.com`（可用 `apiHost` 覆盖） |
| 端口 / 协议 | 443 / HTTPS（TC3 签名在应用层完成，传输本身也是 TLS） |
| 方向 | **仅出向（egress）**，不需要任何入向端口、公网 IP 或安全组放行 |
| 腾讯云 VPC 内 | 该域名可经 PrivateDNS 解析到内网接入点，无需改配置、免公网流量费 |
| 专有云 / 自建接入点 | 用 `apiHost` + `allowCustomEndpoint: true`（先过 SSRF 评审，见配置章节） |

**关于 STS 临时密钥**：插件在 `clsObservability()` 调用时（进程启动）读取一次 `CLS_TOKEN`，长驻进程不会自动刷新。使用 STS 的场景请配合滚动重启/重新部署刷新凭据；长驻物理机 / 虚拟机 / 容器更推荐 CAM 子账号长期密钥（最小权限 `cls:PushLog`）。

## 对你的应用有多大影响

| 维度 | 设计与结论 |
|---|---|
| 请求路径延迟 | span 组装在事件回调中同步完成（微秒级字符串/对象操作）；网络上报全部在 `BatchSpanProcessor` 后台进行，普通对话轮**不等待任何网络请求** |
| 依赖体积 | 运行时仅 5 个 `@opentelemetry/*` 包；CLS 上传客户端为零依赖自实现（`node:crypto` + `fetch`） |
| 全局污染 | 使用独立 `TracerProvider`，**不注册为全局 provider**，不会劫持你应用里已有的 OpenTelemetry 链路 |
| 异常隔离 | 上报失败（网络/签名/限流）只 `console.warn` + 指数退避重试，**绝不向 agent 运行抛异常**；`redact` 异常 fail-closed |
| 进程退出 | 通过 eve provider 的 `flush`/`shutdown` 生命周期自动排空缓冲，不丢尾部数据 |

## 兼容性

- **Node.js**：>= 24（与 eve 框架的运行时要求一致）
- **eve**：>= 0.56.0 < 0.57.0（peer dependency；eve 的 instrumentation API 尚处 experimental，跨 minor 版本可能有变动，故锁定小版本区间）
- **与其他 instrumentation provider 共存**：`agent/instrumentation/` 目录可放多个 provider 文件，事件分发互不影响
- **与既有 OpenTelemetry 体系共存**：本插件用独立 provider 写 CLS；如需同时写你自己的 OTel Collector，用 [OTLP 镜像](#otlp-镜像双写)或在 eve 中再注册一个标准 OTel provider

## 排障

### 控制台完全看不到数据

按顺序排查（按命中概率排序）：

1. **topic ID 填错了**：确认 `CLS_TOPIC_ID` 是日志主题 ID（UUID 格式）而不是 Agent 应用 ID——这是头号原因
2. **地域不匹配**：`CLS_REGION` 必须与主题实际所属地域一致
3. **密钥权限不足**：密钥需要目标主题的写日志权限（`cls:PushLog`）；用 `CLS_OBS_DEBUG=1` 看是否有签名/权限报错
4. **出网不通**：在容器/虚机里 `curl -v https://cls.{region}.tencentcloudapi.com` 确认 443 可达（公司内网、出口防火墙、K8s NetworkPolicy 是常见拦截点）
5. **没开 provider 布局**：确认 `agent/agent.ts` 里有 `experimental: { instrumentationProviders: true }`
6. **多等几秒**：批量导出默认 2 秒一批，控制台索引也有秒级延迟

### 调用链有，但看不到输入/输出消息正文

正文默认关闭，且生产环境还有 eve 框架的隐私闸，按[内容采集与隐私](#内容采集与隐私)的两步逐项检查：

1. 插件开关：`recordInputs: true` / `recordOutputs: true` 是否已在 `clsObservability({...})` 中设置
2. 环境放行：本地开发用 `eve dev` 启动；生产环境确认会话 audience 已设为 `"public"`
3. 是否设置了 `redact` 把字段删掉了（`CLS_OBS_DEBUG=1` 可辅助确认）

### 启动时报 `missing required configuration`

4 个必填项（`topicId`/`region`/`secretId`/`secretKey`）有缺失或为空字符串。注意：如果你用 `.env` 文件，确认加载工具（如 dotenv）真的把变量写进了 `process.env`——某些配置库只读文件不注入环境。

### 启动时报 `custom apiHost requires allowCustomEndpoint`

你覆盖了 `apiHost` 或 OTLP endpoint 且不是腾讯云官方域名。这是 SSRF 防护：确认目标地址可信后显式加 `allowCustomEndpoint: true`。指向私网/本地地址（`127.*`、`10.*`、`192.168.*` 等）会被直接拒绝且无法放开。

### 调用链重复或断裂

- **重复**：检查是否注册了多个相同的 instrumentation 文件
- **子 agent 断链**：跨 runtime generation 派生的子 agent 会降级为独立 trace 并标记 `agent.eve.subagent.orphan`，这是预期行为，可用该字段检索确认

### 已知限制

受 eve 框架公开 API 覆盖面所限，以下 CLS 规范字段暂不上报：`response.model`、`reasoning_output_tokens`、`time_to_first_token_ms`、`tool.definitions`、模型请求参数（temperature 等）、`user.name`。eve 后续版本开放相应事件后会补齐。

## 许可证

[MIT](./LICENSE)
