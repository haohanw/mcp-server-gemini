#!/usr/bin/env node
import {
  GoogleGenAI,
  type GenerateContentConfig,
  type Content,
  type Part,
} from "@google/genai";
import { pathToFileURL } from "node:url";
import { createInterface } from "readline";
import { MCPRequest, MCPResponse } from "./types.js";

// Increase max buffer size for large images (10MB)
if (process.stdin.setEncoding) {
  process.stdin.setEncoding("utf8");
}

// Capability annotations are documentation-backed, not inferred from model names.
// Unknown models remain callable; the live API is authoritative about availability.
const DEFAULT_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const DOCUMENTED_MODELS: Record<
  string,
  { features: string[]; source: string }
> = Object.fromEntries(
  ["gemini-3.8-flash", "gemini-3.1-pro-preview"].map((name) => [
    name,
    {
      features: [
        "thinking",
        "vision",
        "grounding",
        "json_mode",
        "url_context",
        "audio_input",
        "video_input",
        "pdf_input",
      ],
      source: `https://ai.google.dev/gemini-api/docs/models/${name}`,
    },
  ]),
);

export class EnhancedStdioMCPServer {
  private genAI: GoogleGenAI;
  private conversations: Map<string, Content[]> = new Map();

  constructor(apiKey: string, client?: GoogleGenAI, stdio = true) {
    this.genAI =
      client ?? new GoogleGenAI({ apiKey, httpOptions: { timeout: 90000 } });
    if (stdio) this.setupStdioInterface();
  }

