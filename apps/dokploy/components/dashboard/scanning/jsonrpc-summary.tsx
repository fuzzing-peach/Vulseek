import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef } from "react";

export type JsonRpcStreamMessage = {
	line: number;
	timestamp?: string;
	message: Record<string, unknown>;
};

type SummaryLine = {
	id: string;
	kind:
		| "session"
		| "prompt"
		| "system"
		| "reasoning"
		| "command"
		| "command_subtitle"
		| "command_output"
		| "agent"
		| "error";
	text: string;
};

const AUTO_SCROLL_BOTTOM_THRESHOLD_PX = 16;
const SUMMARY_REASONING_MAX = 420;
const SUMMARY_AGENT_MAX = 600;
const SUMMARY_AGENT_LIVE_MAX = 420;
const SUMMARY_PROMPT_MAX = 1600;

const isContainerNearBottom = (container: HTMLDivElement) =>
	container.scrollHeight - container.scrollTop - container.clientHeight <=
	AUTO_SCROLL_BOTTOM_THRESHOLD_PX;

const scrollContainerToBottom = (container: HTMLDivElement) => {
	container.scrollTop = container.scrollHeight;
};

const trimSummary = (value: string, max = 220) => {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) {
		return "";
	}
	return normalized.length > max
		? `${normalized.slice(0, Math.max(0, max - 3))}...`
		: normalized;
};

const trimMultiline = (value: string, max = 220) => {
	const normalized = value.replace(/\r\n/g, "\n").trim();
	if (!normalized) {
		return "";
	}
	return normalized.length > max
		? `${normalized.slice(0, Math.max(0, max - 3))}...`
		: normalized;
};

const summarizeCommandResult = (input: string, command: string) => {
	const summary = trimSummary(input, 240);
	if (!summary) {
		return "";
	}

	const normalizedCommand = trimSummary(command, 240);
	if (normalizedCommand && summary === normalizedCommand) {
		return "";
	}

	if (normalizedCommand && summary === `$ ${normalizedCommand}`) {
		return "";
	}

	return summary;
};

const getStringField = (
	record: Record<string, unknown> | null | undefined,
	key: string,
) => (record && typeof record[key] === "string" ? (record[key] as string) : "");

const getObjectField = (
	record: Record<string, unknown> | null | undefined,
	key: string,
) =>
	record && record[key] && typeof record[key] === "object"
		? (record[key] as Record<string, unknown>)
		: null;

const extractWebToolDetail = (update: Record<string, unknown>): string => {
	const rawInput =
		update.rawInput && typeof update.rawInput === "object"
			? (update.rawInput as Record<string, unknown>)
			: null;
	if (!rawInput) {
		return "";
	}

	const action =
		rawInput.action && typeof rawInput.action === "object"
			? (rawInput.action as Record<string, unknown>)
			: null;
	const argumentsRecord =
		rawInput.arguments && typeof rawInput.arguments === "object"
			? (rawInput.arguments as Record<string, unknown>)
			: null;

	const firstStringFromArray = (value: unknown, preferredKeys: string[] = []) => {
		if (!Array.isArray(value)) {
			return "";
		}

		for (const entry of value) {
			if (typeof entry === "string" && entry.trim()) {
				return entry;
			}
			if (!entry || typeof entry !== "object") {
				continue;
			}
			const record = entry as Record<string, unknown>;
			for (const key of preferredKeys) {
				const next = getStringField(record, key);
				if (next.trim()) {
					return next;
				}
			}
		}

		return "";
	};

	const query =
		getStringField(action, "query") ||
		getStringField(argumentsRecord, "query") ||
		getStringField(argumentsRecord, "q") ||
		getStringField(rawInput, "query") ||
		firstStringFromArray(getObjectField(argumentsRecord, "action")?.queries, ["q", "query"]) ||
		firstStringFromArray(argumentsRecord?.queries, ["q", "query"]) ||
		(Array.isArray(action?.queries)
			? action?.queries.find((entry) => typeof entry === "string") || ""
			: "");
	if (typeof query === "string" && query.trim()) {
		return trimSummary(query, 160);
	}

	const url =
		getStringField(action, "url") ||
		getStringField(argumentsRecord, "url") ||
		getStringField(rawInput, "url") ||
		firstStringFromArray(action?.urls, ["url", "href"]) ||
		firstStringFromArray(argumentsRecord?.urls, ["url", "href"]) ||
		firstStringFromArray(argumentsRecord?.links, ["url", "href"]);
	if (url.trim()) {
		return trimSummary(url, 180);
	}

	return "";
};

