/**
 * pi-subagent-in-memory — In-process subagent tool for pi.
 *
 * Registers a `subagent_create` tool that spawns subagent sessions in the same
 * process via the pi SDK's createAgentSession. Live progress is streamed back
 * as tool_execution_update events and rendered as TUI card widgets.
 *
 * Key design principle: apart from tool parameter definitions, this extension
 * adds NOTHING to your LLM context. No system prompt injection, no hidden
 * instructions — the LLM only sees the tool schema.
 *
 * Features:
 * - Live TUI card widgets showing subagent status and output
 * - JSONL event logging to ~/.pi/subagent-in-memory/<sessionId>/
 * - Nested subagent support (subagents can spawn subagents)
 * - /in-memory-clear-widgets slash command to remove widget cards
 * - Multi-provider support (Anthropic, OpenAI, Google, etc.)
 *
 * Results are written to ./.pi/subagent-in-memory/<mainSessionId>/subagent_<N>/result.md
 * (or error.md on failure) so the calling agent gets a short pointer instead of
 * the full output.
 */

import { Type, type Static } from "@sinclair/typebox";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  DefaultResourceLoader,
  getAgentDir,
  createCodingTools,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-coding-agent";
import { resolveModel } from "./model.ts";
import { renderCard, type CardTheme } from "./tui-draw.ts";

import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ── JSONL event logger ──────────────────────────────────────────
function jsonlAppend(filePath: string, data: Record<string, any>) {
  appendFileSync(filePath, JSON.stringify(data) + "\n", "utf-8");
}

// ── Subagent card state ─────────────────────────────────────────
interface SubagentCard {
  sessionId: string;
  title: string;
  modelLabel: string;
  status: "created" | "running" | "completed" | "error";
  textPreview: string;
  columnWidthPercent: number;
  startedAt: number;
  endedAt?: number;
}

const CARD_THEMES: CardTheme[] = [
  { bg: "\x1b[48;2;20;30;75m",  br: "\x1b[38;2;70;110;210m" },
  { bg: "\x1b[48;2;80;18;28m",  br: "\x1b[38;2;210;65;85m" },
  { bg: "\x1b[48;2;50;22;85m",  br: "\x1b[38;2;145;80;220m" },
  { bg: "\x1b[48;2;12;65;75m",  br: "\x1b[38;2;40;175;195m" },
  { bg: "\x1b[48;2;55;50;10m",  br: "\x1b[38;2;190;170;50m" },
  { bg: "\x1b[48;2;15;55;30m",  br: "\x1b[38;2;50;185;100m" },
];

