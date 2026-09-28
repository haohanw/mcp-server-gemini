import test from "node:test";
import assert from "node:assert/strict";
import { EnhancedStdioMCPServer } from "../dist/enhanced-stdio-server.js";
function fixture() {
  const calls = [];
  const models = {
    generateContent: async (req) => {
      calls.push(req);
      return {
        text: '{"ok":true}',
        modelVersion: req.model,
        candidates: [
          {
            finishReason: "STOP",
            content: {
              role: "model",
              parts: [{ text: '{"ok":true}', thoughtSignature: "signature" }],
            },
            groundingMetadata: { webSearchQueries: ["query"] },
            urlContextMetadata: { urlMetadata: [] },
          },
        ],
      };
    },
    list: async () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          name: "models/future-model",
          supportedActions: ["generateContent"],
        };
        yield { name: "models/gemini-3.8-flash", inputTokenLimit: 1048576 };
      },
    }),
    countTokens: async (req) => ({ totalTokens: 4 }),
    embedContent: async (req) => {
      calls.push(req);
      return { embeddings: [{ values: [0.1, 0.2] }] };
    },
  };
  return {
    server: new EnhancedStdioMCPServer("test", { models }, false),
    calls,
    models,
  };
}
const call = (server, name, args) =>
  server.handleToolCall({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
test("new model IDs and all generation controls reach SDK config; provenance survives", async () => {
  const { server, calls } = fixture();
  const r = await call(server, "generate_text", {
    model: "future-model",
    prompt: "hi",
    temperature: 0,
    topK: 0,
    topP: 0,
    maxTokens: 12,
    systemInstruction: "system",
    jsonSchema: { type: "object" },
    thinkingLevel: "low",
    grounding: true,
    urlContext: true,
  });
  assert.equal(r.result.isError, undefined);
  const req = calls[0];
  assert.equal(req.model, "future-model");
  assert.equal(req.config.temperature, 0);
  assert.equal(req.config.topK, 0);
  assert.equal(req.config.topP, 0);
  assert.equal(req.config.maxOutputTokens, 12);
  assert.equal(req.config.systemInstruction, "system");
  assert.deepEqual(req.config.responseJsonSchema, { type: "object" });
  assert.equal(req.config.responseMimeType, "application/json");
  assert.equal(req.config.thinkingConfig.thinkingLevel, "low");
  assert.deepEqual(req.config.tools, [
    { googleSearch: {} },
    { urlContext: {} },
  ]);
  assert.deepEqual(
    r.result.structuredContent.metadata.groundingMetadata.webSearchQueries,
    ["query"],
  );
});
test("conversation history grows linearly and preserves model signatures", async () => {
  const { server, calls } = fixture();
  for (const prompt of ["one", "two", "three"])
    await call(server, "generate_text", { prompt, conversationId: "test" });
  assert.deepEqual(
    calls.map((c) => c.contents.length),
    [1, 3, 5],
  );
  assert.equal(calls[2].contents[1].parts[0].thoughtSignature, "signature");
});
test("live model catalog preserves unknown models and does not fabricate capabilities", async () => {
  const { server } = fixture();
  const r = await call(server, "list_models", {});
  assert.equal(
    r.result.structuredContent.models[0].name,
    "models/future-model",
  );
  assert.equal(
    r.result.structuredContent.models[0].documentedCapabilities,
    null,
  );
  const v = await call(server, "list_models", { filter: "vision" });
  assert.equal(v.result.structuredContent.models.length, 1);
  assert.match(
    v.result.structuredContent.models[0].capabilitySource,
    /google.dev/,
  );
});
test("images require actual bytes; URL does not become pretend vision", async () => {
  const { server, calls } = fixture();
  const bad = await call(server, "analyze_image", {
    prompt: "what",
    imageUrl: "https://example.com/image.png",
  });
  assert.equal(bad.result.isError, true);
  assert.equal(calls.length, 0);
  const good = await call(server, "analyze_image", {
    prompt: "what",
    imageBase64: "data:image/png;base64,aGk=",
  });
  assert.equal(good.result.isError, undefined);
  assert.deepEqual(calls[0].contents[0].parts[0], {
    inlineData: { mimeType: "image/png", data: "aGk=" },
  });
});
test("multimodal inputs are actual parts; invalid and oversized data fail locally", async () => {
  const { server, calls } = fixture();
  await call(server, "generate_text", {
    prompt: "summarize",
    media: [
      { mimeType: "application/pdf", data: "aGk=" },
      { mimeType: "audio/wav", data: "aGk=" },
    ],
  });
  assert.equal(calls[0].contents[0].parts.length, 3);
  for (const media of [
    [{ mimeType: "text/html", data: "aGk=" }],
    [{ mimeType: "image/png", data: "bad!" }],
    [
      {
        mimeType: "image/png",
        data: Buffer.alloc(21 * 1024 * 1024).toString("base64"),
      },
    ],
  ])
    assert.equal(
      (await call(server, "generate_text", { prompt: "hi", media })).result
        .isError,
      true,
    );
  assert.equal(calls.length, 1);
});
test("empty, truncated JSON and provider failures are not reported as complete", async () => {
  const { server, models } = fixture();
  models.generateContent = async () => ({
    text: "",
    candidates: [{ finishReason: "SAFETY" }],
  });
  assert.equal(
    (await call(server, "generate_text", { prompt: "hi" })).result.isError,
    true,
  );
  models.generateContent = async () => ({
    text: "{",
    candidates: [{ finishReason: "STOP" }],
  });
  assert.equal(
    (await call(server, "generate_text", { prompt: "hi", jsonMode: true }))
      .result.isError,
    true,
  );
  models.generateContent = async () => ({
    text: "{",
    candidates: [{ finishReason: "MAX_TOKENS" }],
  });
  const partial = await call(server, "generate_text", {
    prompt: "hi",
    jsonMode: true,
  });
  assert.equal(
    partial.result.structuredContent.metadata.finishReason,
    "MAX_TOKENS",
  );
  models.generateContent = async () => {
    throw new Error("provider unavailable");
  };
  assert.equal(
    (await call(server, "generate_text", { prompt: "hi" })).result.isError,
    true,
  );
});
test("tool schemas have no frozen model enums and carry read-only annotations", () => {
  const { server } = fixture();
  for (const t of server.getAvailableTools()) {
    assert.equal(t.annotations.readOnlyHint, true);
    if (t.inputSchema.properties.model)
      assert.equal(t.inputSchema.properties.model.enum, undefined);
  }
});
test("resource discovery uses live catalog; unknown resources error; notification has no response", async () => {
  const { server } = fixture();
  const r = await server.handleResourceRead({
    jsonrpc: "2.0",
    id: 1,
    method: "resources/read",
    params: { uri: "gemini://models" },
  });
  assert.match(r.result.contents[0].text, /future-model/);
  assert.equal(
    (await server.handleResourceRead({ id: 2, params: { uri: "missing" } }))
      .error.code,
    -32602,
  );
  let writes = 0;
  server.sendResponse = () => writes++;
  await server.handleRequest({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  assert.equal(writes, 0);
});
test("provider errors are redacted; empty embeddings are failures", async () => {
  const { server, models } = fixture();
  const previous = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "synthetic-secret";
  try {
    models.countTokens = async () => {
      throw new Error("bad synthetic-secret");
    };
    const r = await call(server, "count_tokens", { text: "hi" });
    assert.equal(r.result.isError, true);
    assert.doesNotMatch(JSON.stringify(r), /synthetic-secret/);
    models.embedContent = async () => ({ embeddings: [] });
    assert.equal(
      (await call(server, "embed_text", { text: "hi" })).result.isError,
      true,
    );
  } finally {
    if (previous === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previous;
  }
});
test("stdio entrypoint initializes and returns current tools without API calls", async () => {
  const { spawn } = await import("node:child_process");
  const p = spawn(process.execPath, ["dist/enhanced-stdio-server.js"], {
    env: { ...process.env, GEMINI_API_KEY: "test-only" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let out = "";
  p.stdout.on("data", (c) => (out += c));
  p.stderr.resume();
  const done = new Promise((resolve, reject) => {
    p.on("error", reject);
    p.on("close", resolve);
  });
  p.stdin.end(
    [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]
      .map((x) => JSON.stringify(x) + "\n")
      .join(""),
  );
  const timer = setTimeout(() => p.kill(), 5000);
  try {
    assert.equal(await done, 0);
    const rows = out
      .trim()
      .split("\n")
      .map((x) => JSON.parse(x));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].result.serverInfo.version, "4.3.0");
    assert.equal(
      rows[1].result.tools.find((t) => t.name === "generate_text").inputSchema
        .properties.model.default,
      "gemini-3.8-flash",
    );
  } finally {
    clearTimeout(timer);
    p.kill();
  }
});