export const extractJsonRpcSummaryLines = (
	messages: JsonRpcStreamMessage[],
): SummaryLine[] => {
	const lines: SummaryLine[] = [];
	const commandOutputByItemId = new Map<string, string>();
	const reasoningByItemId = new Map<string, string>();
	const commandByItemId = new Map<string, string>();
	const pendingTerminalToolCallIds = new Set<string>();
	const reasoningLineIndexByItemId = new Map<string, number>();
	const agentMessageByItemId = new Map<string, string>();
	const agentLineIndexByItemId = new Map<string, number>();

	const getTextContent = (value: unknown): string => {
		if (!value) {
			return "";
		}
		if (typeof value === "string") {
			return value;
		}
		if (Array.isArray(value)) {
			return value
				.map((entry) => {
					if (!entry || typeof entry !== "object") {
						return "";
					}
					const record = entry as Record<string, unknown>;
					if (typeof record.text === "string") {
						return record.text;
					}
					if (
						record.content &&
						typeof record.content === "object" &&
						typeof (record.content as Record<string, unknown>).text === "string"
					) {
						return (record.content as Record<string, unknown>).text as string;
					}
					return "";
				})
				.filter(Boolean)
				.join("\n");
		}
		if (typeof value === "object") {
			const record = value as Record<string, unknown>;
			if (typeof record.text === "string") {
				return record.text;
			}
			if (
				record.content &&
				typeof record.content === "object" &&
				typeof (record.content as Record<string, unknown>).text === "string"
			) {
				return (record.content as Record<string, unknown>).text as string;
			}
		}
		return "";
	};

	for (const entry of messages) {
		const message = entry.message;
		const method = typeof message.method === "string" ? message.method : "";
		const params = (message.params as Record<string, unknown> | undefined) || {};

		if (method === "session/prompt") {
			const sessionId =
				typeof params.sessionId === "string" ? params.sessionId : "";
			const prompt = trimMultiline(
				getTextContent(params.prompt),
				SUMMARY_PROMPT_MAX,
			);
			if (sessionId) {
				lines.push({
					id: `session-${sessionId}-${entry.line}`,
					kind: "session",
					text: `session ${sessionId}`,
				});
			}
			if (prompt) {
				lines.push({
					id: `prompt-${sessionId || entry.line}`,
					kind: "prompt",
					text: prompt,
				});
			}
			continue;
		}

		if (method === "session/update") {
			const sessionId =
				typeof params.sessionId === "string" ? params.sessionId : "session";
			const update =
				(params.update as Record<string, unknown> | undefined) || {};
			const sessionUpdate =
				typeof update.sessionUpdate === "string" ? update.sessionUpdate : "";

			if (sessionUpdate === "agent_message_chunk") {
				const delta = getTextContent(update.content);
				if (delta) {
					const itemId = `${sessionId}-agent`;
					const next = `${agentMessageByItemId.get(itemId) || ""}${delta}`;
					agentMessageByItemId.set(itemId, next);
					const summary = trimSummary(next, SUMMARY_AGENT_LIVE_MAX);
					if (summary) {
						const lineIndex = agentLineIndexByItemId.get(itemId);
						if (lineIndex !== undefined) {
							lines[lineIndex] = {
								id: itemId,
								kind: "agent",
								text: summary,
							};
						} else {
							agentLineIndexByItemId.set(itemId, lines.length);
							lines.push({
								id: itemId,
								kind: "agent",
								text: summary,
							});
						}
					}
				}
				continue;
			}

			if (sessionUpdate === "tool_call") {
				const toolCallId =
					typeof update.toolCallId === "string"
						? update.toolCallId
						: `tool-${entry.line}`;
					const title =
						typeof update.title === "string"
							? update.title
							: typeof update.rawInput === "object" && update.rawInput
								? trimSummary(
										`${String((update.rawInput as Record<string, unknown>).server || "tool")}/${String((update.rawInput as Record<string, unknown>).tool || "call")}`,
										240,
									)
								: "tool";
						const normalizedToolTitle =
							title === "Terminal" ? "Command" : title;
						if (title === "Terminal") {
							pendingTerminalToolCallIds.add(toolCallId);
							continue;
						}
						const normalizedTitle = normalizedToolTitle.toLowerCase();
						const text = normalizedTitle.includes("skill")
							? "Skill"
							: normalizedToolTitle.startsWith("mcp_")
								? "MCP"
								: normalizedToolTitle;
						lines.push({
							id: toolCallId,
							kind: "command",
						text,
					});
				continue;
			}

				if (sessionUpdate === "tool_call_update") {
					const toolCallId =
						typeof update.toolCallId === "string" ? update.toolCallId : "";
					if (toolCallId && pendingTerminalToolCallIds.has(toolCallId)) {
						continue;
				}
					const output = trimSummary(
						getTextContent(update.content) ||
								getTextContent(update.rawOutput),
							240,
						);
						if (output) {
							lines.push({
								id: `${toolCallId || "tool"}-output-${entry.line}`,
								kind: "command_output",
							text: output,
					});
				}
				continue;
			}

			if (sessionUpdate === "plan") {
				const text = trimSummary(getTextContent(update.content), 240);
				if (text) {
					lines.push({
						id: `line-${entry.line}`,
						kind: "agent",
						text,
					});
				}
				continue;
			}
		}

		if (
			method === "item/reasoning/textDelta" ||
			method === "item/reasoning/summaryTextDelta"
		) {
			const itemId = typeof params.itemId === "string" ? params.itemId : "";
			const delta = typeof params.delta === "string" ? params.delta : "";
			if (itemId && delta) {
				reasoningByItemId.set(
					itemId,
					`${reasoningByItemId.get(itemId) || ""}${delta}`,
				);
			}
			continue;
		}

		if (method === "item/commandExecution/outputDelta") {
			const itemId = typeof params.itemId === "string" ? params.itemId : "";
			const delta = typeof params.delta === "string" ? params.delta : "";
			if (itemId && delta) {
				commandOutputByItemId.set(
					itemId,
					`${commandOutputByItemId.get(itemId) || ""}${delta}`,
				);
			}
			continue;
		}

		if (method === "item/agentMessage/delta") {
			const itemId = typeof params.itemId === "string" ? params.itemId : "";
			const delta = typeof params.delta === "string" ? params.delta : "";
			if (itemId && delta) {
				const next = `${agentMessageByItemId.get(itemId) || ""}${delta}`;
				agentMessageByItemId.set(itemId, next);
				const summary = trimSummary(next, SUMMARY_AGENT_LIVE_MAX);
				if (summary) {
					const lineIndex = agentLineIndexByItemId.get(itemId);
					if (lineIndex !== undefined) {
						lines[lineIndex] = {
							id: itemId,
							kind: "agent",
							text: summary,
						};
					} else {
						agentLineIndexByItemId.set(itemId, lines.length);
						lines.push({
							id: itemId,
							kind: "agent",
							text: summary,
						});
					}
				}
			}
			continue;
		}

			if (method === "item/started") {
				const item = (params.item as Record<string, unknown> | undefined) || {};
				const itemType = typeof item.type === "string" ? item.type : "";
				const itemId = typeof item.id === "string" ? item.id : "";
				if (itemType === "commandExecution") {
					const rawCommand =
						typeof item.command === "string" ? trimSummary(item.command) : "";
					if (itemId && rawCommand) {
						commandByItemId.set(itemId, rawCommand);
						pendingTerminalToolCallIds.delete(itemId);
					}
					if (rawCommand) {
						lines.push({
							id: `line-${entry.line}`,
							kind: "command",
							text: `$ ${rawCommand}`,
						});
					}
					continue;
				}
			if (itemType === "reasoning") {
				const lineId = itemId || `line-${entry.line}`;
				reasoningLineIndexByItemId.set(lineId, lines.length);
				lines.push({
					id: lineId,
					kind: "reasoning",
					text: "[reasoning]",
				});
				continue;
			}
		}

			if (method === "item/completed") {
				const item = (params.item as Record<string, unknown> | undefined) || {};
				const itemType = typeof item.type === "string" ? item.type : "";
				const itemId = typeof item.id === "string" ? item.id : "";

				if (itemType === "commandExecution") {
					const aggregatedOutput =
						typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : "";
					const hadConcreteCommand = commandByItemId.has(itemId);
					const command = commandByItemId.get(itemId) || "Command";
					if (!hadConcreteCommand) {
						lines.push({
							id: `${itemId || "command"}-fallback-${entry.line}`,
							kind: "command",
							text: "$ Command",
						});
					}
					if (itemId) {
						pendingTerminalToolCallIds.delete(itemId);
					}
					const output = summarizeCommandResult(
						aggregatedOutput || commandOutputByItemId.get(itemId) || "",
						command,
				);
				if (output) {
					lines.push({
						id: `${itemId}-output-${entry.line}`,
						kind: "command_output",
						text: output,
					});
				} else {
					const status =
						typeof item.status === "string" ? item.status.toLowerCase() : "completed";
					lines.push({
						id: `${itemId}-done-${entry.line}`,
						kind: status === "failed" ? "error" : "command_output",
						text:
							status === "failed"
								? `${command} failed`
								: `${command} finished without output`,
					});
				}
				commandOutputByItemId.delete(itemId);
				commandByItemId.delete(itemId);
				continue;
			}

			if (itemType === "reasoning") {
				const summary = trimSummary(
					reasoningByItemId.get(itemId) || "",
					SUMMARY_REASONING_MAX,
				);
				const lineIndex = reasoningLineIndexByItemId.get(itemId);
				if (lineIndex !== undefined) {
					lines[lineIndex] = {
						id: itemId,
						kind: "reasoning",
						text: summary || "[reasoning completed]",
					};
					reasoningLineIndexByItemId.delete(itemId);
				} else {
					lines.push({
						id: `${itemId}-reasoning-${entry.line}`,
						kind: "reasoning",
						text: summary || "[reasoning completed]",
					});
				}
				reasoningByItemId.delete(itemId);
				continue;
			}

			if (itemType === "agentMessage") {
				const text =
					typeof item.text === "string"
						? item.text
						: agentMessageByItemId.get(itemId) || "";
				const summary = trimSummary(text, SUMMARY_AGENT_MAX);
				if (summary) {
					const lineIndex = agentLineIndexByItemId.get(itemId);
					if (lineIndex !== undefined) {
						lines[lineIndex] = {
							id: itemId,
							kind: "agent",
							text: summary,
						};
						agentLineIndexByItemId.delete(itemId);
					} else {
						lines.push({
							id: `${itemId}-agent-${entry.line}`,
							kind: "agent",
							text: summary,
						});
					}
				}
				agentMessageByItemId.delete(itemId);
				continue;
			}
		}

		if (method === "error") {
			const error = (params.error as Record<string, unknown> | undefined) || {};
			const errorMessage =
				typeof error.message === "string"
					? error.message
					: typeof params.message === "string"
						? params.message
						: "Unknown error";
			lines.push({
				id: `line-${entry.line}`,
				kind: "error",
				text: `[error] ${trimSummary(errorMessage, 240)}`,
			});
		}
	}

	return lines;
};