function formatElapsed(startedAt: number, endedAt?: number): string {
  const elapsed = Math.floor(((endedAt ?? Date.now()) - startedAt) / 1000);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Shared state — single instance across all nesting levels ────
const subagents: SubagentCard[] = [];
let currentCtx: { ui: any } | null = null;
let mainSessionId = "unknown";
let subagentCount = 0;

function updateSubagentWidget() {
  if (!currentCtx) return;
  const ctx = currentCtx;

  ctx.ui.setWidget(
    "in-memory-subagent-cards",
    (_tui: any, theme: any) => ({
      render(width: number): string[] {
        if (subagents.length === 0) return [];

        // Derive cols from columnWidthPercent (all cards share the same value).
        const pct = subagents[subagents.length - 1].columnWidthPercent;
        const cols = Math.min(3, Math.max(1, Math.round(100 / pct)));
        const gap = 1;
        const colWidth = Math.floor((width - gap * (cols - 1)) / cols);
        const maxContentLines = 4;
        const lines: string[] = [""];

        for (let i = 0; i < subagents.length; i += cols) {
          const rowCards = subagents.slice(i, i + cols).map((sa, idx) => {
            const cardTheme = CARD_THEMES[(i + idx) % CARD_THEMES.length];

            const titleText = `${sa.title} [${sa.modelLabel}]`;
            const innerW = colWidth - 4;

            const allText = sa.textPreview || "…";
            const contentLines = allText.split("\n");
            const trimmedLines = contentLines.map((l) =>
              visibleWidth(l) > innerW ? "…" + truncateToWidth(l, innerW - 1) : l
            );
            const visible = trimmedLines.slice(-maxContentLines);
            const content = (contentLines.length > maxContentLines ? "…\n" : "") + visible.join("\n");

            const statusIcon = sa.status === "completed" ? "✓" : sa.status === "error" ? "✗" : "●";
            const footer = `${statusIcon} ${formatElapsed(sa.startedAt, sa.endedAt)}`;

            return renderCard({
              title: titleText,
              content,
              footer,
              colWidth,
              theme,
              cardTheme,
            });
          });

          // Pad incomplete rows
          while (rowCards.length < cols) {
            rowCards.push(Array(rowCards[0].length).fill(" ".repeat(colWidth)));
          }

          const cardHeight = Math.max(...rowCards.map((c) => c.length));
          for (const card of rowCards) {
            while (card.length < cardHeight) {
              card.push(" ".repeat(colWidth));
            }
          }

          for (let row = 0; row < cardHeight; row++) {
            lines.push(rowCards.map((card) => card[row]).join(" ".repeat(gap)));
          }
        }

        return lines;
      },
      invalidate() {},
    }),
    { placement: "aboveEditor" }
  );
}

// ── Parameter schema ────────────────────────────────────────────
const SubagentParams = Type.Object({
  task: Type.String({ description: "The task for the subagent to perform" }),
  title: Type.Optional(
    Type.String({ description: "Display title for the subagent card. Defaults to a truncated version of the task." })
  ),
  provider: Type.Optional(
    Type.String({ description: "LLM provider (e.g. 'anthropic', 'google'). Defaults to the main agent's provider." })
  ),
  model: Type.Optional(
    Type.String({ description: "Model ID (e.g. 'claude-sonnet-4-5'). Defaults to the main agent's model." })
  ),
  cwd: Type.Optional(
    Type.String({ description: "Working directory for the subagent. Defaults to the main agent's cwd." })
  ),
  timeout: Type.Optional(
    Type.Number({
      description:
        "Timeout in seconds for the subagent execution. If exceeded, the subagent is aborted. " +
        "Defaults to unlimited (no timeout).",
      minimum: 1,
    })
  ),
  columnWidthPercent: Type.Optional(
    Type.Number({
      description:
        "Width of this subagent's card as a percentage of terminal width (e.g. 50 for 2 parallel agents, 33 for 3). " +
        "Max 3 cards per row. Defaults to 50.",
      minimum: 33,
      maximum: 100,
    })
  ),
});

type SubagentParamsType = Static<typeof SubagentParams>;

// ── Core execution logic ────────────────────────────────────────
async function executeSubagent(
  toolCallId: string,
  params: SubagentParamsType,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback | undefined,
  fallbackProvider?: string,
  fallbackModel?: string,
  fallbackCwd?: string,
): Promise<AgentToolResult<any>> {
  subagentCount++;
  const subagentNum = subagentCount;
  const outDir = join(".pi", "subagent-in-memory", mainSessionId, `subagent_${subagentNum}`);
  mkdirSync(outDir, { recursive: true });

  // Parse "provider/model" format (e.g. "openai/gpt-4o-mini")
  let providerName = params.provider ?? fallbackProvider;
  let modelId = params.model ?? fallbackModel;
  if (modelId && !params.provider && modelId.includes("/")) {
    const slashIdx = modelId.indexOf("/");
    providerName = modelId.slice(0, slashIdx);
    modelId = modelId.slice(slashIdx + 1);
  }

  if (!providerName || !modelId) {
    throw new Error("Could not determine model. Provide provider and model parameters.");
  }

  const { model: resolvedModel, apiKey } = await resolveModel(providerName, modelId);

  const cwd = params.cwd ?? fallbackCwd ?? process.cwd();

  const authStorage = AuthStorage.create();
  authStorage.setRuntimeApiKey(providerName, apiKey);

  // Create tools for the subagent, including nested subagent support
  const tools = [
    ...createCodingTools(cwd),
    createGrepTool(cwd),
    createFindTool(cwd),
    createLsTool(cwd),
    createSubagentAgentTool(providerName, modelId, cwd),
  ];

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    model: resolvedModel,
    authStorage,
    tools,
    thinkingLevel: "off",
    cwd,
    sessionManager: SessionManager.inMemory(),
    resourceLoader,
  });

  // Set up JSONL event log
  const jsonlPath = join(outDir, "events.jsonl");
  const sessionTs = new Date().toISOString();
  jsonlAppend(jsonlPath, {
    type: "session",
    version: 1,
    id: session.sessionId,
    timestamp: sessionTs,
    cwd,
    provider: providerName,
    model: modelId,
    task: params.task,
    title: params.title,
  });
  let lastEventId = session.sessionId;

  // Track card
  const card: SubagentCard = {
    sessionId: session.sessionId,
    title: params.title ?? params.task.slice(0, 30),
    modelLabel: modelId,
    status: "created",
    textPreview: "",
    columnWidthPercent: params.columnWidthPercent ?? 50,
    startedAt: Date.now(),
  };
  subagents.push(card);
  updateSubagentWidget();

  onUpdate?.({
    content: [{ type: "text", text: `Subagent session created: ${session.sessionId}` }],
    details: { sessionId: session.sessionId, status: "created" },
  });

  // Timeout handling
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutController = new AbortController();
  if (params.timeout) {
    timeoutTimer = setTimeout(() => {
      timeoutController.abort();
    }, params.timeout * 1000);
  }

  const combinedAbort = () => {
    session.abort();
    card.status = "error";
    card.endedAt = Date.now();
    updateSubagentWidget();
  };

  try {
    const result = await new Promise<string>((resolve, reject) => {
      let finalText = "";
      let textDeltaBuffer = "";
      let toolcallDeltaBuffer = "";

      session.subscribe((event) => {
        const updateData: Record<string, any> = {
          type: event.type,
          sessionId: session.sessionId,
        };

        const eventId = randomUUID().slice(0, 8);
        const eventTs = new Date().toISOString();
        const baseLog = { type: event.type, id: eventId, parentId: lastEventId, timestamp: eventTs };

        switch (event.type) {
          case "agent_start":
            card.status = "running";
            updateSubagentWidget();
            jsonlAppend(jsonlPath, baseLog);
            lastEventId = eventId;
            onUpdate?.({
              content: [{ type: "text", text: "Subagent started..." }],
              details: updateData,
            });
            break;

          case "message_update": {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") {
              textDeltaBuffer += ame.delta;
              finalText += ame.delta;
              card.textPreview = finalText;
              updateSubagentWidget();
              onUpdate?.({
                content: [{ type: "text", text: finalText }],
                details: {
                  ...updateData,
                  data: { assistantMessageEventType: ame.type, delta: ame.delta },
                },
              });
            } else if (ame.type === "text_end") {
              if (textDeltaBuffer) {
                jsonlAppend(jsonlPath, { ...baseLog, data: { assistantMessageEventType: "text", text: textDeltaBuffer } });
                textDeltaBuffer = "";
              } else {
                jsonlAppend(jsonlPath, { ...baseLog, data: { assistantMessageEventType: ame.type } });
              }
              lastEventId = eventId;
            } else if (ame.type === "toolcall_delta") {
              if ("delta" in ame) toolcallDeltaBuffer += (ame as any).delta ?? "";
            } else if (ame.type === "toolcall_end") {
              if (toolcallDeltaBuffer) {
                jsonlAppend(jsonlPath, { ...baseLog, data: { assistantMessageEventType: "toolcall", content: toolcallDeltaBuffer } });
                toolcallDeltaBuffer = "";
              } else {
                jsonlAppend(jsonlPath, { ...baseLog, data: { assistantMessageEventType: ame.type } });
              }
              lastEventId = eventId;
            } else if (ame.type === "text_start" || ame.type === "toolcall_start") {
              // Skip start markers
            } else {
              jsonlAppend(jsonlPath, { ...baseLog, data: { assistantMessageEventType: ame.type } });
              lastEventId = eventId;
            }
            break;
          }

          case "tool_execution_start":
            card.textPreview = finalText + `\n[${event.toolName} ⏳]`;
            updateSubagentWidget();
            jsonlAppend(jsonlPath, { ...baseLog, toolName: event.toolName, args: event.args });
            lastEventId = eventId;
            onUpdate?.({
              content: [
                { type: "text", text: finalText + `\n[Tool: ${event.toolName}]` },
              ],
              details: {
                ...updateData,
                data: { toolName: event.toolName, args: event.args },
              },
            });
            break;

          case "tool_execution_end":
            card.textPreview = finalText + `\n[${event.toolName} ${event.isError ? "❌" : "✅"}]`;
            updateSubagentWidget();
            jsonlAppend(jsonlPath, { ...baseLog, toolName: event.toolName, isError: event.isError, result: event.result });
            lastEventId = eventId;
            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: finalText + `\n[Tool: ${event.toolName} ${event.isError ? "❌" : "✅"}]`,
                },
              ],
              details: {
                ...updateData,
                data: { toolName: event.toolName, isError: event.isError },
              },
            });
            break;

          case "agent_end":
            card.status = "completed";
            card.endedAt = Date.now();
            updateSubagentWidget();
            jsonlAppend(jsonlPath, { ...baseLog, finalTextLength: finalText.length });
            resolve(finalText || "Subagent completed with no text output.");
            break;

          case "turn_start":
          case "turn_end":
          case "message_start":
          case "message_end":
            jsonlAppend(jsonlPath, baseLog);
            lastEventId = eventId;
            onUpdate?.({
              content: [{ type: "text", text: finalText || "..." }],
              details: updateData,
            });
            break;

          default:
            jsonlAppend(jsonlPath, { ...baseLog, raw: event });
            lastEventId = eventId;
            break;
        }
      });

      if (signal) {
        signal.addEventListener("abort", () => {
          combinedAbort();
          reject(new Error("Subagent was aborted"));
        });
      }
      timeoutController.signal.addEventListener("abort", () => {
        combinedAbort();
        reject(new Error(`Subagent timed out after ${params.timeout}s`));
      });

      session.prompt(params.task).catch((err) => {
        card.status = "error";
        card.endedAt = Date.now();
        updateSubagentWidget();
        reject(err);
      });
    });

    if (timeoutTimer) clearTimeout(timeoutTimer);
    session.dispose();

    const resultPath = join(outDir, "result.md");
    writeFileSync(resultPath, result, "utf-8");

    return {
      content: [{ type: "text", text: `Execution succeeded. Result is in \`${resultPath}\`` }],
      details: { sessionId: session.sessionId, status: "completed", outputDir: outDir },
    };
  } catch (err: any) {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    session.dispose();

    const errorMsg = err?.message ?? String(err);
    const errorPath = join(outDir, "error.md");
    writeFileSync(errorPath, `# Subagent Error\n\n${errorMsg}\n`, "utf-8");

    return {
      content: [{ type: "text", text: `Execution failed. Detail is in \`${errorPath}\`` }],
      details: { sessionId: session.sessionId, status: "error", outputDir: outDir },
    };
  }
}

