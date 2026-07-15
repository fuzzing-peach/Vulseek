import { promises as fs } from "node:fs";
import path from "node:path";
import { getGlobalContainerEnvironmentPairs } from "../../../utils/docker/utils";
import { execAsync } from "../../../utils/process/execAsync";
import { getAgentProfileById } from "../../ai";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import { findStageLaneRuntimeByTaskIdRepo } from "../persistence/stage-lane-runtime.repo";
import { findTaskByIdRepo, updateTaskRepo } from "../persistence/task.repo";
import type { StructuredOutputSchemaSource } from "../pipeline/scan-pipeline-schema-contracts";
import { getRuntimeStageSetting } from "../runtime-settings";
import { writeScanJobSecurityPolicyArtifact } from "../security-policy-artifact";
import { SCAN_STAGE_IDS } from "../stage-metadata";
import { resolveStageTaskName } from "../stage-task-name";
import {
	resolveStageLaneRootSegment,
	resolveTaskRootSegment,
} from "../stages/full-scan-stage.runtime";
import type { AgentProfileLike, ScanJob } from "../types";
import {
	AGENT_RUNTIME_FILE_NAMES,
	initializeAgentRuntimeFiles,
} from "./agent-runtime-files";
import { sanitizeCodexAcpConfigToml } from "./codex-config-compat";
import { installRuntimeSkillsInContainer } from "./runtime-skills";
import {
	buildStructuredOutputEnvelopeJsonSchema,
	buildStructuredOutputPromptSuffix,
	type RouteOutputSchema,
} from "./structured-output-schema";

export { buildStructuredOutputPromptSuffix } from "./structured-output-schema";

const RUNTIME_CUSTOM_SKILLS = [
	"codeql",
	"semgrep",
	"delta-scope",
	"full-scan",
	"full-scan-subagent",
	"repository-profile",
	"attack-surface-model",
	"identify-target",
	"scan-target",
	"analyze-finding",
	"critique-finding",
	"verify-finding",
	"search-registries",
	"tree-sitter",
] as const;

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const TASK_ALIAS_ROOT_IN_CONTAINER = "/task";
const STRUCTURED_OUTPUT_SCHEMA_FILE_NAME = "output.schema.json";
const STRUCTURED_OUTPUT_RESULT_FILE_NAME = "output.json";
const CODEX_HOME_IN_CONTAINER = "/root/.codex";
const CLAUDE_HOME_IN_CONTAINER = "/root/.claude";
const PERSISTENT_DRIVER_HEALTH_MAX_IDLE_MS = Number.parseInt(
	process.env.VULSEEK_PERSISTENT_DRIVER_HEALTH_MAX_IDLE_MS || "120000",
	10,
);

const sanitizeForImageTag = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9_.-]/g, "-")
		.replace(/-+/g, "-");

const toImageTagFromAppName = (appName: string) =>
	`vulseek-scan-${sanitizeForImageTag(appName)}:latest`;

const sanitizeContextPathPart = (value: string) =>
	value
		.replace(/[\\/]+/g, "-")
		.replace(/[^a-zA-Z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "unknown";

const buildProjectProfileContextRoot = () => TASK_ALIAS_ROOT_IN_CONTAINER;
const buildProjectProfileCacheRoot = () =>
	path.posix.join(buildProjectProfileContextRoot(), "cache");

const escapeSingleQuotes = (value: string) => value.replace(/'/g, `'\"'\"'`);

const buildNamespaceEnabledContainerArgs = () => {
	const configured = process.env.VULSEEK_SCAN_CONTAINER_EXTRA_ARGS?.trim();
	if (configured) {
		return configured;
	}

	return [
		"--security-opt seccomp=unconfined",
		"--security-opt apparmor=unconfined",
		"--cap-add SYS_ADMIN",
	].join(" ");
};

let cachedCurrentDockerNetworkName: string | null | undefined;

const resolveCurrentDockerNetworkName = async () => {
	if (cachedCurrentDockerNetworkName !== undefined) {
		return cachedCurrentDockerNetworkName;
	}

	try {
		const { stdout } = await execAsync(
			"docker inspect $(hostname) --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'",
		);
		const networkName =
			stdout
				.split("\n")
				.map((value) => value.trim())
				.find((value) => value.length > 0) || null;
		cachedCurrentDockerNetworkName = networkName;
		return networkName;
	} catch {
		cachedCurrentDockerNetworkName = null;
		return null;
	}
};

const resolveCurrentDockerNetworkArg = async () => {
	const networkName = await resolveCurrentDockerNetworkName();
	return networkName ? `--network ${networkName}` : "";
};

const sanitizeProviderName = (value: string) =>
	value.toLowerCase().replace(/[^a-z0-9_-]/g, "-") || "provider";

const CODEX_AUTO_APPROVE_CONFIG_TOML = [
	`approval_policy = "never"`,
	`sandbox_mode = "danger-full-access"`,
	"",
].join("\n");
const AGENT_HOME_HOST_MOUNT_PATH = "/host-agent-home";

const resolveAgentAuthMode = (
	agentProfile: AgentProfileLike | null | undefined,
) => (agentProfile?.authMode === "host_home" ? "host_home" : "api_key");

const resolveAgentHomeHostPath = (
	agentProfile: AgentProfileLike | null | undefined,
) => agentProfile?.homePath?.trim() || "";

const buildAgentHomeHostMountArg = (
	agentProfile: AgentProfileLike | null | undefined,
) => {
	if (!agentProfile) {
		return "";
	}
	if (resolveAgentAuthMode(agentProfile) !== "host_home") {
		return "";
	}
	const hostPath = resolveAgentHomeHostPath(agentProfile);
	if (!hostPath) {
		return "";
	}
	return `-v '${escapeSingleQuotes(hostPath)}:${AGENT_HOME_HOST_MOUNT_PATH}:ro'`;
};

const withCodexAutoApproveConfigToml = (configToml: string) => {
	const defaults: string[] = [];
	if (!/^\s*approval_policy\s*=/m.test(configToml)) {
		defaults.push(`approval_policy = "never"`);
	}
	if (!/^\s*sandbox_mode\s*=/m.test(configToml)) {
		defaults.push(`sandbox_mode = "danger-full-access"`);
	}
	if (defaults.length === 0) {
		return configToml;
	}
	return joinTomlBlocks(`${defaults.join("\n")}\n`, configToml);
};

const stripProfileControlledCodexConfigToml = (configToml: string) => {
	let seenTable = false;
	return configToml
		.split(/\r?\n/)
		.filter((line) => {
			const trimmed = line.trim();
			if (/^\[.*\]\s*$/.test(trimmed)) {
				seenTable = true;
			}
			return (
				seenTable ||
				!/^\s*(approval_policy|sandbox_mode|model|model_reasoning_effort)\s*=/.test(
					line,
				)
			);
		})
		.join("\n");
};

const withCodexProfileRuntimeConfig = (
	configToml: string,
	agentProfile: AgentProfileLike,
) => {
	const profileConfig = [
		`approval_policy = "never"`,
		`sandbox_mode = "danger-full-access"`,
		`model = "${agentProfile.model}"`,
		...(agentProfile.thinkingLevelEnabled
			? [`model_reasoning_effort = "${agentProfile.thinkingLevel}"`]
			: []),
	].join("\n");

	return joinTomlBlocks(
		profileConfig,
		sanitizeCodexAcpConfigToml(
			stripProfileControlledCodexConfigToml(configToml),
		),
	);
};

const buildCodexConfigToml = (agentProfile: AgentProfileLike) => {
	const providerName = sanitizeProviderName(agentProfile.agentProfileId);
	const reasoningConfig = agentProfile.thinkingLevelEnabled
		? [`model_reasoning_effort = "${agentProfile.thinkingLevel}"`]
		: [];

	return withCodexAutoApproveConfigToml(
		[
			`model = "${agentProfile.model}"`,
			...reasoningConfig,
			`model_provider = "${providerName}"`,
			`preferred_auth_method = "apikey"`,
			"",
			`[model_providers.${providerName}]`,
			`name = "${providerName}"`,
			`base_url = "${agentProfile.baseUrl}"`,
			`wire_api = "responses"`,
			"",
		].join("\n"),
	);
};

const loadCodexMcpConfigToml = async (agentsDir: string | null) => {
	if (!agentsDir) {
		return "";
	}

	const mcpDir = path.join(agentsDir, "mcp");
	try {
		const entries = await fs.readdir(mcpDir, { withFileTypes: true });
		const tomlFiles = entries
			.filter(
				(entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".toml"),
			)
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right));

		if (tomlFiles.length === 0) {
			return "";
		}

		const contents = await Promise.all(
			tomlFiles.map((fileName) =>
				fs.readFile(path.join(mcpDir, fileName), "utf-8"),
			),
		);

		return contents
			.map((content) => content.trim())
			.filter(Boolean)
			.join("\n\n");
	} catch {
		return "";
	}
};

const joinTomlBlocks = (...blocks: Array<string | null | undefined>) =>
	blocks
		.map((block) => (block || "").trim())
		.filter(Boolean)
		.join("\n\n");

const buildCodexAuthJson = (agentProfile: AgentProfileLike) =>
	JSON.stringify(
		{
			OPENAI_API_KEY: agentProfile.apiKey,
		},
		null,
		2,
	);

const copyMountedFileToContainer = async (input: {
	containerName: string;
	sourcePath: string;
	targetPath: string;
	description: string;
}) => {
	await execAsync(
		`docker exec ${input.containerName} bash -lc "test -s '${escapeSingleQuotes(
			input.sourcePath,
		)}' || { echo 'Missing ${escapeSingleQuotes(
			input.description,
		)}: ${escapeSingleQuotes(
			input.sourcePath,
		)}' >&2; exit 1; }; mkdir -p '${escapeSingleQuotes(
			path.posix.dirname(input.targetPath),
		)}' && cp -a '${escapeSingleQuotes(input.sourcePath)}' '${escapeSingleQuotes(
			input.targetPath,
		)}'"`,
	);
};

const loadMountedCodexHomeSourceConfigToml = async (
	containerName: string,
	sourceDir: string,
) => {
	const { stdout } = await execAsync(
		`docker exec ${containerName} bash -lc "cat '${escapeSingleQuotes(
			path.posix.join(sourceDir, "config.toml"),
		)}' 2>/dev/null || true"`,
	);
	return stdout;
};

const parseAgentProfileEnvPairs = (agentProfile: AgentProfileLike) =>
	(agentProfile.envs || "")
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean)
		.flatMap((line) => {
			const separatorIndex = line.indexOf("=");
			if (separatorIndex <= 0) {
				return [];
			}
			const key = line.slice(0, separatorIndex).trim();
			const value = line.slice(separatorIndex + 1);
			if (!key) {
				return [];
			}
			return [`${key}=${value}`];
		});