const getSummaryLineClassName = (line: SummaryLine) => {
	if (line.kind === "session") {
		return "text-xs font-semibold uppercase tracking-wide text-slate-500";
	}

	if (line.kind === "prompt") {
		return "text-sm font-normal text-violet-700";
	}

	if (line.kind === "reasoning") {
		return line.text === "[reasoning started]"
			? "text-sm font-medium italic text-amber-700/90"
			: "text-sm font-medium text-amber-700/90";
	}

	if (line.kind === "error") {
		return "text-sm font-semibold text-destructive";
	}

	if (line.kind === "command_output") {
		return "text-sm font-normal text-emerald-700/95";
	}

	if (line.kind === "command") {
		return "text-sm font-semibold tracking-tight text-sky-700";
	}

	if (line.kind === "command_subtitle") {
		return "text-xs font-medium text-slate-500";
	}

	if (line.kind === "agent") {
		return "text-sm font-normal text-slate-700";
	}

	return "text-sm font-medium text-muted-foreground";
};

const getSummaryLinePrefix = (line: SummaryLine) => {
	if (line.kind === "session") {
		return "#";
	}

	if (line.kind === "prompt") {
		return "<";
	}

	if (line.kind === "command") {
		return "$";
	}

	if (line.kind === "command_subtitle") {
		return ">";
	}

	return ">";
};

