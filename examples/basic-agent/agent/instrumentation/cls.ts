import { clsObservability } from "eve-cls-observability";

// 默认配置全部来自环境变量：
//   CLS_TOPIC_ID / CLS_REGION / CLS_SECRET_ID / CLS_SECRET_KEY（可选 CLS_TOKEN）
export default clsObservability();

// 需要自定义时传入选项，例如：
//
// export default clsObservability({
//   serviceName: "my-agent",          // 在 CLS 控制台区分你的应用
//   environment: "production",
//   recordInputs: true,               // 采集输入正文（注意隐私与流量成本）
//   recordOutputs: true,              // 采集输出正文
//   redact: (key, value) =>
//     typeof value === "string" ? value.replace(/\d{11}/g, "***") : value,
// });