const envPairsToRecord = (pairs: string[]) =>
	Object.fromEntries(
		pairs.flatMap((pair) => {
			const separatorIndex = pair.indexOf("=");
			return separatorIndex > 0
				? [[pair.slice(0, separatorIndex), pair.slice(separatorIndex + 1)]]
				: [];
		}),
	);

const buildClaudeEnvPairs = (
	agentProfile: AgentProfileLike,
	claudeHome = CLAUDE_HOME_IN_CONTAINER,
) => [
	`CLAUDE_CONFIG_DIR=${claudeHome}`,
	...(resolveAgentAuthMode(agentProfile) === "api_key"
		? [
				`ANTHROPIC_BASE_URL=${agentProfile.baseUrl}`,
				`ANTHROPIC_API_KEY=${agentProfile.apiKey}`,
				`ANTHROPIC_AUTH_TOKEN=${agentProfile.apiKey}`,
			]
		: []),
	`ANTHROPIC_MODEL=${agentProfile.model}`,
	`ANTHROPIC_DEFAULT_SONNET_MODEL=${agentProfile.model}`,
	`ANTHROPIC_DEFAULT_OPUS_MODEL=${agentProfile.model}`,
	`ANTHROPIC_DEFAULT_HAIKU_MODEL=${agentProfile.model}`,
	"CLAUDE_CODE_ENTRYPOINT=vulseek",
	...parseAgentProfileEnvPairs(agentProfile),
];

const resolveAgentsDirectory = async () => {
	const candidates = [
		path.resolve(process.cwd(), "agents"),
		path.resolve(process.cwd(), "../../agents"),
		"/app/agents",
	];

	for (const candidate of candidates) {
		try {
			const stat = await fs.stat(candidate);
			if (stat.isDirectory()) {
				return candidate;
			}
		} catch {}
	}
	return null;
};

const writeContainerFile = async (
	containerName: string,
	filePath: string,
	content: string,
) => {
	const encoded = Buffer.from(content, "utf-8").toString("base64");
	await execAsync(
		`docker exec ${containerName} bash -lc "mkdir -p '${path.posix.dirname(
			filePath,
		)}' && echo '${encoded}' | base64 -d > '${filePath}'"`,
	);
};

const writeContainerFileAtomically = async (
	containerName: string,
	filePath: string,
	content: string,
) => {
	const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random()
		.toString(16)
		.slice(2)}`;
	await writeContainerFile(containerName, tempPath, content);
	await execAsync(
		`docker exec ${containerName} bash -lc "mv -f '${tempPath}' '${filePath}'"`,
	);
};

const appendContainerFile = async (
	containerName: string,
	filePath: string,
	content: string,
) => {
	const encoded = Buffer.from(content, "utf-8").toString("base64");
	await execAsync(
		`docker exec ${containerName} bash -lc "mkdir -p '${path.posix.dirname(
			filePath,
		)}' && echo '${encoded}' | base64 -d >> '${filePath}'"`,
	);
};

const sleep = async (ms: number) =>
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const appendHostBootstrapLog = async (
	logPath: string | null | undefined,
	message: string,
) => {
	if (!logPath) {
		return;
	}
	await fs
		.appendFile(
			logPath,
			`[acp-driver-bootstrap] ${new Date().toISOString()} ${message}\n`,
			"utf-8",
		)
		.catch(() => {});
};

