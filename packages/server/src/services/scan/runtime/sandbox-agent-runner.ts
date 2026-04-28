import { appendFile } from "node:fs/promises";
import { SandboxAgent } from "sandbox-agent";
import { Agent, type Dispatcher } from "undici";

const ACP_HTTP_TIMEOUT_MS = 15 * 60 * 1000;
const SANDBOX_AGENT_PROMPT_TIMEOUT_MS = 10 * 60 * 1000;
const VULSEEK_RET_OPEN = "<VULSEEK_RET>";
const VULSEEK_RET_CLOSE = "<VULSEEK_RET/>";

type RequestInitWithDispatcher = RequestInit & {
  dispatcher?: Dispatcher;
};

type SandboxAgentSessionUpdate =
  | {
      sessionUpdate?: string;
      content?: unknown;
      itemId?: string;
      [key: string]: unknown;
    }
  | string
  | unknown[];

type SandboxAgentSessionEvent = {
  id?: string;
  eventIndex?: number;
  sessionId?: string;
  createdAt?: string;
  connectionId?: string;
  sender?: string;
  payload?: SandboxAgentSessionUpdate | Record<string, unknown>;
};

type MaybeSandboxAgentSessionUpdate = SandboxAgentSessionUpdate | undefined;

const acpHttpDispatcher = new Agent({
  headersTimeout: ACP_HTTP_TIMEOUT_MS,
  bodyTimeout: ACP_HTTP_TIMEOUT_MS,
});

const sandboxAgentFetch: typeof fetch = async (input, init) => {
  const nextInit: RequestInitWithDispatcher = {
    ...(init || {}),
    dispatcher:
      (init as RequestInitWithDispatcher | undefined)?.dispatcher ||
      acpHttpDispatcher,
  };
  return fetch(input, nextInit);
};

const asRecord = (value: unknown) =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const asString = (value: unknown) => (typeof value === "string" ? value : "");

const appendScanRuntimeFile = async (filePath: string, content: string) => {
  if (!content) return;
  await appendFile(filePath, content, "utf-8");
};

const formatSandboxAgentSessionEvent = (event: SandboxAgentSessionEvent) =>
  `${JSON.stringify(event)}\n`;

const getEventPayloadRecord = (event: SandboxAgentSessionEvent) =>
  asRecord(event.payload);

const getEventParamsRecord = (event: SandboxAgentSessionEvent) =>
  asRecord(getEventPayloadRecord(event)?.params);

const getEventUpdate = (event: SandboxAgentSessionEvent) => {
  const paramsUpdate = getEventParamsRecord(event)?.update;
  if (paramsUpdate !== undefined) {
    return paramsUpdate as MaybeSandboxAgentSessionUpdate;
  }
  return event.payload as MaybeSandboxAgentSessionUpdate;
};

const extractTextValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractTextValue).join("");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return [record.text, record.value, record.content]
    .map(extractTextValue)
    .find(Boolean) || "";
};

const extractPayloadText = (payload: MaybeSandboxAgentSessionUpdate): string => {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) {
    return payload
      .map((item) => extractPayloadText(item as MaybeSandboxAgentSessionUpdate))
      .join("");
  }
  const record = asRecord(payload);
  if (!record) return "";
  return (
    extractTextValue(record.content) ||
    extractTextValue(record.delta) ||
    extractTextValue(record.message) ||
    extractTextValue(record.result) ||
    extractTextValue(record)
  );
};

const renderSandboxAgentEvent = (event: SandboxAgentSessionEvent) => {
  const update = getEventUpdate(event);
  const record = asRecord(update);
  const updateType = asString(record?.sessionUpdate);
  const text = extractPayloadText(update);
  switch (updateType) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk":
      return text;
    case "tool_call":
    case "tool_call_update":
      return text ? `\n[tool] ${text}\n` : "";
    case "plan":
      return text ? `\n[plan] ${text}\n` : "";
    case "usage_update":
      return "";
    case "session_info_update":
      return text ? `\n[session] ${text}\n` : "";
    default:
      return text;
  }
};

