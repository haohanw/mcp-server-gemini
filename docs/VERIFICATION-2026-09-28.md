# Verification — 2026-09-28

## Scope

Maintained fork: current model routing, correctly serialized generation settings, evidence-bearing Google Search/URL context results, inline multimodal understanding, truthful live model discovery, and Codex analyst instructions. No account billing or permission changes were made.

## Confirmed

- Node.js 22.23.1; TypeScript build successful; Google GenAI SDK pinned to 2.24.0 (Node 20+).
- Production dependency audit: 0 known vulnerabilities after updating the SDK transitive `ws` dependency from 8.18.3 to 8.22.0. Development dependencies are outside this production-only audit.
- Current regression suite: 10 tests covering request configuration, unknown/future model IDs, linear conversation history with thought signatures, live catalog semantics, real image bytes, invalid/oversized media rejection, empty/truncated output, error redaction, MCP resources and actual stdio entrypoint.
- Live MCP initialization: server version 4.3.0.
- Live `list_models` succeeded after an intermittent network failure. Google returned `gemini-3.8-flash` and `gemini-3.1-pro-preview`, both with input limit 1,048,576, output limit 65,536, and generateContent/countTokens actions. Embedding models included `gemini-embedding-2` and `gemini-embedding-001`.
- Live `count_tokens` with `gemini-3.8-flash` succeeded.
- Local launcher and analyst role updated. Existing credential remains outside the repository.

## Blocked or unverified

- Gemini 3.8 Flash JSON generation and Gemini 3.1 Pro generation returned intermittent `fetch failed` network errors during the live suite.
- Search-grounded generation and base64 image understanding reached Google but returned HTTP 402 / RESOURCE_EXHAUSTED: project prepayment credits depleted. No successful generation, image interpretation or grounding citation result was observed. Do not label these as end-to-end passes.
- Further paid inference checks stopped after the billing error was identified. The smoke script now skips subsequent requests once that error occurs. No top-up, billing configuration or model fallback was performed.
- PDF/audio/video understanding, URL retrieval, and embeddings have request-path coverage where applicable, but no successful live result in this run. SDK typechecking and mocks are not substitutes for live verification.
- Custom agent file updated; an end-to-end subagent generation run remains unverified. The earlier role load succeeded, but its MCP call was blocked by non-interactive approval requirements. Read-only tool annotations now describe semantics; no approval policy was bypassed or loosened.
- The upstream historical Jest suite targets deleted WebSocket modules. It is retained under `test:legacy`; it does not test the current stdio transport.

## Resume after billing/network recovery

Run `npm test`, then explicitly opt into `node scripts/smoke.mjs` with the existing secure credential environment. Enable `GEMINI_SMOKE_GROUNDING=1` and `GEMINI_SMOKE_IMAGE=/path/to/fixture.png` for those checks. Check returned text, finish reason, JSON contents and actual grounding source metadata. Add separate real media/URL checks before claiming those paths verified.

References and portable setup are in the root README. Capability annotations are documentation-backed, not inferred from a model name or from listing alone.
