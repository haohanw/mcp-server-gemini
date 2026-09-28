// Opt-in live API checks. Uses inherited GEMINI_API_KEY; never prints credentials.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
if (!process.env.GEMINI_API_KEY)
  throw new Error("Set GEMINI_API_KEY before running live checks");
const child = spawn(process.execPath, ["dist/enhanced-stdio-server.js"], {
  stdio: ["pipe", "pipe", "pipe"],
});
child.stderr.on("data", () => {});
const pending = new Map();
let next = 0;
createInterface({ input: child.stdout }).on("line", (line) => {
  try {
    const d = JSON.parse(line);
    pending.get(d.id)?.(d);
    pending.delete(d.id);
  } catch {}
});
const send = (method, params) =>
  new Promise((resolve) => {
    const id = ++next;
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve({ error: { message: "timeout" } });
    }, 100000);
    pending.set(id, (d) => {
      clearTimeout(timer);
      resolve(d);
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
let failed = 0;
let billingBlocked = false;
async function check(name, args, verify) {
  if (billingBlocked) {
    console.log(JSON.stringify({ test: name, skipped: "billing blocked" }));
    return;
  }
  const d = await send("tools/call", { name, arguments: args });
  const data = d.result?.structuredContent;
  const error =
    d.error?.message ||
    (d.result?.isError ? d.result.content?.[0]?.text : undefined);
  if (error && /prepayment credits|\"code\":402/i.test(error))
    billingBlocked = true;
  const ok = !error && verify(d.result, data);
  if (!ok) failed++;
  console.log(
    JSON.stringify({
      test: name,
      model: args.model,
      ok,
      error: error?.replaceAll(process.env.GEMINI_API_KEY, "[REDACTED]"),
      text: data?.text?.slice(0, 350),
      finishReason: data?.metadata?.finishReason,
      groundingSources:
        data?.metadata?.groundingMetadata?.groundingChunks?.length,
      modelCount: data?.models?.length,
      embeddingModels: data?.models
        ?.filter((m) => m.supportedActions?.includes("embedContent"))
        .map((m) => m.name),
    }),
  );
}
try {
  const init = await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "live-smoke", version: "1" },
  });
  console.log(JSON.stringify({ initialize: init.result?.serverInfo }));
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  await check("list_models", {}, (_, d) =>
    d?.models?.some((m) => m.name === "models/gemini-3.8-flash"),
  );
  await check(
    "generate_text",
    {
      model: "gemini-3.8-flash",
      prompt: 'Return JSON {"ok":true,"sum":5} for 2+3.',
      jsonMode: true,
      jsonSchema: {
        type: "object",
        properties: { ok: { type: "boolean" }, sum: { type: "integer" } },
        required: ["ok", "sum"],
      },
      maxTokens: 512,
      thinkingLevel: "low",
    },
    (_, d) => {
      try {
        return (
          JSON.parse(d.text).sum === 5 && d.metadata.finishReason === "STOP"
        );
      } catch {
        return false;
      }
    },
  );
  await check(
    "generate_text",
    {
      model: "gemini-3.1-pro-preview",
      prompt:
        "Spec: drafts are saved only on explicit action. Implementation: session end automatically saves all drafts. Identify the conflict in one short sentence.",
      maxTokens: 1024,
      thinkingLevel: "low",
    },
    (_, d) => !!d?.text && d.metadata.finishReason === "STOP",
  );
  await check(
    "count_tokens",
    { model: "gemini-3.8-flash", text: "Hello Gemini" },
    (r) => r?.metadata?.tokenCount > 0,
  );
  if (process.env.GEMINI_SMOKE_GROUNDING === "1")
    await check(
      "generate_text",
      {
        model: "gemini-3.8-flash",
        prompt:
          "Use Google Search to find the official Google Gemini 3.8 Flash model documentation. State its model code and link to the official source in one sentence.",
        grounding: true,
        maxTokens: 1024,
        thinkingLevel: "low",
      },
      (_, d) =>
        !!d?.metadata?.groundingMetadata?.groundingChunks?.length &&
        d.metadata.finishReason === "STOP",
    );
  if (process.env.GEMINI_SMOKE_IMAGE) {
    const { readFileSync } = await import("node:fs");
    await check(
      "analyze_image",
      {
        model: "gemini-3.8-flash",
        prompt:
          "Describe the shapes and colors in this image in one short sentence.",
        imageBase64:
          "data:image/png;base64," +
          readFileSync(process.env.GEMINI_SMOKE_IMAGE).toString("base64"),
      },
      (_, d) => !!d?.text && d.metadata.finishReason === "STOP",
    );
  }
} finally {
  child.kill();
}
process.exitCode = failed ? 1 : 0;