const extractVulseekRetValue = (content: string): string | null => {
  const start = content.lastIndexOf(VULSEEK_RET_OPEN);
  if (start < 0) return null;
  const end = content.indexOf(VULSEEK_RET_CLOSE, start + VULSEEK_RET_OPEN.length);
  if (end < 0) return null;
  return content.slice(start + VULSEEK_RET_OPEN.length, end).trim();
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorFactory: () => Error,
): Promise<T> => {
  let timeout: NodeJS.Timeout | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(errorFactory()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export const runSandboxAgentHeadlessTurnInContainer = async (input: {
  baseUrl: string;
  provider: "codex" | "claude";
  cwd: string;
  prompt: string;
  model?: string;
  thinkingLevel?: string;
  jsonlPath: string;
  textPath: string;
  stderrPath: string;
  onSessionId?: (sessionId: string) => Promise<void>;
}) => {
  const client: any = await SandboxAgent.connect({
    baseUrl: input.baseUrl,
    fetch: sandboxAgentFetch,
  } as never);

  const session: any = await client.createSession({
    agent: input.provider,
    cwd: input.cwd,
    model: input.model || undefined,
    effort: input.thinkingLevel || undefined,
    mode: input.provider === "codex" ? "full-access" : undefined,
  } as never);

  const sessionId = asString(session?.agentSessionId) || asString(session?.id) || "";
  if (sessionId) {
    await input.onSessionId?.(sessionId);
  }

  let eventWriteChain = Promise.resolve();
  let agentMessageText = "";
  let returnValue = "";

  const appendSessionEvent = async (event: SandboxAgentSessionEvent) => {
    await appendScanRuntimeFile(input.jsonlPath, formatSandboxAgentSessionEvent(event));
    const rendered = renderSandboxAgentEvent(event);
    if (rendered) {
      await appendScanRuntimeFile(input.textPath, rendered);
    }

    const update = getEventUpdate(event);
    const payloadRecord = asRecord(update);
    if (asString(payloadRecord?.sessionUpdate) === "agent_message_chunk") {
      agentMessageText += extractPayloadText(update);
      const nextReturnValue = extractVulseekRetValue(agentMessageText);
      if (nextReturnValue !== null) {
        returnValue = nextReturnValue;
      }
    }
  };

  session.onEvent((event: SandboxAgentSessionEvent) => {
    eventWriteChain = eventWriteChain
      .then(() => appendSessionEvent(event))
      .catch(async (error) => {
        await appendScanRuntimeFile(
          input.stderrPath,
          `[sandbox-agent-event] ${error instanceof Error ? error.message : "unknown error"}\n`,
        );
      });
  });

  session.onPermissionRequest((request: Record<string, unknown>) => {
    const permissionId =
      asString(request.id) ||
      asString(request.permissionId) ||
      asString(asRecord(request.permission)?.id);
    if (!permissionId) {
      return;
    }

    void (async () => {
      try {
        await session.respondPermission(permissionId, "always");
      } catch {
        try {
          await session.respondPermission(permissionId, "once");
        } catch (error) {
          await appendScanRuntimeFile(
            input.stderrPath,
            `[sandbox-agent-permission] ${error instanceof Error ? error.message : "failed to auto-approve permission"}\n`,
          );
        }
      }
    })();
  });

  try {
    await withTimeout(
      session.prompt([{ type: "text", text: input.prompt }]),
      SANDBOX_AGENT_PROMPT_TIMEOUT_MS,
      () =>
        new Error(
          `sandbox-agent session.prompt timed out after ${Math.round(
            SANDBOX_AGENT_PROMPT_TIMEOUT_MS / 1000,
          )}s`,
        ),
    );
    await eventWriteChain;
  } catch (error) {
    const message = error instanceof Error ? error.message : "sandbox-agent prompt failed";
    await eventWriteChain.catch(() => {});
    await appendScanRuntimeFile(input.stderrPath, `[sandbox-agent] ${message}\n`);
    throw error;
  } finally {
    try {
      await session.close?.();
    } catch {}
    try {
      await client.disconnect?.();
    } catch {}
  }

  return {
    sessionId,
    rawOutput: returnValue,
  };
};