  private setupStdioInterface() {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
      // Increase max line length for large image data
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (line.trim()) {
        try {
          const request: MCPRequest = JSON.parse(line);
          this.handleRequest(request);
        } catch (error) {
          console.error("Failed to parse JSON-RPC message");
        }
      }
    });

    process.stdin.on("error", (err) => {
      console.error("stdin error:", err);
    });
  }

  private async handleRequest(request: MCPRequest) {
    console.error("Handling request:", request.method);
    try {
      let response: MCPResponse;

      switch (request.method) {
        case "initialize":
          response = {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              protocolVersion: "2024-11-05",
              serverInfo: {
                name: "mcp-server-gemini-enhanced",
                version: "4.3.0",
              },
              capabilities: {
                tools: {},
                resources: {},
                prompts: {},
              },
            },
          };
          break;

        case "tools/list":
          response = {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              tools: this.getAvailableTools(),
            },
          };
          break;

        case "tools/call":
          response = await this.handleToolCall(request);
          break;

        case "resources/list":
          response = {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              resources: this.getAvailableResources(),
            },
          };
          break;

        case "resources/read":
          response = await this.handleResourceRead(request);
          break;

        case "prompts/list":
          response = {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              prompts: this.getAvailablePrompts(),
            },
          };
          break;

        default:
          if (!("id" in request)) {
            console.error(`Notification received: ${(request as any).method}`);
            return;
          }

          response = {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32601,
              message: "Method not found",
            },
          };
      }

      this.sendResponse(response);
    } catch (error) {
      const errorResponse: MCPResponse = {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "Internal error",
        },
      };
      this.sendResponse(errorResponse);
    }
  }

  private getAvailableTools() {
    return [
      {
        name: "generate_text",
        description: "Generate text using Google Gemini with advanced features",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The prompt to send to Gemini",
            },
            model: {
              type: "string",
              description: "Specific Gemini model to use",
              default: DEFAULT_MODEL,
            },
            systemInstruction: {
              type: "string",
              description: "System instruction to guide model behavior",
            },
            temperature: {
              type: "number",
              description: "Temperature for generation (0-2)",
              default: 1.0,
              minimum: 0,
              maximum: 2,
            },
            maxTokens: {
              type: "number",
              description: "Maximum tokens to generate",
              default: 2048,
            },
            topK: {
              type: "number",
              description: "Top-k sampling parameter",
              default: 40,
            },
            topP: {
              type: "number",
              description: "Top-p (nucleus) sampling parameter",
              default: 0.95,
            },
            jsonMode: {
              type: "boolean",
              description: "Enable JSON mode for structured output",
              default: false,
            },
            jsonSchema: {
              type: "object",
              description:
                "JSON schema for structured output (when jsonMode is true)",
            },
            grounding: {
              type: "boolean",
              description:
                "Enable Google Search grounding for up-to-date information",
              default: false,
            },
            safetySettings: {
              type: "array",
              description: "Safety settings for content filtering",
              items: {
                type: "object",
                properties: {
                  category: {
                    type: "string",
                    enum: [
                      "HARM_CATEGORY_HARASSMENT",
                      "HARM_CATEGORY_HATE_SPEECH",
                      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
                      "HARM_CATEGORY_DANGEROUS_CONTENT",
                    ],
                  },
                  threshold: {
                    type: "string",
                    enum: [
                      "BLOCK_NONE",
                      "BLOCK_ONLY_HIGH",
                      "BLOCK_MEDIUM_AND_ABOVE",
                      "BLOCK_LOW_AND_ABOVE",
                    ],
                  },
                },
              },
            },
            thinkingLevel: {
              type: "string",
              enum: ["low", "medium", "high"],
              description:
                "Optional thinking level; model support is validated by Google.",
            },
            urlContext: {
              type: "boolean",
              description:
                "Enable the Google URL context tool; check returned retrieval metadata.",
            },
            media: {
              type: "array",
              maxItems: 8,
              description:
                "Inline image, PDF, audio or video input; actual bytes, not paths. Combined decoded size must not exceed 20 MiB.",
              items: {
                type: "object",
                properties: {
                  mimeType: { type: "string" },
                  data: { type: "string", description: "Raw base64" },
                },
                required: ["mimeType", "data"],
                additionalProperties: false,
              },
            },
            conversationId: {
              type: "string",
              description: "ID for maintaining conversation context",
            },
          },
          required: ["prompt"],
        },
      },
      {
        name: "analyze_image",
        description: "Analyze images using Gemini vision capabilities",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "Question or instruction about the image",
            },
            imageUrl: {
              type: "string",
              description:
                "Deprecated: URLs are rejected. Supply actual imageBase64 bytes instead.",
            },
            imageBase64: {
              type: "string",
              description: "Base64-encoded image data (alternative to URL)",
            },
            model: {
              type: "string",
              description: "Vision-capable Gemini model",
              default: DEFAULT_MODEL,
            },
          },
          required: ["prompt"],
          oneOf: [{ required: ["imageUrl"] }, { required: ["imageBase64"] }],
        },
      },
      {
        name: "count_tokens",
        description: "Count tokens for a given text with a specific model",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to count tokens for",
            },
            model: {
              type: "string",
              description: "Model to use for token counting",
              default: DEFAULT_MODEL,
            },
          },
          required: ["text"],
        },
      },
      {
        name: "list_models",
        description:
          "Query the live API model catalog; capability annotations are documented only for known models. Listing is not proof of generation quota.",
        inputSchema: {
          type: "object",
          properties: {
            filter: {
              type: "string",
              description: "Filter models by capability",
              enum: ["all", "thinking", "vision", "grounding", "json_mode"],
            },
          },
        },
      },
      {
        name: "embed_text",
        description:
          "Generate embeddings for text using Gemini embedding models",
        inputSchema: {
          type: "object",
          properties: {
            text: {
              type: "string",
              description: "Text to generate embeddings for",
            },
            model: {
              type: "string",
              description: "Embedding model to use",
              default: "gemini-embedding-2",
            },
          },
          required: ["text"],
        },
      },
      {
        name: "get_help",
        description: "Get help and usage information for the Gemini MCP server",
        inputSchema: {
          type: "object",
          properties: {
            topic: {
              type: "string",
              description: "Help topic to get information about",
              enum: [
                "overview",
                "tools",
                "models",
                "parameters",
                "examples",
                "quick-start",
              ],
              default: "overview",
            },
          },
        },
      },
    ].map((tool) => ({
      ...tool,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: !["get_help"].includes(tool.name),
      },
    }));
  }

  private getAvailableResources() {
    return [
      {
        uri: "gemini://models",
        name: "Available Gemini Models",
        description:
          "List of all available Gemini models and their capabilities",
        mimeType: "application/json",
      },
      {
        uri: "gemini://capabilities",
        name: "API Capabilities",
        description: "Detailed information about Gemini API capabilities",
        mimeType: "text/markdown",
      },
      {
        uri: "gemini://help/usage",
        name: "Usage Guide",
        description: "Complete guide on using all tools and features",
        mimeType: "text/markdown",
      },
      {
        uri: "gemini://help/parameters",
        name: "Parameters Reference",
        description: "Detailed documentation of all parameters",
        mimeType: "text/markdown",
      },
      {
        uri: "gemini://help/examples",
        name: "Examples",
        description: "Example usage patterns for common tasks",
        mimeType: "text/markdown",
      },
    ];
  }

  private getAvailablePrompts() {
    return [
      {
        name: "code_review",
        description: "Comprehensive code review with Gemini 2.5 Pro",
        arguments: [
          {
            name: "code",
            description: "Code to review",
            required: true,
          },
          {
            name: "language",
            description: "Programming language",
            required: false,
          },
        ],
      },
      {
        name: "explain_with_thinking",
        description: "Deep explanation using Gemini 2.5 thinking capabilities",
        arguments: [
          {
            name: "topic",
            description: "Topic to explain",
            required: true,
          },
          {
            name: "level",
            description: "Explanation level (beginner/intermediate/expert)",
            required: false,
          },
        ],
      },
      {
        name: "creative_writing",
        description: "Creative writing with style control",
        arguments: [
          {
            name: "prompt",
            description: "Writing prompt",
            required: true,
          },
          {
            name: "style",
            description: "Writing style",
            required: false,
          },
          {
            name: "length",
            description: "Desired length",
            required: false,
          },
        ],
      },
    ];
  }

  private async handleToolCall(request: MCPRequest): Promise<MCPResponse> {
    const { name, arguments: args } = request.params || {};

    switch (name) {
      case "generate_text":
        return await this.generateText(request.id, args);

      case "analyze_image":
        return await this.analyzeImage(request.id, args);

      case "count_tokens":
        return await this.countTokens(request.id, args);

      case "list_models":
        return await this.listModels(request.id, args);

      case "embed_text":
        return await this.embedText(request.id, args);

      case "get_help":
        return this.getHelp(request.id, args);

      default:
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32601,
            message: `Unknown tool: ${name}`,
          },
        };
    }
  }

  private async generateText(id: any, args: any): Promise<MCPResponse> {
    try {
      if (typeof args?.prompt !== "string" || !args.prompt.trim())
        throw new Error("prompt is required");
      const model = args.model || DEFAULT_MODEL;
      const config: GenerateContentConfig = {
        maxOutputTokens: args.maxTokens ?? 2048,
      };
      // Do not override model defaults unless the caller requests it; preserve zero values.
      for (const key of ["temperature", "topK", "topP"] as const) {
        if (args[key] !== undefined) config[key] = args[key];
      }
      if (args.systemInstruction !== undefined)
        config.systemInstruction = args.systemInstruction;
      if (args.safetySettings !== undefined)
        config.safetySettings = args.safetySettings;
      if (args.jsonMode || args.jsonSchema) {
        config.responseMimeType = "application/json";
        if (args.jsonSchema) config.responseJsonSchema = args.jsonSchema;
      }
      if (args.thinkingLevel)
        config.thinkingConfig = { thinkingLevel: args.thinkingLevel };
      if (args.grounding || args.urlContext) {
        config.tools = [
          ...(args.grounding ? [{ googleSearch: {} }] : []),
          ...(args.urlContext ? [{ urlContext: {} }] : []),
        ];
      }
      const media = args.media ?? [];
      if (!Array.isArray(media) || media.length > 8)
        throw new Error("media must contain at most 8 items");
      let bytes = 0;
      const parts: Part[] = media.map((item: any) => {
        if (
          !item ||
          !/^(image\/(png|jpeg|webp|heic|heif)|application\/pdf|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/.test(
            item.mimeType,
          ) ||
          typeof item.data !== "string" ||
          !item.data.length ||
          item.data.length % 4 !== 0 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)
        ) {
          throw new Error("Invalid media MIME type or base64 data");
        }
        bytes += Buffer.byteLength(item.data, "base64");
        if (bytes > 20 * 1024 * 1024)
          throw new Error("Inline media exceeds 20 MiB; use a smaller input");
        return { inlineData: { mimeType: item.mimeType, data: item.data } };
      });
      parts.push({ text: args.prompt });
      const user: Content = { role: "user", parts };
      const history = args.conversationId
        ? (this.conversations.get(args.conversationId) ?? [])
        : [];
      const result = await this.genAI.models.generateContent({
        model,
        contents: [...history, user],
        config,
      });
      const text = result.text || "";
      const candidate = result.candidates?.[0];
      if (!text.trim())
        throw new Error(
          `No text returned (finishReason: ${candidate?.finishReason ?? "unknown"})`,
        );
      if (
        (args.jsonMode || args.jsonSchema) &&
        candidate?.finishReason === "STOP"
      )
        JSON.parse(text);
      if (args.conversationId && candidate?.finishReason === "STOP") {
        // Store each new turn once; preserve model thought signatures when supplied.
        this.conversations.set(args.conversationId, [
          ...history,
          user,
          candidate.content ?? { role: "model", parts: [{ text }] },
        ]);
      }
      const metadata = {
        model,
        modelVersion: result.modelVersion,
        usage: result.usageMetadata,
        finishReason: candidate?.finishReason,
        groundingMetadata: candidate?.groundingMetadata,
        urlContextMetadata: candidate?.urlContextMetadata,
      };
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text },
            { type: "text", text: JSON.stringify({ metadata }) },
          ],
          structuredContent: { text, metadata },
          metadata,
        },
      };
    } catch (error) {
      return this.toolError(id, error);
    }
  }

  private toolError(id: any, error: unknown): MCPResponse {
    const message = error instanceof Error ? error.message : "Internal error";
    // SDK errors can include request details; never return the credential.
    const key = process.env.GEMINI_API_KEY;
    const safe = key ? message.split(key).join("[REDACTED]") : message;
    return {
      jsonrpc: "2.0",
      id,
      result: { isError: true, content: [{ type: "text", text: safe }] },
    };
  }

  private async analyzeImage(id: any, args: any): Promise<MCPResponse> {
    if (args?.imageUrl)
      return this.toolError(
        id,
        new Error(
          "imageUrl is not fetched. Supply imageBase64 with actual image bytes; a URL string is not image input.",
        ),
      );
    if (typeof args?.imageBase64 !== "string")
      return this.toolError(id, new Error("imageBase64 is required"));
    const match = args.imageBase64.match(
      /^data:(image\/[^;]+);base64,([\s\S]+)$/,
    );
    return this.generateText(id, {
      ...args,
      media: [
        {
          mimeType: match?.[1] ?? "image/jpeg",
          data: match?.[2] ?? args.imageBase64,
        },
      ],
    });
  }

  private async countTokens(id: any, args: any): Promise<MCPResponse> {
    try {
      if (typeof args?.text !== "string") throw new Error("text is required");
      const model = args.model || DEFAULT_MODEL;

      const result = await this.genAI.models.countTokens({
        model,
        contents: [
          {
            parts: [
              {
                text: args.text,
              },
            ],
            role: "user",
          },
        ],
      });

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: `Token count: ${result.totalTokens}`,
            },
          ],
          metadata: {
            tokenCount: result.totalTokens,
            model,
          },
        },
      };
    } catch (error) {
      return this.toolError(id, error);
    }
  }

  private async listModels(id: any, args: any): Promise<MCPResponse> {
    try {
      const filter = args?.filter ?? "all";
      if (
        !["all", "thinking", "vision", "grounding", "json_mode"].includes(
          filter,
        )
      )
        throw new Error("Unknown model filter");
      const pager = await this.genAI.models.list({ config: { pageSize: 100 } });
      const models = [];
      for await (const model of pager) {
        const name = model.name?.replace(/^models\//, "") ?? "";
        const documented = DOCUMENTED_MODELS[name];
        if (filter !== "all" && !documented?.features.includes(filter))
          continue;
        models.push({
          ...model,
          documentedCapabilities: documented?.features ?? null,
          capabilitySource: documented?.source ?? null,
        });
      }
      const result = {
        source: "Google models.list (live)",
        models,
        filter,
        note: "Unknown capabilities are null, not unsupported. API listing does not prove quota or successful generation.",
      };
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        },
      };
    } catch (error) {
      return this.toolError(id, error);
    }
  }

  private async embedText(id: any, args: any): Promise<MCPResponse> {
    try {
      if (typeof args?.text !== "string" || !args.text.trim())
        throw new Error("text is required");
      const model = args.model || "gemini-embedding-2";

      const result = await this.genAI.models.embedContent({
        model,
        contents: args.text,
      });
      if (!result.embeddings?.[0]?.values?.length)
        throw new Error("No embedding returned");

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                embedding: result.embeddings?.[0]?.values || [],
                model,
              }),
            },
          ],
          metadata: {
            model,
            dimensions: result.embeddings?.[0]?.values?.length || 0,
          },
        },
      };
    } catch (error) {
      return this.toolError(id, error);
    }
  }

  private getHelpContent(_topic: string): string {
    return `Gemini MCP 4.3.0. Default text/vision model: ${DEFAULT_MODEL}. Optional complex-analysis model: gemini-3.1-pro-preview (preview).

Use list_models to query the live model catalog, including supportedActions and token limits. Model IDs are not restricted to a static enum. Unknown capability annotations mean unknown, not unsupported.

Tools: generate_text, analyze_image, count_tokens, list_models, embed_text, get_help. generate_text supports systemInstruction, temperature, maxTokens, topK, topP, jsonMode/jsonSchema, thinkingLevel (low/medium/high), grounding, urlContext, media and conversationId. Configuration is passed through SDK config. API validation remains authoritative for combinations and model support.

media accepts inline {mimeType,data} base64 image/PDF/audio/video parts (max 8 parts, 20 MiB total). No file paths, uploads or automatic URL image downloads. analyze_image accepts actual base64 bytes. imageUrl fails explicitly.

Check isError, finishReason, non-empty text and returned groundingMetadata/urlContextMetadata. Requested search is not evidence that search ran. Structured output must be parsed and checked by the caller. Partial output is not completion.

Embeddings default to gemini-embedding-2. This server does not implement image/audio generation, Live API, computer control, local shell, arbitrary function execution, or file-search stores. Gemini model capabilities do not imply this MCP exposes them.

Official references: https://ai.google.dev/gemini-api/docs/models https://ai.google.dev/gemini-api/docs/google-search https://ai.google.dev/gemini-api/docs/structured-output`;
  }

  private getHelp(id: any, _args: any): MCPResponse {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: this.getHelpContent("overview") }],
      },
    };
  }

  private async handleResourceRead(request: MCPRequest): Promise<MCPResponse> {
    const uri = request.params?.uri;
    if (
      !this.getAvailableResources().some((resource) => resource.uri === uri)
    ) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32602, message: "Unknown resource URI" },
      };
    }
    const result =
      uri === "gemini://models"
        ? await this.listModels(request.id, {})
        : this.getHelp(request.id, {});
    if (result.result?.isError)
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: result.result.content[0].text },
      };
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: {
        contents: [
          {
            uri,
            mimeType:
              uri === "gemini://models" ? "application/json" : "text/markdown",
            text: result.result.content[0].text,
          },
        ],
      },
    };
  }

  private sendResponse(response: MCPResponse) {
    const responseStr = JSON.stringify(response);
    process.stdout.write(responseStr + "\n");
  }
}

// Importing this module for tests has no I/O or credential side effects.
export function startServer() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    throw new Error("GEMINI_API_KEY environment variable is required");
  return new EnhancedStdioMCPServer(apiKey);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  startServer();