const truncateLogValue = (value: unknown, maxLength = 4000) => {
	const text = typeof value === "string" ? value : String(value ?? "");
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, maxLength)}...<truncated ${text.length - maxLength} chars>`;
};

const getErrorDiagnostics = (error: unknown) => {
	const record =
		error && typeof error === "object"
			? (error as Record<string, unknown>)
			: {};
	return {
		message: getErrorMessage(error),
		code: record.code ?? null,
		signal: record.signal ?? null,
		cmd: truncateLogValue(record.cmd, 2000) || null,
		stdout: truncateLogValue(record.stdout),
		stderr: truncateLogValue(record.stderr),
	};
};

const withHostBootstrapLog = async <T>(
	logPath: string | null | undefined,
	label: string,
	details: string,
	action: () => Promise<T>,
) => {
	const startedAt = Date.now();
	await appendHostBootstrapLog(
		logPath,
		`${label}_start${details ? ` ${details}` : ""}`,
	);
	try {
		const result = await action();
		await appendHostBootstrapLog(
			logPath,
			`${label}_done elapsed_ms=${Date.now() - startedAt}`,
		);
		return result;
	} catch (error) {
		await appendHostBootstrapLog(
			logPath,
			`${label}_error elapsed_ms=${Date.now() - startedAt} diagnostics=${JSON.stringify(
				getErrorDiagnostics(error),
			)}`,
		);
		throw error;
	}
};

const getErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const execDockerRunWithRetry = async (input: {
	containerName: string;
	command: string;
	taskId?: string;
	logPath?: string | null;
}) => {
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= 6; attempt += 1) {
		try {
			return await execAsync(input.command);
		} catch (error) {
			lastError = error;
			await appendHostBootstrapLog(
				input.logPath,
				`docker_run_attempt_error attempt=${attempt}/6 diagnostics=${JSON.stringify(
					getErrorDiagnostics(error),
				)}`,
			);
			if (input.taskId) {
				await updateTaskRepo(input.taskId, {
					errorMessage: `Docker container launch failed; docker run attempt ${attempt}/6: ${getErrorMessage(error)}`,
				}).catch(() => {});
			}
			await execAsync(`docker rm -f ${input.containerName}`).catch(() => {});
			if (attempt < 6) {
				await sleep(attempt * 2500);
			}
		}
	}
	throw lastError;
};

const resolveConfiguredScanContextHostPath = () =>
	process.env.VULSEEK_SCAN_CONTEXT_HOST_PATH?.trim() || "";

const resolveProjectProfileHostPath = async (input: {
	projectName: string;
	profileName: string;
}) => {
	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured. Restart vulseek-dev from dev.sh so task runtime directories can be created.",
		);
	}

	const hostProfileDir = path.join(
		configuredHostRoot,
		"projects",
		sanitizeContextPathPart(input.projectName),
		"profiles",
		sanitizeContextPathPart(input.profileName),
	);
	await fs.mkdir(hostProfileDir, { recursive: true });
	return hostProfileDir;
};

const resolveMountedProjectProfilePath = (input: {
	projectName: string;
	profileName: string;
}) =>
	path.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"projects",
		sanitizeContextPathPart(input.projectName),
		"profiles",
		sanitizeContextPathPart(input.profileName),
	);

const getTargetMemoryArgs = (target: unknown) => {
	if (!target || typeof target !== "object") {
		return { memoryLimit: null, memoryReservation: null };
	}

	const resourceTarget = target as {
		memoryLimit?: string | null;
		memoryReservation?: string | null;
	};

	return {
		memoryLimit: resourceTarget.memoryLimit || null,
		memoryReservation: resourceTarget.memoryReservation || null,
	};
};

const resolveScanExecutionContext = async (scanJob: ScanJob) => {
	const isApplicationJob = Boolean(scanJob.applicationId);
	const target = isApplicationJob
		? await findApplicationById(scanJob.applicationId as string)
		: await findComposeById(scanJob.composeId as string);
	const repositoryProfileAgentProfileId =
		getRuntimeStageSetting(
			scanJob.scanRuntimeSettings,
			SCAN_STAGE_IDS.repositoryProfile,
		).agentProfileId || null;
	const scanAgentProfile = repositoryProfileAgentProfileId
		? await getAgentProfileById(repositoryProfileAgentProfileId).catch(
				() => null,
			)
		: null;

	const appName = target.appName;
	const imageTag = toImageTagFromAppName(appName);
	const projectName = target.environment.project.name;
	const serviceName = target.name || target.appName;
	const projectProfileContextRoot = buildProjectProfileContextRoot();
	const projectProfileCacheRoot = buildProjectProfileCacheRoot();

	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured. Restart vulseek-dev from dev.sh so /scan-context is mounted.",
		);
	}

	try {
		await execAsync(`docker image inspect ${imageTag}`);
	} catch {
		throw new Error(
			`Checkout image not found: ${imageTag}. Run Checkout before ${scanJob.scanType} scan.`,
		);
	}

	return {
		isApplicationJob,
		target,
		appName,
		imageTag,
		contextVolumeName: target.environment.project.scanContextVolumeName,
		projectName,
		serviceName,
		projectProfileContextRoot,
		projectProfileCacheRoot,
		scanAgentProfile,
	};
};

const copyCodexAssetsToContainerHome = async (
	containerName: string,
	codexHome: string,
	agentsDir: string | null,
	agentProfile?: AgentProfileLike | null,
) => {
	const mcpConfigToml = await loadCodexMcpConfigToml(agentsDir);

	if (agentProfile) {
		if (agentProfile.provider === "codex") {
			if (resolveAgentAuthMode(agentProfile) === "host_home") {
				const hostPath = resolveAgentHomeHostPath(agentProfile);
				if (!hostPath) {
					throw new Error(
						"Codex host home auth mode is enabled but no home path was configured on the agent profile.",
					);
				}
				const sourceConfigToml = await loadMountedCodexHomeSourceConfigToml(
					containerName,
					AGENT_HOME_HOST_MOUNT_PATH,
				);
				await copyMountedFileToContainer({
					containerName,
					sourcePath: path.posix.join(AGENT_HOME_HOST_MOUNT_PATH, "auth.json"),
					targetPath: path.posix.join(codexHome, "auth.json"),
					description: "Codex host home auth.json",
				});
				await writeContainerFile(
					containerName,
					`${codexHome}/config.toml`,
					joinTomlBlocks(
						withCodexProfileRuntimeConfig(sourceConfigToml, agentProfile),
						mcpConfigToml,
					),
				);
				await execAsync(
					`docker exec ${containerName} bash -lc "test -s '${codexHome}/auth.json' && test -s '${codexHome}/config.toml'"`,
				);
				return;
			}
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				joinTomlBlocks(buildCodexConfigToml(agentProfile), mcpConfigToml),
			);
			await writeContainerFile(
				containerName,
				`${codexHome}/auth.json`,
				buildCodexAuthJson(agentProfile),
			);
			await execAsync(
				`docker exec ${containerName} bash -lc "test -s '${codexHome}/auth.json' && test -s '${codexHome}/config.toml'"`,
			);
		}
		return;
	}

	if (!agentsDir) {
		return;
	}

	const codexConfigPath = path.join(agentsDir, "codex-config.toml");
	try {
		const baseConfigToml = await fs.readFile(codexConfigPath, "utf-8");
		await writeContainerFile(
			containerName,
			`${codexHome}/config.toml`,
			joinTomlBlocks(
				withCodexAutoApproveConfigToml(baseConfigToml),
				mcpConfigToml,
			),
		);
	} catch {
		if (mcpConfigToml) {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				joinTomlBlocks(CODEX_AUTO_APPROVE_CONFIG_TOML, mcpConfigToml),
			);
		} else {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				CODEX_AUTO_APPROVE_CONFIG_TOML,
			);
		}
	}

	const codexAuthPath = path.join(agentsDir, "codex-auth.json");
	let copiedCodexAuth = false;
	try {
		await fs.stat(codexAuthPath);
		await execAsync(
			`docker cp "${codexAuthPath}" ${containerName}:"${codexHome}/auth.json"`,
		);
		copiedCodexAuth = true;
	} catch (error) {
		const errorCode =
			error && typeof error === "object"
				? (error as { code?: string }).code
				: undefined;
		if (errorCode !== "ENOENT") {
			throw new Error(
				`Unable to copy codex auth file from ${codexAuthPath}: ${getErrorMessage(error)}`,
			);
		}
	}
	await execAsync(
		`docker exec ${containerName} bash -lc "test -s '${codexHome}/config.toml'${
			copiedCodexAuth ? ` && test -s '${codexHome}/auth.json'` : ""
		}"`,
	);
};

const CLAUDE_REQUIRED_SETTINGS = {
	permissions: {
		allow: [
			"Bash",
			"Bash(*)",
			"Read",
			"Read(*)",
			"Write",
			"Write(*)",
			"Edit",
			"Edit(*)",
			"MultiEdit",
			"MultiEdit(*)",
			"Glob",
			"Glob(*)",
			"Grep",
			"Grep(*)",
			"LS",
			"LS(*)",
			"Task",
			"Task(*)",
			"TodoWrite",
			"TodoWrite(*)",
			"WebFetch",
			"WebFetch(*)",
			"WebSearch",
			"WebSearch(*)",
		],
		deny: [],
		ask: [],
	},
};

const mergeUniqueStringArrays = (left: unknown, right: string[]) => [
	...new Set([
		...(Array.isArray(left)
			? left.filter((value): value is string => typeof value === "string")
			: []),
		...right,
	]),
];

const readContainerFileOrEmpty = async (
	containerName: string,
	filePath: string,
) => {
	const { stdout } = await execAsync(
		`docker exec ${containerName} bash -lc "if [ -f '${escapeSingleQuotes(
			filePath,
		)}' ]; then base64 -w0 '${escapeSingleQuotes(filePath)}'; fi"`,
	);
	return stdout.trim()
		? Buffer.from(stdout.trim(), "base64").toString("utf-8")
		: "";
};

const buildClaudeProfileSettingsEnv = (
	agentProfile: AgentProfileLike | null | undefined,
) => {
	if (agentProfile?.provider !== "claude_code" || !agentProfile.model) {
		return {};
	}
	return {
		ANTHROPIC_MODEL: agentProfile.model,
		ANTHROPIC_SMALL_FAST_MODEL: agentProfile.model,
		ANTHROPIC_DEFAULT_SONNET_MODEL: agentProfile.model,
		ANTHROPIC_DEFAULT_OPUS_MODEL: agentProfile.model,
		ANTHROPIC_DEFAULT_HAIKU_MODEL: agentProfile.model,
		CLAUDE_CODE_SUBAGENT_MODEL: agentProfile.model,
	};
};

const mergeClaudeSettingsJson = (
	existingSettingsJson: string,
	agentProfile?: AgentProfileLike | null,
) => {
	let existing: Record<string, unknown> = {};
	if (existingSettingsJson.trim()) {
		try {
			const parsed = JSON.parse(existingSettingsJson) as unknown;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				existing = parsed as Record<string, unknown>;
			}
		} catch {}
	}

	const existingPermissions =
		existing.permissions &&
		typeof existing.permissions === "object" &&
		!Array.isArray(existing.permissions)
			? (existing.permissions as Record<string, unknown>)
			: {};
	const existingEnv =
		existing.env &&
		typeof existing.env === "object" &&
		!Array.isArray(existing.env)
			? (existing.env as Record<string, unknown>)
			: {};
	const profileEnv = buildClaudeProfileSettingsEnv(agentProfile);
	return {
		...existing,
		env: {
			...existingEnv,
			...profileEnv,
		},
		permissions: {
			...existingPermissions,
			allow: mergeUniqueStringArrays(
				existingPermissions.allow,
				CLAUDE_REQUIRED_SETTINGS.permissions.allow,
			),
			deny: mergeUniqueStringArrays(
				existingPermissions.deny,
				CLAUDE_REQUIRED_SETTINGS.permissions.deny,
			),
			ask: mergeUniqueStringArrays(
				existingPermissions.ask,
				CLAUDE_REQUIRED_SETTINGS.permissions.ask,
			),
		},
	};
};

const initializeClaudeHomeInContainer = async (
	containerName: string,
	claudeHome: string,
	agentProfile?: AgentProfileLike | null,
) => {
	const settingsPath = `${claudeHome}/settings.json`;
	const existingSettingsJson = await readContainerFileOrEmpty(
		containerName,
		settingsPath,
	);
	await writeContainerFile(
		containerName,
		settingsPath,
		`${JSON.stringify(
			mergeClaudeSettingsJson(existingSettingsJson, agentProfile),
			null,
			2,
		)}\n`,
	);
};

