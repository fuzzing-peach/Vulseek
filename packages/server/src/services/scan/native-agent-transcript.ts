import { readdir } from "node:fs/promises";
import path from "node:path";

export type NativeAgentTranscriptProvider = "codex" | "claude-code";

type FindNativeAgentTranscriptInput = {
	roots: string[];
	provider: NativeAgentTranscriptProvider;
	threadId: string | null | undefined;
};

export const buildNativeAgentTranscriptRoots = ({
	runtimeDir,
	scanJobId,
}: {
	runtimeDir: string;
	scanJobId: string;
}) => {
	const resolved = path.resolve(runtimeDir);
	const parts = resolved.split(path.sep);
	const scanJobIndex = parts.lastIndexOf(scanJobId);
	if (scanJobIndex <= 0 || parts[scanJobIndex - 1] !== "jobs") {
		return [];
	}
	return [parts.slice(0, scanJobIndex + 1).join(path.sep)];
};

const isSafeThreadId = (threadId: string) =>
	threadId.length > 0 &&
	threadId !== "." &&
	threadId !== ".." &&
	!/[\\/]/.test(threadId);

const matchesTranscript = (
	name: string,
	provider: NativeAgentTranscriptProvider,
	threadId: string,
) => {
	if (!name.endsWith(".jsonl")) {
		return false;
	}

	if (provider === "claude-code") {
		return name === `${threadId}.jsonl`;
	}

	return (
		name.startsWith("rollout-") && name.slice(0, -6).endsWith(`-${threadId}`)
	);
};

const findInDirectory = async (
	directory: string,
	provider: NativeAgentTranscriptProvider,
	threadId: string,
): Promise<string | null> => {
	const entries = await readdir(directory, { withFileTypes: true }).catch(
		() => [],
	);
	for (const entry of entries) {
		const entryPath = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			const match = await findInDirectory(entryPath, provider, threadId);
			if (match) {
				return match;
			}
			continue;
		}
		if (entry.isFile() && matchesTranscript(entry.name, provider, threadId)) {
			return entryPath;
		}
	}
	return null;
};

export const findNativeAgentTranscript = async ({
	roots,
	provider,
	threadId,
}: FindNativeAgentTranscriptInput): Promise<string | null> => {
	if (!threadId || !isSafeThreadId(threadId)) {
		return null;
	}

	const directoryName = provider === "codex" ? "sessions" : "projects";
	for (const root of roots) {
		const match = await findInDirectory(
			path.join(root, "agent-home", directoryName),
			provider,
			threadId,
		);
		if (match) {
			return match;
		}
	}
	return null;
};