// ── AgentTool factory for nested subagent sessions ──────────────
function createSubagentAgentTool(
  parentProvider: string,
  parentModel: string,
  parentCwd: string,
) {
  return {
    name: "subagent_create",
    label: "Subagent",
    description:
      "Create a subagent to perform a task. The subagent runs in-process with its own session. " +
      "Progress is streamed back as execution updates. Returns the final result when the subagent finishes.",
    parameters: SubagentParams,
    async execute(
      toolCallId: string,
      params: SubagentParamsType,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback,
    ) {
      return executeSubagent(
        toolCallId,
        params,
        signal,
        onUpdate,
        parentProvider,
        parentModel,
        parentCwd,
      );
    },
  };
}

// ── Extension entry point ───────────────────────────────────────
export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    mainSessionId = ctx.sessionManager.getSessionId?.() ?? `session-${Date.now()}`;
    subagentCount = 0;
    updateSubagentWidget();
  });

  pi.registerCommand("in-memory-clear-widgets", {
    description: "Clear all in-memory subagent card widgets",
    handler: async (_args, ctx) => {
      subagents.length = 0;
      ctx.ui.setWidget("in-memory-subagent-cards", undefined);
      ctx.ui.notify("In-memory subagent widgets cleared", "info");
    },
  });

  pi.registerTool<typeof SubagentParams>({
    name: "subagent_create",
    label: "Subagent",
    description:
      "Create a subagent to perform a task. The subagent runs in-process with its own session. " +
      "Progress is streamed back as execution updates. Returns the final result when the subagent finishes.",
    parameters: SubagentParams,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const mainModel = ctx.model;
      const providerName = params.provider ?? mainModel?.provider;
      const modelId = params.model ?? mainModel?.id;
      const cwd = params.cwd ?? ctx.cwd;

      return executeSubagent(
        toolCallId,
        params,
        signal,
        onUpdate,
        providerName,
        modelId,
        cwd,
      );
    },
  });
}