const copyClaudeAssetsToContainerHome = async (
	containerName: string,
	claudeHome: string,
	agentProfile?: AgentProfileLike | null,
) => {
	if (
		agentProfile?.provider === "claude_code" &&
		resolveAgentAuthMode(agentProfile) === "host_home"
	) {
		const hostPath = resolveAgentHomeHostPath(agentProfile);
		if (!hostPath) {
			throw new Error(
				"Claude Code host home auth mode is enabled but no home path was configured on the agent profile.",
			);
		}
		await copyMountedFileToContainer({
			containerName,
			sourcePath: path.posix.join(AGENT_HOME_HOST_MOUNT_PATH, "settings.json"),
			targetPath: path.posix.join(claudeHome, "settings.json"),
			description:
				"Claude Code host home settings.json. Configure homePath as the host user home directory.",
		});
	}

	await initializeClaudeHomeInContainer(
		containerName,
		claudeHome,
		agentProfile,
	);
	await execAsync(
		`docker exec ${containerName} bash -lc "test -s '${escapeSingleQuotes(
			path.posix.join(claudeHome, "settings.json"),
		)}'"`,
	);
};

export type StageContainerInput = {
	scanJob: ScanJob;
	taskId?: string;
	agentProfile: AgentProfileLike | null;
	containerName: string;
	codexHome: string;
	stageDirPath: string;
	stageRootInContainer: string;
	taskRealRootInContainer?: string;
	persistent?: boolean;
	reuseContainer?: boolean;
	nullableOutput?: boolean;
	groupedPersistent?: boolean;
	allowAgentExit?: boolean;
};

export type RunSingleTurnAgentInput = StageContainerInput & {
	taskId?: string;
	cwd: string;
	prompt: string | ((containerName: string) => Promise<string>);
	taskStageDirPath?: string;
	taskStageRootInContainer?: string;
	taskRealRootInContainer?: string;
	laneThreadId?: string | null;
	outputSchema?: StructuredOutputSchemaSource;
	routeOutputSchemas?: RouteOutputSchema[];
	onThreadId?: (threadId: string) => Promise<void>;
	sessionMode?: "new" | "fork";
	parentSessionId?: string | null;
	parentTaskId?: string | null;
};

export type RunSingleTurnAgentResult = {
	threadId: string | null;
};

