import assert from "node:assert/strict";
import test from "node:test";
import { encodeLogGroupList, tc3Authorization } from "../dist/cls-writer.js";

const entry = {
  timeMillis: 1_700_000_000_123,
  fields: {
    traceID: "a".repeat(32),
    name: "测试",
  },
};

const PAYLOAD_HEX = "0a780a4408fbd095ffbc31122b0a077472616365494412206161616161616161616161616161616161616161616161616161616161616161120e0a046e616d651206e6b58be8af951a196576652d636c732d6f62736572766162696c6974792e6c6f6722156576652d636c732d6f62736572766162696c697479";
const AUTHORIZATION = "TC3-HMAC-SHA256 Credential=AKIDEXAMPLE/2023-11-14/cls/tc3_request, SignedHeaders=content-type;host;x-cls-topicid;x-tc-action;x-tc-region;x-tc-version, Signature=b74adb6702b6e39c48a84173a4ab0991c954f8e99256f915fa31b935bd6df735";

test("CLS protobuf encoding matches the locked wire vector", () => {
  const payload = encodeLogGroupList([entry]);
  assert.equal(payload.toString("hex"), PAYLOAD_HEX);
});

test("TC3 authorization matches the locked signing vector", () => {
  const payload = Buffer.from(PAYLOAD_HEX, "hex");
  const authorization = tc3Authorization({
    secretId: "AKIDEXAMPLE",
    secretKey: "example-secret-key",
    host: "cls.ap-shanghai.tencentcloudapi.com",
    payload,
    timestampSeconds: 1_700_000_000,
    action: "UploadLog",
    region: "ap-shanghai",
    topicId: "00000000-0000-4000-8000-000000000000",
  });
  assert.equal(authorization, AUTHORIZATION);
});
