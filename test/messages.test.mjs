import assert from "node:assert/strict";
import test from "node:test";
import {
  clsInputMessages,
  lastUserMessage,
  systemInstructionsText,
} from "../dist/messages.js";

test("system instructions support arrays and text parts", () => {
  assert.equal(
    systemInstructionsText([
      { role: "system", content: "first" },
      { role: "system", content: [{ type: "text", text: "second" }] },
    ]),
    "first\nsecond",
  );
});

test("input messages preserve eve kind and select the real user message", () => {
  const input = [
    { role: "user", kind: "user", content: "actual question" },
    { role: "user", kind: "context.state", content: "framework context" },
  ];
  const converted = clsInputMessages(input);
  assert.equal(converted[0].kind, "user");
  assert.equal(converted[1].kind, "context.state");
  assert.equal(lastUserMessage(input)[0].parts[0].content, "actual question");
});