const resolveStageContainerRuntime = async (input: StageContainerInput) => {
	const { imageTag, projectName, serviceName, target } =
		await resolveScanExecutionContext(input.scanJob);
	const agentsDir = await resolveAgentsDirectory();
	const hostProfileDir = await resolveProjectProfileHostPath({
		projectName,
		profileName: serviceName,
	});
	const mountedProfileDir = resolveMountedProjectProfilePath({
		projectName,
		profileName: serviceName,
	});
	await fs.mkdir(input.stageDirPath, { recursive: true });
	const containerEnvPairs = [
		...getGlobalContainerEnvironmentPairs(),
		`VULSEEK_PROJECT_PROFILE_DIR=${mountedProfileDir}`,
		`VULSEEK_PROJECT_CACHE_DIR=${path.posix.join(mountedProfileDir, "cache")}`,
	];
	const runtimeFileNames = AGENT_RUNTIME_FILE_NAMES;
	const containerNetworkArg = await resolveCurrentDockerNetworkArg();
	const containerEnvArgs = containerEnvPairs
		.map((pair) => {
			const escaped = pair.replace(/'/g, `"'"'`);
			return `-e '${escaped}'`;
		})
		.join(" ");

	const stderrPath = path.join(input.stageDirPath, runtimeFileNames.stderr);
	const stdoutPath = path.join(input.stageDirPath, runtimeFileNames.stdout);
	const usagePath = path.join(input.stageDirPath, runtimeFileNames.usage);
	const containerBootstrapPath = path.join(
		input.stageDirPath,
		CONTAINER_BOOTSTRAP_LOG_FILE_NAME,
	);
	const { memoryLimit, memoryReservation } = getTargetMemoryArgs(target);
	const memoryArgs = [
		memoryLimit ? `--memory ${memoryLimit}` : null,
		memoryReservation ? `--memory-reservation ${memoryReservation}` : null,
	]
		.filter(Boolean)
		.join(" ");

	return {
		imageTag,
		agentsDir,
		taskRuntimeMount: {
			mountSource: hostProfileDir,
			mountDescription: `host_path:${hostProfileDir}`,
			dockerMountArg: `-v '${escapeSingleQuotes(hostProfileDir)}':${mountedProfileDir}`,
		},
		agentHomeHostMountArg: buildAgentHomeHostMountArg(input.agentProfile),
		agentHome: {
			codexContainerDir: CODEX_HOME_IN_CONTAINER,
			claudeContainerDir: CLAUDE_HOME_IN_CONTAINER,
		},
		containerNetworkArg,
		containerEnvArgs,
		memoryArgs,
		stderrPath,
		stdoutPath,
		usagePath,
		containerBootstrapPath,
	};
};

export const startContainer = async (input: StageContainerInput) => {
	const runtime = await resolveStageContainerRuntime(input);
	const logPath = runtime.containerBootstrapPath;
	await fs.writeFile(logPath, "", "utf-8").catch(() => {});
	await appendHostBootstrapLog(
		logPath,
		`start_container task_id=${input.taskId || ""} container=${input.containerName} persistent=${String(
			Boolean(input.persistent),
		)} stage_dir=${JSON.stringify(input.stageDirPath)} stage_root=${JSON.stringify(
			input.stageRootInContainer,
		)}`,
	);

	if ((input.reuseContainer ?? true) || input.persistent) {
		const running = await execAsync(
			`docker inspect -f '{{.State.Running}}' ${input.containerName}`,
		)
			.then(({ stdout }) => stdout.trim() === "true")
			.catch(() => false);
		if (running) {
			await withHostBootstrapLog(logPath, "container_reuse", "", () =>
				execAsync(
					`docker exec ${input.containerName} bash -lc "mkdir -p '${input.stageRootInContainer}' '${runtime.agentHome.codexContainerDir}/skills' '${runtime.agentHome.claudeContainerDir}'"`,
				),
			);
			if (input.taskRealRootInContainer) {
				await updateTaskAliasSymlinkInContainer({
					containerName: input.containerName,
					taskRootInContainer: input.taskRealRootInContainer,
					logPath,
				});
			}
			await appendHostBootstrapLog(logPath, "start_container_done reused=true");
			return;
		}
		await withHostBootstrapLog(logPath, "remove_stale_container", "", () =>
			execAsync(`docker rm -f ${input.containerName}`).catch(() => {}),
		);
	} else {
		// Recovery/retry may encounter leftover containers with the same deterministic
		// name. Remove them first so restart logic can safely recreate the runtime.
		await withHostBootstrapLog(logPath, "remove_existing_container", "", () =>
			execAsync(`docker rm -f ${input.containerName}`).catch(() => {}),
		);
	}

	await withHostBootstrapLog(
		logPath,
		"runtime_files_initialized_on_host",
		"",
		() => initializeAgentRuntimeFiles(input.stageDirPath),
	);
	await withHostBootstrapLog(
		logPath,
		"docker_run",
		`image=${JSON.stringify(runtime.imageTag)} mount=${JSON.stringify(
			runtime.taskRuntimeMount.mountDescription,
		)}`,
		() =>
			execDockerRunWithRetry({
				containerName: input.containerName,
				taskId: input.taskId,
				logPath,
				command: `docker run -d --init --name ${input.containerName} ${runtime.containerNetworkArg} ${buildNamespaceEnabledContainerArgs()} ${runtime.memoryArgs} ${runtime.taskRuntimeMount.dockerMountArg} ${runtime.agentHomeHostMountArg} ${runtime.containerEnvArgs} ${runtime.imageTag} bash -lc "mkdir -p '${input.stageRootInContainer}' '${runtime.agentHome.codexContainerDir}/skills' '${runtime.agentHome.claudeContainerDir}' && sleep infinity"`,
			}),
	);

	await withHostBootstrapLog(logPath, "install_runtime_skills", "", () =>
		installRuntimeSkillsInContainer({
			containerName: input.containerName,
			agentsDir: runtime.agentsDir,
			skillNames: RUNTIME_CUSTOM_SKILLS,
			logPath,
		}),
	);
	await appendHostBootstrapLog(logPath, "start_container_runtime_ready");
	if (input.taskRealRootInContainer) {
		await updateTaskAliasSymlinkInContainer({
			containerName: input.containerName,
			taskRootInContainer: input.taskRealRootInContainer,
			logPath,
		});
	}
	await appendHostBootstrapLog(logPath, "start_container_done reused=false");
};

export const stopContainer = async (containerName: string) => {
	await execAsync(`docker stop ${containerName}`).catch(() => {});
};

export const removeContainer = async (containerName: string) => {
	await execAsync(`docker rm -f ${containerName}`).catch(() => {});
};

const updateTaskAliasSymlinkInContainer = async (input: {
	containerName: string;
	taskRootInContainer: string;
	logPath?: string | null;
}) => {
	const script = [
		"set -euo pipefail",
		`task_root='${escapeSingleQuotes(input.taskRootInContainer)}'`,
		`alias_root='${TASK_ALIAS_ROOT_IN_CONTAINER}'`,
		'mkdir -p "$task_root"',
		'if [ -L "$alias_root" ]; then',
		'  rm "$alias_root"',
		'elif [ -e "$alias_root" ]; then',
		'  echo "$alias_root exists but is not a symlink" >&2',
		"  exit 1",
		"fi",
		'ln -s "$task_root" "$alias_root"',
	].join("\n");
	await withHostBootstrapLog(
		input.logPath,
		"task_alias_symlink",
		`target=${JSON.stringify(input.taskRootInContainer)}`,
		() =>
			execAsync(
				`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(script)}'`,
			),
	);
};

const ACP_DRIVER_FILE_NAME = "/opt/vulseek-acp/vulseek-acp-driver.mjs";
const ACP_DRIVER_INPUT_FILE_NAME = "acp-driver-input.json";
const ACP_DRIVER_STDOUT_FILE_NAME = "acp-driver-stdout.log";
const ACP_DRIVER_LAUNCH_FILE_NAME = "acp-driver-launch.sh";
const ACP_DRIVER_PID_FILE_NAME = "acp-driver.pid";
const ACP_DRIVER_LIFECYCLE_FILE_NAME = "acp-driver-lifecycle.log";
const CONTAINER_BOOTSTRAP_LOG_FILE_NAME = "container-bootstrap.log";
const ACP_DRIVER_TASK_DIR_NAME = "acp-driver-tasks";
const ACP_AGENT_HOME_DIR_NAME = "agent-home";
const ACP_DRIVER_VERSION = "2026-07-15-sdk-1";

const buildAcpDriverLaunchScript = (input: {
	driverScriptPath: string;
	driverInputPath: string;
	driverStdoutPath: string;
	driverPidPath: string;
	driverLifecyclePath: string;
	taskStdoutPath: string;
	stderrPath: string;
}) => `#!/usr/bin/env bash
set -euo pipefail

mkdir -p '${escapeSingleQuotes(path.posix.dirname(input.driverScriptPath))}'
: > '${escapeSingleQuotes(input.driverStdoutPath)}'

nohup bash -lc 'echo "[acp-driver-lifecycle] $(date -Iseconds) shell_start pid=$$" >> "${input.driverLifecyclePath}"; node "${input.driverScriptPath}" "${input.driverInputPath}" > >(tee -a "${input.driverStdoutPath}" "${input.taskStdoutPath}" >/dev/null) 2>> "${input.stderrPath}"; status=$?; echo "[acp-driver] exit_code=$status" >> "${input.stderrPath}"; echo "[acp-driver-lifecycle] $(date -Iseconds) shell_exit status=$status" >> "${input.driverLifecyclePath}"' >/dev/null 2>&1 &
driver_pid=$!
echo "[acp-driver] pid=$driver_pid" >> '${escapeSingleQuotes(input.stderrPath)}'
echo "[acp-driver-lifecycle] $(date -Iseconds) launch_background_pid=$driver_pid" >> '${escapeSingleQuotes(input.driverLifecyclePath)}'
echo "$driver_pid" > '${escapeSingleQuotes(input.driverPidPath)}'
`;

const launchDriver = async (input: {
	containerName: string;
	driverLaunchPath: string;
}) => {
	await execAsync(
		`docker exec ${input.containerName} bash '${input.driverLaunchPath}'`,
	);
};

type DriverHealth = {
	alive: boolean;
	reason: string | null;
	pid: string | null;
	state: string | null;
	lifecycleAgeMs: number | null;
	lastLifecycleLine: string | null;
};

const parseDriverHealthOutput = (output: string): DriverHealth => {
	const record = new Map<string, string>();
	for (const line of output.split("\n")) {
		const index = line.indexOf("=");
		if (index <= 0) {
			continue;
		}
		record.set(line.slice(0, index), line.slice(index + 1));
	}
	const age = Number.parseInt(record.get("age_ms") || "", 10);
	return {
		alive: record.get("alive") === "true",
		reason: record.get("reason") || null,
		pid: record.get("pid") || null,
		state: record.get("state") || null,
		lifecycleAgeMs: Number.isFinite(age) ? age : null,
		lastLifecycleLine: record.get("last_line") || null,
	};
};

const inspectDriverHealth = async (input: {
	containerName: string;
	driverPidPath: string;
	driverLifecyclePath: string;
}): Promise<DriverHealth> => {
	const maxIdleMs = Number.isFinite(PERSISTENT_DRIVER_HEALTH_MAX_IDLE_MS)
		? Math.max(30000, PERSISTENT_DRIVER_HEALTH_MAX_IDLE_MS)
		: 120000;
	const maxIdleSeconds = Math.ceil(maxIdleMs / 1000);
	const probe = [
		"set -u",
		`pid_path='${escapeSingleQuotes(input.driverPidPath)}'`,
		`lifecycle_path='${escapeSingleQuotes(input.driverLifecyclePath)}'`,
		`max_idle_seconds=${maxIdleSeconds}`,
		"pid=''",
		'if [ -f "$pid_path" ]; then pid=$(cat "$pid_path" 2>/dev/null || true); fi',
		"if [ -z \"$pid\" ]; then echo 'alive=false'; echo 'reason=missing_pid'; exit 0; fi",
		"state=$(ps -p \"$pid\" -o stat= 2>/dev/null | tr -d '[:space:]' || true)",
		"if [ -z \"$state\" ]; then echo 'alive=false'; echo 'reason=process_not_running'; echo \"pid=$pid\"; exit 0; fi",
		'case "$state" in *Z*) echo \'alive=false\'; echo \'reason=process_zombie\'; echo "pid=$pid"; echo "state=$state"; exit 0;; esac',
		'if ! kill -0 "$pid" 2>/dev/null; then echo \'alive=false\'; echo \'reason=kill_check_failed\'; echo "pid=$pid"; echo "state=$state"; exit 0; fi',
		'if [ ! -f "$lifecycle_path" ]; then echo \'alive=false\'; echo \'reason=missing_lifecycle\'; echo "pid=$pid"; echo "state=$state"; exit 0; fi',
		"now=$(date +%s)",
		'mtime=$(stat -c %Y "$lifecycle_path" 2>/dev/null || echo 0)',
		"age_seconds=$((now - mtime))",
		"age_ms=$((age_seconds * 1000))",
		"last_line=$(tail -n 1 \"$lifecycle_path\" 2>/dev/null | tr '\\n' ' ' || true)",
		'if [ "$age_seconds" -gt "$max_idle_seconds" ]; then echo \'alive=false\'; echo \'reason=stale_lifecycle\'; echo "pid=$pid"; echo "state=$state"; echo "age_ms=$age_ms"; echo "last_line=$last_line"; exit 0; fi',
		"echo 'alive=true'",
		"echo 'reason=ok'",
		'echo "pid=$pid"',
		'echo "state=$state"',
		'echo "age_ms=$age_ms"',
		'echo "last_line=$last_line"',
	].join("; ");
	return await execAsync(
		`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(probe)}'`,
	)
		.then(({ stdout }) => parseDriverHealthOutput(stdout))
		.catch((error) => ({
			alive: false,
			reason: `health_probe_failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
			pid: null,
			state: null,
			lifecycleAgeMs: null,
			lastLifecycleLine: null,
		}));
};

const stopPersistentDriver = async (input: {
	containerName: string;
	driverPidPath: string;
}) => {
	const script = [
		"set -u",
		`pid_path='${escapeSingleQuotes(input.driverPidPath)}'`,
		"pid=''",
		'if [ -f "$pid_path" ]; then pid=$(cat "$pid_path" 2>/dev/null || true); fi',
		'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill "$pid" 2>/dev/null || true; sleep 1; fi',
		'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then kill -9 "$pid" 2>/dev/null || true; fi',
		'rm -f "$pid_path"',
	].join("; ");
	await execAsync(
		`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(script)}'`,
	).catch(() => {});
};

const quarantinePersistentDriverTaskQueue = async (input: {
	containerName: string;
	taskQueueDir: string;
}) => {
	const script = [
		"set -u",
		`queue_dir='${escapeSingleQuotes(input.taskQueueDir)}'`,
		'if [ -d "$queue_dir" ]; then mv "$queue_dir" "$queue_dir.stale-$(date +%s)-$$" 2>/dev/null || true; fi',
		'mkdir -p "$queue_dir"',
	].join("; ");
	await execAsync(
		`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(script)}'`,
	).catch(() => {});
};

const persistentDriverScriptMatchesCurrentVersion = async (input: {
	containerName: string;
	driverScriptPath: string;
}) => {
	const { stdout } = await execAsync(
		`docker exec ${input.containerName} bash -lc "grep -F '${escapeSingleQuotes(
			ACP_DRIVER_VERSION,
		)}' '${escapeSingleQuotes(input.driverScriptPath)}' >/dev/null 2>&1 && echo yes || echo no"`,
	);
	return stdout.trim() === "yes";
};

const buildTaskAgentHomePathInContainer = (taskRootInContainer: string) =>
	path.posix.join(taskRootInContainer, ACP_AGENT_HOME_DIR_NAME);

const buildTaskRootInContainer = (input: {
	scanJobId: string;
	stageName: string;
	name: string;
	taskId: string;
}) =>
	path.posix.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"jobs",
		input.scanJobId,
		resolveTaskRootSegment(input.stageName, input.name, input.taskId)
			.split(path.sep)
			.join("/"),
	);

const buildLaneRootInContainer = (input: {
	scanJobId: string;
	stageName: string;
	laneIndex: number;
}) =>
	path.posix.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"jobs",
		input.scanJobId,
		resolveStageLaneRootSegment(input.stageName, input.laneIndex)
			.split(path.sep)
			.join("/"),
	);

