# Gemini MCP — maintained fork

Fork of [aliargun/mcp-server-gemini](https://github.com/aliargun/mcp-server-gemini), maintained at [haohanw/mcp-server-gemini](https://github.com/haohanw/mcp-server-gemini). MIT; original attribution retained.

This stdio server calls the Google Gemini API. It does not make Gemini a native Codex session model or give Gemini access to the client's shell or filesystem.

## Install

Requires Node.js 20+ and a Gemini API key supplied as `GEMINI_API_KEY` through your client's protected credential mechanism.

```sh
git clone https://github.com/haohanw/mcp-server-gemini.git
cd mcp-server-gemini
npm ci
npm test
```

Configure the MCP command as `node` with the absolute path to `dist/enhanced-stdio-server.js`. Never commit credentials. `GEMINI_MODEL` optionally overrides the default model. The default is **gemini-3.8-flash**; **gemini-3.1-pro-preview** is an optional preview choice for complex analysis. There is no silent model fallback.

For Codex, register the command using `codex mcp add gemini -- node /absolute/path/dist/enhanced-stdio-server.js`, and configure the credential using your existing secure local setup. See [official MCP setup](https://developers.openai.com/codex/mcp). The portable [gemini_analyst role](config/gemini_analyst.toml) can be installed under `~/.codex/agents/`; it inherits the configured Gemini MCP. Codex coordinates and must actually invoke Gemini for the analysis. Follow [current custom agent documentation](https://developers.openai.com/codex/subagents).

## Tools and boundaries

| Tool | Contract |
| --- | --- |
| `list_models` | Live API discovery, including API-supported actions and token limits. Capability annotations cover documentation-checked models only; unknown is `null`. Listing does not prove generation quota. |
| `generate_text` | Text and optional inline image/PDF/audio/video input; system instructions, JSON Schema, thinking level, Google Search grounding, URL context, and conversation history. |
| `analyze_image` | Actual base64 image bytes or an image data URI. `imageUrl` fails explicitly instead of pretending to see an image. |
| `count_tokens` | API token counting for text and the requested model. |
| `embed_text` | Embedding API; default `gemini-embedding-2`, explicit model IDs accepted. |
| `get_help` | Current server contract. |

Generation arguments: `prompt`, `model`, `systemInstruction`, `temperature`, `maxTokens`, `topK`, `topP`, `jsonMode`, `jsonSchema`, `thinkingLevel`, `grounding`, `urlContext`, `media`, `safetySettings`, `conversationId`.

`media` contains `{ "mimeType": "application/pdf", "data": "<raw base64>" }` objects. It accepts at most 8 parts and 20 MiB total decoded bytes. Supply task-relevant media only. No local file reads, file uploads, or automatic image URL downloads occur. Format/model support remains subject to API validation.

`thinkingLevel` accepts `low`, `medium`, or `high`; Gemini 3.8 Flash rejects `minimal`. Generation controls use the SDK's `config` object, including `responseJsonSchema`. Zero sampling values are preserved. Model-specific limits and unsupported combinations are enforced by Google.

Outputs include text and metadata in both MCP text content and `structuredContent`: actual model version, usage, finish reason, search grounding metadata, and URL retrieval metadata. Check `isError`, `finishReason`, JSON validity and source evidence. A requested search is not proof of search; incomplete output is not a successful completion. The caller must validate structured output for its application.

Model IDs are not frozen in tool enums. The live catalog is authoritative for availability; only the following models currently have documentation-backed feature annotations: `gemini-3.8-flash`, `gemini-3.1-pro-preview`. Unannotated models remain callable. No image/audio generation, Live API, computer control, arbitrary function execution, or file-search store management is implemented.

Embedding 2 produces a different vector space from older models: rebuild an existing index before switching its model. Explicitly pass the previous model to keep an existing index compatible.

## Validation

```sh
npm test
# Opt-in: makes real API requests using inherited GEMINI_API_KEY.
node scripts/smoke.mjs
# Optional search and image checks (may consume provider quota):
GEMINI_SMOKE_GROUNDING=1 GEMINI_SMOKE_IMAGE=/path/to/fixture.png node scripts/smoke.mjs
```

The current regression suite tests request serialization, future model IDs, live discovery, provenance, media input, history, error handling, and resource access. Upstream Jest tests reference deleted WebSocket modules and remain historical artifacts (`test:legacy`); they are not evidence for the stdio implementation. Older upstream guides describe the 2025 implementation; this README and runtime `get_help` supersede those model/capability claims.

See [verification record](docs/VERIFICATION-2026-09-28.md) for actual results and remaining gaps.

## Official references (checked 2026-09-28)

- [Gemini model catalog](https://ai.google.dev/gemini-api/docs/models)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Gemini 3.1 Pro Preview](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-pro-preview)
- [Google Search grounding](https://ai.google.dev/gemini-api/docs/google-search)
- [Structured outputs](https://ai.google.dev/gemini-api/docs/structured-output)
- [Image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)

- [Embedding models and migration](https://ai.google.dev/gemini-api/docs/embeddings)