const renderSummaryLineContent = (line: SummaryLine) => {
	const content = line.text;

	return (
		<div className="grid grid-cols-[20px_minmax(0,1fr)] gap-3">
			<div className="text-center text-muted-foreground/80">
				{getSummaryLinePrefix(line)}
			</div>
			<div
				className="line-clamp-3 whitespace-pre-wrap break-words"
				title={
					line.kind === "command" ||
					line.kind === "command_subtitle" ||
					line.kind === "prompt"
						? content
						: undefined
				}
			>
				{content}
			</div>
		</div>
	);
};

export const JsonRpcSummaryPanel = ({
	messages,
	emptyLabel = "No agent output yet",
	className = "",
	maxHeightClassName = "max-h-40",
}: {
	messages: JsonRpcStreamMessage[];
	emptyLabel?: string;
	className?: string;
	maxHeightClassName?: string;
}) => {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const autoScrollRef = useRef(true);
	const summaryLines = extractJsonRpcSummaryLines(messages);

	useEffect(() => {
		const container = containerRef.current;
		if (!container || !autoScrollRef.current) {
			return;
		}
		scrollContainerToBottom(container);
	}, [summaryLines]);

	return (
		<div
			ref={containerRef}
			onScroll={(event) => {
				autoScrollRef.current = isContainerNearBottom(event.currentTarget);
			}}
			className={`${maxHeightClassName} min-w-[520px] overflow-y-auto rounded-md border bg-muted/20 px-3 py-2 ${className}`}
		>
			<div className="space-y-3 font-mono text-sm leading-6">
				<AnimatePresence initial={false}>
					{summaryLines.length === 0 ? (
						<motion.div
							key="empty"
							initial={{ opacity: 0, y: 6 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -4 }}
							className="text-muted-foreground"
						>
							{emptyLabel}
						</motion.div>
					) : (
						summaryLines.map((line) => (
							<motion.div
								key={line.id}
								layout="position"
								initial={{ opacity: 0, y: 6 }}
								animate={{ opacity: 1, y: 0 }}
								exit={{ opacity: 0, y: -4 }}
								transition={{
									duration: 0.18,
									ease: "easeOut",
								}}
								className={`whitespace-pre-wrap break-words ${getSummaryLineClassName(line)}`}
							>
								{renderSummaryLineContent(line)}
							</motion.div>
						))
					)}
				</AnimatePresence>
			</div>
		</div>
	);
};