const resolveJobRootFromRuntimeDir = (
	runtimeDir: string,
	scanJobId: string,
) => {
	const resolved = path.resolve(runtimeDir);
	const parts = resolved.split(path.sep);
	const scanJobIndex = parts.lastIndexOf(scanJobId);
	if (scanJobIndex <= 0 || parts[scanJobIndex - 1] !== "jobs") {
		throw new Error(
			`Unable to resolve scan job runtime root from '${runtimeDir}' for job '${scanJobId}'`,
		);
	}
	const root = parts.slice(0, scanJobIndex + 1).join(path.sep);
	return root || path.sep;
};

const buildTaskRootOnHost = (input: {
	jobRootOnHost: string;
	stageName: string;
	name: string;
	taskId: string;
}) =>
	path.join(
		input.jobRootOnHost,
		resolveTaskRootSegment(input.stageName, input.name, input.taskId),
	);

const buildLaneRootOnHost = (input: {
	jobRootOnHost: string;
	stageName: string;
	laneIndex: number;
}) =>
	path.join(
		input.jobRootOnHost,
		resolveStageLaneRootSegment(input.stageName, input.laneIndex),
	);

const resolvePersistentLaneIndexFromContainerName = (
	containerName: string | null | undefined,
) => {
	const match = (containerName || "").match(/(?:^|-)lane-(\d+)$/);
	if (!match?.[1]) {
		return null;
	}
	const laneIndex = Number.parseInt(match[1], 10);
	return Number.isFinite(laneIndex) ? laneIndex : null;
};

const resolveParentTaskRootInContainer = async (
	input: RunSingleTurnAgentInput,
) => {
	if (input.sessionMode !== "fork") {
		return null;
	}
	if (!input.parentTaskId) {
		return null;
	}
	const parentTask = await findTaskByIdRepo(input.parentTaskId).catch(
		() => null,
	);
	if (!parentTask) {
		throw new Error(
			`Fork session requested but parent task '${input.parentTaskId}' was not found`,
		);
	}
	return buildTaskRootInContainer({
		scanJobId: input.scanJob.scanJobId,
		stageName: parentTask.stageName,
		name:
			parentTask.name ||
			resolveStageTaskName(parentTask.stageName, parentTask.input),
		taskId: parentTask.taskId,
	});
};

const resolveParentRuntimeRootOnHost = async (
	input: RunSingleTurnAgentInput,
) => {
	if (input.sessionMode !== "fork" || !input.parentTaskId) {
		return null;
	}
	const parentTask = await findTaskByIdRepo(input.parentTaskId).catch(
		() => null,
	);
	if (!parentTask) {
		throw new Error(
			`Fork session requested but parent task '${input.parentTaskId}' was not found`,
		);
	}
	const jobRootOnHost = resolveJobRootFromRuntimeDir(
		input.taskStageDirPath || input.stageDirPath,
		input.scanJob.scanJobId,
	);
	const parentContainerLaneIndex = resolvePersistentLaneIndexFromContainerName(
		parentTask.containerName,
	);
	if (parentContainerLaneIndex !== null) {
		return buildLaneRootOnHost({
			jobRootOnHost,
			stageName: parentTask.stageName,
			laneIndex: parentContainerLaneIndex,
		});
	}
	const parentLaneRuntime = await findStageLaneRuntimeByTaskIdRepo({
		scanJobId: input.scanJob.scanJobId,
		stageName: parentTask.stageName,
		taskId: parentTask.taskId,
	}).catch(() => null);
	if (parentLaneRuntime) {
		return buildLaneRootOnHost({
			jobRootOnHost,
			stageName: parentTask.stageName,
			laneIndex: parentLaneRuntime.laneIndex,
		});
	}
	return buildTaskRootOnHost({
		jobRootOnHost,
		stageName: parentTask.stageName,
		name:
			parentTask.name ||
			resolveStageTaskName(parentTask.stageName, parentTask.input),
		taskId: parentTask.taskId,
	});
};

const pathExists = async (filePath: string) =>
	Boolean(await fs.stat(filePath).catch(() => null));

const copyDirectoryReplacing = async (source: string, target: string) => {
	if (!(await pathExists(source))) {
		return false;
	}
	await fs.rm(target, { recursive: true, force: true });
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.cp(source, target, { recursive: true });
	return true;
};

const prepareForkAgentHomeOnHost = async (input: {
	runInput: RunSingleTurnAgentInput;
	taskStageDirPath: string;
}) => {
	if (input.runInput.sessionMode !== "fork" || !input.runInput.parentTaskId) {
		return;
	}

	const parentRuntimeRootOnHost = await resolveParentRuntimeRootOnHost(
		input.runInput,
	);
	if (!parentRuntimeRootOnHost) {
		throw new Error(
			`Fork session requested but parent task runtime root could not be resolved for task '${input.runInput.parentTaskId}'`,
		);
	}

	const parentAgentHomeOnHost = path.join(
		parentRuntimeRootOnHost,
		ACP_AGENT_HOME_DIR_NAME,
	);
	const childAgentHomeRootOnHost = input.runInput.persistent
		? input.runInput.stageDirPath
		: input.taskStageDirPath;
	const childAgentHomeOnHost = path.join(
		childAgentHomeRootOnHost,
		ACP_AGENT_HOME_DIR_NAME,
	);
	const childAgentHomeExists = await pathExists(childAgentHomeOnHost);
	const copiedAgentHome =
		input.runInput.persistent && childAgentHomeExists
			? true
			: await copyDirectoryReplacing(
					parentAgentHomeOnHost,
					childAgentHomeOnHost,
				);

	if (!copiedAgentHome) {
		throw new Error(
			`Fork session requested but parent agent-home was not found at ${parentAgentHomeOnHost}`,
		);
	}
};

const resolveParentAgentHomePathInContainer = async (
	input: RunSingleTurnAgentInput,
) => {
	if (input.sessionMode !== "fork" || !input.parentTaskId) {
		return null;
	}
	const parentTask = await findTaskByIdRepo(input.parentTaskId).catch(
		() => null,
	);
	if (!parentTask) {
		throw new Error(
			`Fork session requested but parent task '${input.parentTaskId}' was not found`,
		);
	}
	const parentContainerLaneIndex = resolvePersistentLaneIndexFromContainerName(
		parentTask.containerName,
	);
	if (parentContainerLaneIndex !== null) {
		return buildTaskAgentHomePathInContainer(
			buildLaneRootInContainer({
				scanJobId: input.scanJob.scanJobId,
				stageName: parentTask.stageName,
				laneIndex: parentContainerLaneIndex,
			}),
		);
	}
	const parentLaneRuntime = await findStageLaneRuntimeByTaskIdRepo({
		scanJobId: input.scanJob.scanJobId,
		stageName: parentTask.stageName,
		taskId: parentTask.taskId,
	}).catch(() => null);
	if (parentLaneRuntime) {
		return buildTaskAgentHomePathInContainer(
			buildLaneRootInContainer({
				scanJobId: input.scanJob.scanJobId,
				stageName: parentTask.stageName,
				laneIndex: parentLaneRuntime.laneIndex,
			}),
		);
	}
	const parentTaskRoot = await resolveParentTaskRootInContainer(input);
	return parentTaskRoot
		? buildTaskAgentHomePathInContainer(parentTaskRoot)
		: null;
};

