import { promises as fs } from "node:fs";
import path from "node:path";

const PROGRESS_JSONL_CONTAINER_PATH = "/task/fuzz-progress.jsonl";
const PROGRESS_JSONL_FILE_NAME = "fuzz-progress.jsonl";
const SOURCE_FILE_LIMIT = 300;

const asRecord = (value: unknown): Record<string, unknown> | null =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;

const asString = (value: unknown) =>
	typeof value === "string" ? value : null;

const readOutputEnvelope = async (taskDir: string) => {
	const outputPath = path.join(taskDir, "output.json");
	const parsed = JSON.parse(await fs.readFile(outputPath, "utf-8")) as unknown;
	const envelope = asRecord(parsed);
	const output = asRecord(envelope?.output);
	if (!output) {
		throw new Error("Fuzzer output.json is missing an output object");
	}
	return output;
};

const resolveTaskContainerPath = (taskDir: string, containerPath: string) => {
	if (containerPath === "/task") {
		return taskDir;
	}
	if (containerPath.startsWith("/task/")) {
		return path.join(taskDir, containerPath.slice("/task/".length));
	}
	if (!path.isAbsolute(containerPath)) {
		return path.join(taskDir, containerPath);
	}
	return null;
};

const isSourceFile = (filePath: string) =>
	filePath.endsWith(".rs") || path.basename(filePath) === "Cargo.toml";

const shouldSkipDirectory = (name: string) =>
	new Set([
		"target",
		"agent-home",
		"session-store",
		"parent-session-store",
		".git",
		".codex",
		".codex-fuzz-build",
		".codex-fuzz-run",
	]).has(name);

const collectSourceText = async (rootDir: string) => {
	const chunks: string[] = [];
	let fileCount = 0;

	const walk = async (dir: string) => {
		if (fileCount >= SOURCE_FILE_LIMIT) {
			return;
		}
		let entries: Array<{
			name: string;
			isDirectory: () => boolean;
			isFile: () => boolean;
		}> = [];
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (fileCount >= SOURCE_FILE_LIMIT) {
				return;
			}
			const entryPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (!shouldSkipDirectory(entry.name)) {
					await walk(entryPath);
				}
				continue;
			}
			if (!entry.isFile() || !isSourceFile(entryPath)) {
				continue;
			}
			fileCount += 1;
			try {
				chunks.push(await fs.readFile(entryPath, "utf-8"));
			} catch {
				// Ignore unreadable generated files; the required markers must be in readable source.
			}
		}
	};

	await walk(rootDir);
	return chunks.join("\n");
};

const requireCondition = (condition: boolean, message: string) => {
	if (!condition) {
		throw new Error(message);
	}
};

export const validateFuzzBuildCompliance = async (taskDir: string) => {
	const output = await readOutputEnvelope(taskDir);
	if (output.status !== "built") {
		return;
	}

	requireCondition(
		output.usesLibAfl === true,
		"Built fuzzer must declare usesLibAfl=true",
	);
	requireCondition(
		output.usesJsonlPrintingMonitor === true,
		"Built fuzzer must declare usesJsonlPrintingMonitor=true",
	);
	requireCondition(
		output.progressJsonlPath === PROGRESS_JSONL_CONTAINER_PATH,
		`Built fuzzer must declare progressJsonlPath=${PROGRESS_JSONL_CONTAINER_PATH}`,
	);

	const cratePath =
		asString(output.cratePath) || asString(output.executablePath) || "/task";
	const crateHostPath = resolveTaskContainerPath(taskDir, cratePath);
	requireCondition(
		Boolean(crateHostPath),
		`Built fuzzer cratePath must be under /task: ${cratePath}`,
	);

	const stat = await fs.stat(crateHostPath as string).catch(() => null);
	requireCondition(
		Boolean(stat),
		`Built fuzzer cratePath does not exist: ${cratePath}`,
	);
	const sourceRoot = stat?.isDirectory()
		? (crateHostPath as string)
		: path.dirname(crateHostPath as string);
	const sourceText = await collectSourceText(sourceRoot);

	for (const marker of [
		"StdFuzzer",
		"StdState",
		"EventManager",
		"JSONLPrintingMonitor",
		PROGRESS_JSONL_FILE_NAME,
	]) {
		requireCondition(
			sourceText.includes(marker),
			`Built fuzzer source is missing required LibAFL marker: ${marker}`,
		);
	}
	requireCondition(
		/Executor/.test(sourceText),
		"Built fuzzer source is missing a LibAFL executor",
	);
};

export const validateFuzzRunCompliance = async (taskDir: string) => {
	const output = await readOutputEnvelope(taskDir);
	requireCondition(
		output.usedLibAflMonitor === true,
		"Fuzz run must declare usedLibAflMonitor=true",
	);
	requireCondition(
		output.progressJsonlPath === PROGRESS_JSONL_CONTAINER_PATH,
		`Fuzz run must declare progressJsonlPath=${PROGRESS_JSONL_CONTAINER_PATH}`,
	);
	requireCondition(
		typeof output.progressJsonlRecords === "number" &&
			Number.isInteger(output.progressJsonlRecords) &&
			output.progressJsonlRecords > 0,
		"Fuzz run must declare progressJsonlRecords > 0",
	);

	const progressPath = path.join(taskDir, PROGRESS_JSONL_FILE_NAME);
	const content = await fs.readFile(progressPath, "utf-8").catch((error) => {
		throw new Error(
			`Fuzz run must write ${PROGRESS_JSONL_CONTAINER_PATH}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	});
	const lines = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	requireCondition(lines.length > 0, "Fuzz progress JSONL must not be empty");
	requireCondition(
		output.progressJsonlRecords === lines.length,
		`Fuzz run progressJsonlRecords (${output.progressJsonlRecords}) does not match actual JSONL record count (${lines.length})`,
	);

	for (const line of lines) {
		const record = asRecord(JSON.parse(line));
		requireCondition(Boolean(record), "Fuzz progress JSONL record must be an object");
		for (const key of [
			"timestamp",
			"eventMsg",
			"senderId",
			"runTimeMs",
			"corpusSize",
			"objectiveSize",
			"totalExecs",
			"execsPerSec",
			"userStats",
		]) {
			requireCondition(
				Object.prototype.hasOwnProperty.call(record, key),
				`Fuzz progress JSONL record is missing monitor field: ${key}`,
			);
		}
	}
};
