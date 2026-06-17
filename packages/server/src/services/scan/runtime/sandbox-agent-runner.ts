import { appendFile, writeFile } from "node:fs/promises";
import { SandboxAgent } from "sandbox-agent";
import { Agent, type Dispatcher } from "undici";

const SANDBOX_AGENT_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;

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
  headersTimeout: 0,
  bodyTimeout: 0,
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

const getPermissionRequestId = (request: Record<string, unknown>) =>
  asString(request.id) ||
  asString(request.permissionId) ||
  asString(asRecord(request.permission)?.id) ||
  asString(asRecord(request.rawRequest)?.id);

const autoApprovePermissionRequest = async (
  session: {
    respondPermission: (permissionId: string, reply: "always" | "once") => Promise<void>;
  },
  stderrPath: string,
  request: Record<string, unknown>,
) => {
  const permissionId = getPermissionRequestId(request);
  if (!permissionId) {
    await appendScanRuntimeFile(
      stderrPath,
      "[sandbox-agent-permission] unable to auto-approve permission without id\n",
    );
    return;
  }

  const availableReplies = Array.isArray(request.availableReplies)
    ? request.availableReplies
        .map((reply) => String(reply))
        .filter((reply) => reply.length > 0)
    : [];
  const replies = [
    ...availableReplies.filter((reply) => reply === "always"),
    ...availableReplies.filter((reply) => reply === "once"),
    "always",
    "once",
  ].filter((reply, index, values) => values.indexOf(reply) === index) as Array<
    "always" | "once"
  >;

  for (const reply of replies) {
    try {
      await session.respondPermission(permissionId, reply);
      await appendScanRuntimeFile(
        stderrPath,
        `[sandbox-agent-permission] auto-approved permission id=${permissionId} reply=${reply}\n`,
      );
      return;
    } catch (error) {
      await appendScanRuntimeFile(
        stderrPath,
        `[sandbox-agent-permission] auto-approve attempt failed id=${permissionId} reply=${reply} error=${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
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

const isAgentThoughtChunkEvent = (event: SandboxAgentSessionEvent) => {
  const update = getEventUpdate(event);
  return asString(asRecord(update)?.sessionUpdate) === "agent_thought_chunk";
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

const extractRawOutputText = (rawOutput: unknown): string => {
  const record = asRecord(rawOutput);
  if (!record) return extractTextValue(rawOutput);
  const lines: string[] = [];
  const exitCode = record.exit_code ?? record.exitCode ?? record.code;
  const status = asString(record.status);
  if (exitCode !== undefined) lines.push(`exit_code: ${String(exitCode)}`);
  if (status) lines.push(`status: ${status}`);
  const stderr = extractTextValue(record.stderr);
  if (stderr) lines.push(`stderr:\n${stderr}`);
  const stdout =
    extractTextValue(record.stdout) ||
    extractTextValue(record.aggregated_output) ||
    extractTextValue(record.aggregatedOutput) ||
    extractTextValue(record.output);
  if (stdout) lines.push(`output:\n${stdout}`);
  return lines.join("\n") || extractTextValue(rawOutput);
};

const mergeToolTextWithRawOutput = (
  text: string,
  record: Record<string, unknown> | null,
) => {
  const rawOutputText = extractRawOutputText(record?.rawOutput);
  if (!rawOutputText) return text;
  if (!text) return rawOutputText;
  if (text.includes(rawOutputText) || rawOutputText.includes(text)) {
    return text;
  }
  return `${text}\nrawOutput:\n${rawOutputText}`;
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
    case "tool_call_update": {
      const toolText = mergeToolTextWithRawOutput(text, record);
      return toolText ? `\n[tool] ${toolText}\n` : "";
    }
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
  usagePath: string;
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
    thoughtLevel: input.thinkingLevel || undefined,
    mode: input.provider === "codex" ? "full-access" : undefined,
  } as never);

  const sessionId = asString(session?.agentSessionId);
  if (!sessionId) {
    throw new Error("sandbox-agent session is missing native agentSessionId");
  }
  if (sessionId) {
    await input.onSessionId?.(sessionId);
  }

  let eventWriteChain = Promise.resolve();
  let agentMessageText = "";

  const appendSessionEvent = async (event: SandboxAgentSessionEvent) => {
    if (!isAgentThoughtChunkEvent(event)) {
      await appendScanRuntimeFile(input.jsonlPath, formatSandboxAgentSessionEvent(event));
    }
    const rendered = renderSandboxAgentEvent(event);
    if (rendered) {
      await appendScanRuntimeFile(input.textPath, rendered);
    }

    const update = getEventUpdate(event);
    const payloadRecord = asRecord(update);
    if (asString(payloadRecord?.sessionUpdate) === "agent_message_chunk") {
      agentMessageText += extractPayloadText(update);
    }
  };

  const handlePermissionEvent = async (event: SandboxAgentSessionEvent) => {
    const payload = getEventPayloadRecord(event);
    if (asString(payload?.method) !== "session/request_permission") {
      return;
    }
    const params = getEventParamsRecord(event) || {};
    await autoApprovePermissionRequest(session, input.stderrPath, {
      ...params,
      id: asString(payload?.id) || asString(params.id) || undefined,
    });
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
    void handlePermissionEvent(event).catch(async (error) => {
      await appendScanRuntimeFile(
        input.stderrPath,
        `[sandbox-agent-permission] ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      ).catch(() => {});
    });
  });

  session.onPermissionRequest((request: Record<string, unknown>) => {
    void autoApprovePermissionRequest(session, input.stderrPath, request);
  });

  try {
    const promptResponse = await withTimeout(
      session.prompt([{ type: "text", text: input.prompt }]),
      SANDBOX_AGENT_PROMPT_TIMEOUT_MS,
      () =>
        new Error(
          `sandbox-agent session.prompt timed out after ${Math.round(
            SANDBOX_AGENT_PROMPT_TIMEOUT_MS / 1000,
          )}s`,
        ),
    );
    const promptUsage = asRecord(promptResponse)?.usage ?? null;
    await writeFile(
      input.usagePath,
      `${JSON.stringify(promptUsage, null, 2)}\n`,
      "utf-8",
    );
    await eventWriteChain;
  } catch (error) {
    const message = error instanceof Error ? error.message : "sandbox-agent prompt failed";
    await eventWriteChain.catch(() => {});
    await appendScanRuntimeFile(input.stderrPath, `[sandbox-agent] ${message}\n`);
    throw error;
  } finally {
    try {
      await (session as { close: () => Promise<void> }).close();
    } catch (error) {
      await appendScanRuntimeFile(
        input.stderrPath,
        `[sandbox-agent-cleanup] session.close failed: ${
          error instanceof Error ? error.message : "unknown error"
        }\n`,
      ).catch(() => {});
    }
    try {
      await (client as { close: () => Promise<void> }).close();
    } catch (error) {
      await appendScanRuntimeFile(
        input.stderrPath,
        `[sandbox-agent-cleanup] client.close failed: ${
          error instanceof Error ? error.message : "unknown error"
        }\n`,
      ).catch(() => {});
    }
  }

  return {
    sessionId,
    rawOutput: agentMessageText,
  };
};