const prepareTaskAgentHomeInContainer = async (input: {
	containerName: string;
	agentProvider: string;
	agentProfile: AgentProfileLike | null;
	agentsDir: string | null;
	agentHomeRootInContainer: string;
	sessionMode?: "new" | "fork";
	parentAgentHomePathInContainer: string | null;
	reuseExistingAgentHome?: boolean;
	logPath?: string | null;
}) => {
	const agentHomePathInContainer = buildTaskAgentHomePathInContainer(
		input.agentHomeRootInContainer,
	);
	const isFork = input.sessionMode === "fork";
	const setupScript = [
		"set -euo pipefail",
		`agent_home='${escapeSingleQuotes(agentHomePathInContainer)}'`,
		`parent_agent_home='${escapeSingleQuotes(input.parentAgentHomePathInContainer || "")}'`,
		`reuse_existing='${input.reuseExistingAgentHome ? "1" : "0"}'`,
		'mkdir -p "$(dirname "$agent_home")"',
		'if [ "$reuse_existing" = "1" ] && [ -d "$agent_home" ]; then',
		"  :",
		"else",
		isFork
			? [
					'  if [ -d "$agent_home" ]; then',
					"    :",
					'  elif [ -n "$parent_agent_home" ] && [ -d "$parent_agent_home" ]; then',
					'    rm -rf "$agent_home"',
					'    cp -a "$parent_agent_home" "$agent_home"',
					"  else",
					'    echo "fork session requested but neither current nor parent agent-home is available: $agent_home / $parent_agent_home" >&2',
					"    exit 1",
					"  fi",
				].join("\n")
			: '  rm -rf "$agent_home" && mkdir -p "$agent_home"',
		"fi",
		'mkdir -p "$agent_home/skills"',
	].join("\n");

	await withHostBootstrapLog(
		input.logPath,
		"agent_home_setup",
		`provider=${input.agentProvider} session_mode=${input.sessionMode || ""} reuse_existing=${String(
			Boolean(input.reuseExistingAgentHome),
		)} target=${JSON.stringify(agentHomePathInContainer)} parent=${JSON.stringify(
			input.parentAgentHomePathInContainer || "",
		)}`,
		() =>
			execAsync(
				`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(setupScript)}'`,
			),
	);

	if (input.agentProvider === "claude_code" && !isFork) {
		await withHostBootstrapLog(
			input.logPath,
			"agent_home_copy_claude_assets",
			"",
			() =>
				copyClaudeAssetsToContainerHome(
					input.containerName,
					agentHomePathInContainer,
					input.agentProfile,
				),
		);
	} else if (!isFork) {
		await withHostBootstrapLog(
			input.logPath,
			"agent_home_copy_codex_assets",
			"",
			() =>
				copyCodexAssetsToContainerHome(
					input.containerName,
					agentHomePathInContainer,
					input.agentsDir,
					input.agentProfile,
				),
		);
	}

	return {
		agentHomePathInContainer,
		agentHomeLinkPathInContainer: agentHomePathInContainer,
		parentAgentHomePathInContainer: input.parentAgentHomePathInContainer,
		agentHomeCopiedFromParent: isFork,
	};
};

export const runSingleTurnAgentInContainer = async (
	input: RunSingleTurnAgentInput,
): Promise<RunSingleTurnAgentResult> => {
	const runSingleTurnStartedAt = Date.now();
	let outputSchemaElapsedMs = 0;
	let promptResolveElapsedMs = 0;
	const taskStageDirPath = input.taskStageDirPath || input.stageDirPath;
	const taskStageRootInContainer =
		input.taskStageRootInContainer || input.stageRootInContainer;
	const realTaskRootInContainer =
		input.taskRealRootInContainer ||
		(taskStageRootInContainer !== TASK_ALIAS_ROOT_IN_CONTAINER
			? taskStageRootInContainer
			: null);
	if (!realTaskRootInContainer) {
		throw new Error(
			"Task real root in container is required when /task is an alias",
		);
	}
	const structuredOutputSchemaPathOnHost = path.join(
		taskStageDirPath,
		STRUCTURED_OUTPUT_SCHEMA_FILE_NAME,
	);
	const structuredOutputResultPathInContainer = path.posix.join(
		taskStageRootInContainer,
		STRUCTURED_OUTPUT_RESULT_FILE_NAME,
	);
	const structuredOutputSchemaAgentPathInContainer = path.posix.join(
		TASK_ALIAS_ROOT_IN_CONTAINER,
		STRUCTURED_OUTPUT_SCHEMA_FILE_NAME,
	);
	const structuredOutputResultAgentPathInContainer = path.posix.join(
		TASK_ALIAS_ROOT_IN_CONTAINER,
		STRUCTURED_OUTPUT_RESULT_FILE_NAME,
	);
	if (input.outputSchema || input.routeOutputSchemas?.length) {
		const stepStartedAt = Date.now();
		const jsonSchema = buildStructuredOutputEnvelopeJsonSchema(
			input.outputSchema || input.routeOutputSchemas![0]!.schema,
			input.routeOutputSchemas,
			{ nullableOutput: input.nullableOutput },
		);
		const serializedJsonSchema = `${JSON.stringify(jsonSchema, null, 2)}\n`;
		await fs.mkdir(taskStageDirPath, { recursive: true });
		await fs.writeFile(
			structuredOutputSchemaPathOnHost,
			serializedJsonSchema,
			"utf-8",
		);
		if (input.persistent && input.stageDirPath !== taskStageDirPath) {
			await fs.mkdir(input.stageDirPath, { recursive: true });
			await fs.writeFile(
				path.join(input.stageDirPath, STRUCTURED_OUTPUT_SCHEMA_FILE_NAME),
				serializedJsonSchema,
				"utf-8",
			);
		}
		outputSchemaElapsedMs = Date.now() - stepStartedAt;
	}

	const promptResolveStartedAt = Date.now();
	const resolvedPrompt =
		typeof input.prompt === "string"
			? input.prompt
			: await input.prompt(input.containerName);
	promptResolveElapsedMs = Date.now() - promptResolveStartedAt;
	const injectionTarget = input.scanJob.applicationId
		? await findApplicationById(input.scanJob.applicationId)
		: input.scanJob.composeId
			? await findComposeById(input.scanJob.composeId)
			: null;
	const injectionPromptText = injectionTarget?.injectionPrompt?.trim() || "";
	const securityPolicyText = injectionTarget?.securityPolicy?.trim() || "";
	const securityPolicyArtifact =
		injectionTarget && securityPolicyText
			? await writeScanJobSecurityPolicyArtifact({
					securityPolicy: securityPolicyText,
					profileHostPath: await resolveProjectProfileHostPath({
						projectName: injectionTarget.environment.project.name,
						profileName: injectionTarget.name || injectionTarget.appName,
					}),
					profileContainerPath: resolveMountedProjectProfilePath({
						projectName: injectionTarget.environment.project.name,
						profileName: injectionTarget.name || injectionTarget.appName,
					}),
					scanJobId: input.scanJob.scanJobId,
				})
			: null;
	const promptAdditions = [
		securityPolicyArtifact?.instruction,
		injectionPromptText || null,
	].filter(Boolean);
	const resolvedPromptFinal = promptAdditions.length
		? `${resolvedPrompt.trimEnd()}\n\n${promptAdditions.join("\n\n")}`
		: resolvedPrompt;
	const promptWithOutputSchema =
		input.outputSchema || input.routeOutputSchemas?.length
			? `${resolvedPromptFinal.trimEnd()}\n${buildStructuredOutputPromptSuffix(
					input.outputSchema || input.routeOutputSchemas![0]!.schema,
					structuredOutputSchemaAgentPathInContainer,
					structuredOutputResultAgentPathInContainer,
					input.routeOutputSchemas,
					{
						persistent: input.persistent,
						groupedPersistent: input.groupedPersistent,
						allowAgentExit: input.allowAgentExit,
						nullableOutput: input.nullableOutput,
					},
				)}`
			: resolvedPromptFinal;
	const runtimeFileNames = AGENT_RUNTIME_FILE_NAMES;
	const taskStderrPath = path.join(taskStageDirPath, runtimeFileNames.stderr);
	await initializeAgentRuntimeFiles(taskStageDirPath);
	await appendHostBootstrapLog(
		taskStderrPath,
		`run_single_turn_start task_id=${input.taskId || ""} container=${input.containerName} persistent=${String(
			Boolean(input.persistent),
		)} lane_thread_id=${input.laneThreadId || ""} session_mode=${input.sessionMode || ""} task_dir=${JSON.stringify(
			taskStageDirPath,
		)} task_root=${JSON.stringify(taskStageRootInContainer)} stage_root=${JSON.stringify(
			input.stageRootInContainer,
		)} elapsed_before_runtime_ms=${Date.now() - runSingleTurnStartedAt} output_schema_ms=${outputSchemaElapsedMs} prompt_resolve_ms=${promptResolveElapsedMs}`,
	);
	await updateTaskAliasSymlinkInContainer({
		containerName: input.containerName,
		taskRootInContainer: realTaskRootInContainer,
		logPath: taskStderrPath,
	});
	await withHostBootstrapLog(
		taskStderrPath,
		"prepare_fork_agent_home",
		`session_mode=${input.sessionMode || ""} parent_task_id=${input.parentTaskId || ""}`,
		() =>
			prepareForkAgentHomeOnHost({
				runInput: input,
				taskStageDirPath,
			}),
	);
	const agentProvider = input.agentProfile?.provider || "codex";
	const driverScriptPath = ACP_DRIVER_FILE_NAME;
	const driverInputPath = path.posix.join(
		input.stageRootInContainer,
		ACP_DRIVER_INPUT_FILE_NAME,
	);
	const driverStdoutPath = path.posix.join(
		input.stageRootInContainer,
		ACP_DRIVER_STDOUT_FILE_NAME,
	);
	const driverLaunchPath = path.posix.join(
		input.stageRootInContainer,
		ACP_DRIVER_LAUNCH_FILE_NAME,
	);
	const driverPidPath = path.posix.join(
		input.stageRootInContainer,
		ACP_DRIVER_PID_FILE_NAME,
	);
	const driverLifecyclePath = path.posix.join(
		input.stageRootInContainer,
		ACP_DRIVER_LIFECYCLE_FILE_NAME,
	);
	const taskQueueDir = path.posix.join(
		input.stageRootInContainer,
		ACP_DRIVER_TASK_DIR_NAME,
	);

	const persistentDriverHealth = input.persistent
		? await withHostBootstrapLog(
				taskStderrPath,
				"inspect_persistent_driver_health",
				"",
				() =>
					inspectDriverHealth({
						containerName: input.containerName,
						driverPidPath,
						driverLifecyclePath,
					}),
			)
		: null;
	if (persistentDriverHealth) {
		await appendHostBootstrapLog(
			taskStderrPath,
			`persistent_driver_health alive=${String(
				persistentDriverHealth.alive,
			)} reason=${JSON.stringify(persistentDriverHealth.reason || "")} pid=${JSON.stringify(
				persistentDriverHealth.pid || "",
			)} state=${JSON.stringify(persistentDriverHealth.state || "")} lifecycle_age_ms=${
				persistentDriverHealth.lifecycleAgeMs ?? ""
			}`,
		);
	}
	let persistentDriverAlive = Boolean(
		input.persistent && persistentDriverHealth?.alive,
	);
	if (persistentDriverAlive) {
		const driverScriptCurrent = await withHostBootstrapLog(
			taskStderrPath,
			"inspect_persistent_driver_script_version",
			`expected=${ACP_DRIVER_VERSION}`,
			() =>
				persistentDriverScriptMatchesCurrentVersion({
					containerName: input.containerName,
					driverScriptPath,
				}),
		).catch(() => false);
		if (!driverScriptCurrent) {
			await appendHostBootstrapLog(
				taskStderrPath,
				`persistent_driver_script_stale expected=${ACP_DRIVER_VERSION}; restarting driver`,
			);
			await stopPersistentDriver({
				containerName: input.containerName,
				driverPidPath,
			});
			await quarantinePersistentDriverTaskQueue({
				containerName: input.containerName,
				taskQueueDir,
			});
			persistentDriverAlive = false;
		}
	}
	const agentHomeRootInContainer = input.persistent
		? input.stageRootInContainer
		: taskStageRootInContainer;
	const parentAgentHomePathInContainer =
		await resolveParentAgentHomePathInContainer(input);
	const agentsDir = await resolveAgentsDirectory();
	const taskAgentHome = persistentDriverAlive
		? {
				agentHomePathInContainer: buildTaskAgentHomePathInContainer(
					agentHomeRootInContainer,
				),
				agentHomeLinkPathInContainer: buildTaskAgentHomePathInContainer(
					agentHomeRootInContainer,
				),
				parentAgentHomePathInContainer,
				agentHomeCopiedFromParent: false,
			}
		: await prepareTaskAgentHomeInContainer({
				containerName: input.containerName,
				agentProvider,
				agentProfile: input.agentProfile,
				agentsDir,
				agentHomeRootInContainer,
				sessionMode: input.sessionMode,
				parentAgentHomePathInContainer,
				reuseExistingAgentHome: Boolean(input.persistent),
				logPath: taskStderrPath,
			});

	await appendHostBootstrapLog(
		taskStderrPath,
		`agent_home_ready path=${JSON.stringify(
			taskAgentHome.agentHomePathInContainer,
		)} link=${JSON.stringify(taskAgentHome.agentHomeLinkPathInContainer)} copied_from_parent=${String(
			taskAgentHome.agentHomeCopiedFromParent,
		)}`,
	);

	const existingTaskThreadId = input.taskId
		? (await findTaskByIdRepo(input.taskId).catch(() => null))?.threadId || null
		: null;
	const adapterEnv = input.agentProfile
		? envPairsToRecord(
				agentProvider === "claude_code"
					? buildClaudeEnvPairs(
							input.agentProfile,
							taskAgentHome.agentHomePathInContainer,
						)
					: parseAgentProfileEnvPairs(input.agentProfile),
			)
		: {};
	const buildDriverTaskInput = () => ({
		taskId: input.taskId || undefined,
		provider:
			input.agentProfile?.provider === "claude_code" ? "claude" : "codex",
		cwd: input.cwd,
		prompt: promptWithOutputSchema,
		threadId: existingTaskThreadId || input.laneThreadId || null,
		adapterEnv,
		taskStageRootInContainer,
		taskAliasRootInContainer: TASK_ALIAS_ROOT_IN_CONTAINER,
		structuredOutputResultPathInContainer,
		nullableOutput: Boolean(input.nullableOutput),
		allowAgentExit: Boolean(input.allowAgentExit),
		model: input.agentProfile?.model || null,
		thinkingLevel: input.agentProfile?.thinkingLevelEnabled
			? input.agentProfile.thinkingLevel
			: null,
		sessionMode: input.laneThreadId ? "persistent" : input.sessionMode || "new",
		parentSessionId: input.parentSessionId || null,
		stderrPath: path.posix.join(
			taskStageRootInContainer,
			runtimeFileNames.stderr,
		),
		stdoutPath: path.posix.join(
			taskStageRootInContainer,
			runtimeFileNames.stdout,
		),
		usagePath: path.posix.join(
			taskStageRootInContainer,
			runtimeFileNames.usage,
		),
		activityPath: path.posix.join(
			taskStageRootInContainer,
			runtimeFileNames.activity,
		),
		statePath: path.posix.join(
			taskStageRootInContainer,
			runtimeFileNames.state,
		),
		driverLifecyclePath,
		agentHomePathInContainer: taskAgentHome.agentHomePathInContainer,
		agentHomeLinkPathInContainer: taskAgentHome.agentHomeLinkPathInContainer,
		parentAgentHomePathInContainer:
			taskAgentHome.parentAgentHomePathInContainer,
		agentHomeCopiedFromParent: taskAgentHome.agentHomeCopiedFromParent,
	});
	if (persistentDriverAlive) {
		const driverTaskInput = buildDriverTaskInput();
		const requestPath = path.posix.join(
			taskQueueDir,
			`${Date.now()}-${input.scanJob.scanJobId}-${Math.random().toString(16).slice(2)}.json`,
		);
		await appendHostBootstrapLog(
			taskStderrPath,
			`persistent_driver_enqueue request_path=${JSON.stringify(requestPath)} lane_thread_id=${input.laneThreadId || ""}`,
		);
		await appendContainerFile(
			input.containerName,
			driverLifecyclePath,
			`[acp-driver-lifecycle] ${new Date().toISOString()} host_enqueue task_id=${input.taskId || ""} request_path=${requestPath} lane_thread_id=${input.laneThreadId || ""}\n`,
		).catch(() => {});
		await withHostBootstrapLog(
			taskStderrPath,
			"persistent_driver_write_queue_entry",
			"",
			() =>
				writeContainerFileAtomically(
					input.containerName,
					requestPath,
					JSON.stringify(driverTaskInput, null, 2),
				),
		);
		return {
			threadId: input.laneThreadId || null,
		};
	}
	const driverTaskInput = buildDriverTaskInput();
	if (input.persistent && input.laneThreadId && persistentDriverHealth) {
		await appendContainerFile(
			input.containerName,
			driverLifecyclePath,
			`[acp-driver-lifecycle] ${new Date().toISOString()} host_driver_unhealthy task_id=${input.taskId || ""} reason=${persistentDriverHealth.reason || ""} pid=${persistentDriverHealth.pid || ""} state=${persistentDriverHealth.state || ""} lifecycle_age_ms=${persistentDriverHealth.lifecycleAgeMs ?? ""} last_lifecycle=${JSON.stringify(persistentDriverHealth.lastLifecycleLine || "")}\n`,
		).catch(() => {});
		await stopPersistentDriver({
			containerName: input.containerName,
			driverPidPath,
		});
		await quarantinePersistentDriverTaskQueue({
			containerName: input.containerName,
			taskQueueDir,
		});
	}

	await withHostBootstrapLog(taskStderrPath, "write_driver_input", "", () =>
		writeContainerFile(
			input.containerName,
			driverInputPath,
			JSON.stringify(
				{
					...driverTaskInput,
					persistent: input.persistent || false,
					taskQueueDir,
				},
				null,
				2,
			),
		),
	);
	await withHostBootstrapLog(
		taskStderrPath,
		"write_driver_launch_script",
		"",
		() =>
			writeContainerFile(
				input.containerName,
				driverLaunchPath,
				buildAcpDriverLaunchScript({
					driverScriptPath,
					driverInputPath,
					driverStdoutPath,
					driverPidPath,
					driverLifecyclePath,
					taskStdoutPath: path.posix.join(
						taskStageRootInContainer,
						runtimeFileNames.stdout,
					),
					stderrPath: path.posix.join(
						taskStageRootInContainer,
						runtimeFileNames.stderr,
					),
				}),
			),
	);
	await withHostBootstrapLog(
		taskStderrPath,
		"chmod_driver_launch_script",
		"",
		() =>
			execAsync(
				`docker exec ${input.containerName} bash -lc "chmod +x '${driverLaunchPath}'"`,
			),
	);
	await withHostBootstrapLog(taskStderrPath, "launch_driver", "", () =>
		launchDriver({
			containerName: input.containerName,
			driverLaunchPath,
		}),
	);
	await appendHostBootstrapLog(
		taskStderrPath,
		"run_single_turn_driver_launched",
	);

	return {
		threadId: null,
	};
};
