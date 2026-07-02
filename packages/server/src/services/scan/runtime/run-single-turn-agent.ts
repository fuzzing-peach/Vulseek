import { promises as fs } from "node:fs";
import path from "node:path";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ScanJob, AgentProfileLike } from "../types";
import { getAgentProfileById } from "../../ai";
import { findApplicationById } from "../../application";
import { findComposeById } from "../../compose";
import { execAsync } from "../../../utils/process/execAsync";
import { getGlobalContainerEnvironmentPairs } from "../../../utils/docker/utils";
import { prepareSandboxAgentRuntime } from "../../sandbox-agent/runtime";
import {
	createCodexRuntimeArtifacts,
	initializeCodexRuntimeMetadataFiles,
	initializeCodexRuntimeMetadataFilesInContainer,
	initializeRuntimeFiles,
	initializeRuntimeFilesInContainer,
} from "./runtime-files";
import { installRuntimeSkillsInContainer } from "./runtime-skills";
import { SANDBOX_AGENT_RUNTIME_FILE_NAMES } from "./sandbox-agent-shared";
import { findTaskByIdRepo, updateTaskRepo } from "../persistence/task.repo";
import { findStageLaneRuntimeByTaskIdRepo } from "../persistence/stage-lane-runtime.repo";
import {
	resolveStageLaneRootSegment,
	resolveTaskRootSegment,
} from "../stages/full-scan-stage.runtime";
import { resolveStageTaskName } from "../stage-task-name";
import { getArtifactSchemaAnnotations } from "../artifacts/artifact-schema-annotations";
import { SCAN_STAGE_IDS } from "../stage-metadata";

const RUNTIME_CUSTOM_SKILLS = [
	"codeql",
	"semgrep",
	"delta-scope",
	"full-scan",
	"full-scan-subagent",
	"scan-repository",
	"attack-surface-model",
	"identify-target",
	"scan-target",
	"scan-module",
	"scan-function",
	"analyze",
	"libafl",
	"build-fuzzer",
	"run-fuzzer",
	"address-sanitizer",
	"coverage-analysis",
	"criticize",
	"verify",
	"search-registries",
	"tree-sitter",
] as const;

const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const TASK_ALIAS_ROOT_IN_CONTAINER = "/task";
const TASK_PARENT_SESSION_STORE_ROOT_IN_CONTAINER =
	"/task/parent-session-store";
const STRUCTURED_OUTPUT_SCHEMA_FILE_NAME = "output.schema.json";
const STRUCTURED_OUTPUT_RESULT_FILE_NAME = "output.json";
const CODEX_HOME_IN_CONTAINER = "/root/.codex";
const CLAUDE_HOME_IN_CONTAINER = "/root/.claude";
const SANDBOX_AGENT_SESSION_STORE_DIR_NAME = "session-store";
const SANDBOX_AGENT_SESSION_PERSIST_FILE_NAME = "persist.json";
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
		stripProfileControlledCodexConfigToml(configToml),
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
	`CLAUDE_CODE_ENTRYPOINT=dokploy-vulseek`,
	...parseAgentProfileEnvPairs(agentProfile),
];

const resolveAgentsDirectory = async () => {
	const candidates = [
		path.resolve(process.cwd(), "agents"),
		path.resolve(process.cwd(), "../../agents"),
		"/app/agents",
		"/data/exp/dkzou/dokploy/agents",
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
			`[sandbox-agent-bootstrap] ${new Date().toISOString()} ${message}\n`,
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
	process.env.DOKPLOY_SCAN_CONTEXT_HOST_PATH?.trim() || "";

const resolveProjectProfileHostPath = async (input: {
	projectName: string;
	profileName: string;
}) => {
	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured. Restart dokploy-dev from dev.sh so task runtime directories can be created.",
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

const resolveScanExecutionContext = async (scanJob: ScanJob) => {
	const isApplicationJob = Boolean(scanJob.applicationId);
	const target = isApplicationJob
		? await findApplicationById(scanJob.applicationId as string)
		: await findComposeById(scanJob.composeId as string);
	const repositoryScanAgentProfileId =
		target.scanStageSettings?.[SCAN_STAGE_IDS.repositoryScan]?.agentProfileId ||
		null;
	const scanAgentProfile = repositoryScanAgentProfileId
		? await getAgentProfileById(repositoryScanAgentProfileId).catch(() => null)
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
			"Scan context host path is not configured. Restart dokploy-dev from dev.sh so /scan-context is mounted.",
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
	runtimeFileNames?: {
		jsonl: string;
		text: string;
		stderr: string;
		stdout: string;
		usage?: string;
	};
};

export type RunSingleTurnAgentInput = StageContainerInput & {
	taskId?: string;
	cwd: string;
	prompt: string | ((containerName: string) => Promise<string>);
	taskStageDirPath?: string;
	taskStageRootInContainer?: string;
	taskRealRootInContainer?: string;
	laneThreadId?: string | null;
	outputSchema?: ZodTypeAny;
	routeOutputSchemas?: Array<{
		routeKey: string;
		description?: string;
		schema: ZodTypeAny;
		default?: boolean;
	}>;
	onThreadId?: (threadId: string) => Promise<void>;
	sessionMode?: "new" | "fork";
	parentSessionId?: string | null;
	parentTaskId?: string | null;
};

export type RunSingleTurnAgentResult = {
	threadId: string | null;
};

const buildStructuredOutputEnvelopeJsonSchema = (
	schema: ZodTypeAny,
	routeOutputSchemas?: Array<{
		routeKey: string;
		description?: string;
		schema: ZodTypeAny;
		default?: boolean;
	}>,
	options?: {
		nullableOutput?: boolean;
	},
) => {
	const buildOutputSchema = (outputSchema: ZodTypeAny) =>
		zodToJsonSchema(outputSchema, {
			target: "jsonSchema7",
			$refStrategy: "none",
		});
	const buildEnvelopeOutputSchema = (outputSchema: ZodTypeAny) => {
		const jsonSchema = buildOutputSchema(outputSchema);
		return options?.nullableOutput
			? { anyOf: [jsonSchema, { type: "null" }] }
			: jsonSchema;
	};
	const buildEnvelopeSchema = (input: {
		route: string | null;
		outputSchema: ZodTypeAny;
	}) => ({
		type: "object",
		properties: {
			route:
				input.route === null
					? { type: "null" }
					: { type: "string", const: input.route },
			exit: { type: "boolean" },
			output: buildEnvelopeOutputSchema(input.outputSchema),
		},
		required: ["route", "exit", "output"],
		additionalProperties: false,
		$schema: "http://json-schema.org/draft-07/schema#",
	});
	return routeOutputSchemas?.length
		? {
				anyOf: routeOutputSchemas.map((item) =>
					buildEnvelopeSchema({
						route: item.routeKey,
						outputSchema: item.schema,
					}),
				),
				$schema: "http://json-schema.org/draft-07/schema#",
			}
		: buildEnvelopeSchema({ route: null, outputSchema: schema });
};

const buildArtifactSchemaPromptLines = (
	schema: ZodTypeAny,
	routeOutputSchemas?: Array<{
		routeKey: string;
		description?: string;
		schema: ZodTypeAny;
		default?: boolean;
	}>,
) => {
	const entries = routeOutputSchemas?.length
		? routeOutputSchemas.flatMap((route) =>
				getArtifactSchemaAnnotations(route.schema).map((annotation) => ({
					routeKey: route.routeKey,
					...annotation,
				})),
			)
		: getArtifactSchemaAnnotations(schema).map((annotation) => ({
				routeKey: null,
				...annotation,
			}));
	if (entries.length === 0) {
		return [];
	}
	return [
		"",
		"Task artifact JSON schemas:",
		"- Some output fields are task artifact paths. For each such path, write a JSON file at that path whose content matches the schema below.",
		"- Validate both output.json and every referenced task artifact JSON file before ending your turn.",
		...entries.flatMap((entry, index) => [
			`- ${entry.routeKey ? `route ${entry.routeKey} ` : ""}${entry.path} points to ${entry.kind === "path_list" ? "JSON files" : "a JSON file"} matching artifact schema ${index + 1}:`,
			"```json",
			JSON.stringify(entry.jsonSchema, null, 2),
			"```",
		]),
	];
};

export const buildStructuredOutputPromptSuffix = (
	schema: ZodTypeAny,
	schemaFilePath: string,
	outputFilePath: string,
	routeOutputSchemas?: Array<{
		routeKey: string;
		description?: string;
		schema: ZodTypeAny;
		default?: boolean;
	}>,
	options?: {
		persistent?: boolean;
		groupedPersistent?: boolean;
		allowAgentExit?: boolean;
		nullableOutput?: boolean;
	},
) => {
	const jsonSchema = buildStructuredOutputEnvelopeJsonSchema(
		schema,
		routeOutputSchemas,
		{ nullableOutput: options?.nullableOutput },
	);
	const artifactSchemaLines = buildArtifactSchemaPromptLines(
		schema,
		routeOutputSchemas,
	);

	return [
		"",
		"Structured JSON output requirement:",
		`- Write the final structured result to ${outputFilePath}.`,
		"- The output file content must be only a JSON object, with no markdown fences, comments, or prose.",
		"- The top-level JSON object must be an envelope with exactly these fields: route, exit, output.",
		...(options?.nullableOutput
			? [
					"- If this stage has no structured result to return, output may be null.",
					"- Even when output is null, you must still write the complete route/exit/output envelope to output.json.",
				]
			: []),
		...(options?.allowAgentExit
			? [
					"- Set exit to true only when the stage prompt explicitly instructs this analysis workflow to exit; otherwise set exit to false.",
				]
			: ["- Set exit to false."]),
		`- The JSON Schema for the complete output.json envelope is written to ${schemaFilePath}.`,
		"- You must use that schema file as the source of truth and validate output.json against it before ending your turn.",
		"- Perform validation with Python and the jsonschema package available in the container environment.",
		`- Load ${outputFilePath}, load ${schemaFilePath}, and validate it locally with python before ending your turn.`,
		"- During validation, do not print the full JSON object to the terminal or write it to a tool-output file; print only a short success/failure line.",
		"- If validation fails, fix the JSON and validate again before returning.",
		"- The output.json envelope must conform exactly to that JSON Schema.",
		"- Do not add extra fields outside the schema.",
		"- Use null for nullable fields instead of omitting them unless the schema explicitly allows omission.",
		...artifactSchemaLines,
		...(routeOutputSchemas?.length
			? [
					"",
					"Dynamic route requirement:",
					"- Choose exactly one of the route keys below and set output.json route to that value.",
					"- The output object must match the object type for the route you choose.",
					"- If you cannot decide, use the route marked default.",
					...routeOutputSchemas.map(
						(item) =>
							`- ${item.routeKey}${item.default ? " (default)" : ""}: ${item.description || "no description"}`,
					),
				]
			: ["- This stage has no dynamic route; set output.json route to null."]),
		"- Do not include any runtime markers in your final response. Dokploy will wait for end_turn and then read output.json.",
		"",
		"```json",
		JSON.stringify(jsonSchema, null, 2),
		"```",
	].join("\n");
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
	const runtimeFileNames = {
		...SANDBOX_AGENT_RUNTIME_FILE_NAMES,
		...(input.runtimeFileNames || {}),
	};
	const containerNetworkArg = await resolveCurrentDockerNetworkArg();
	const containerEnvArgs = containerEnvPairs
		.map((pair) => {
			const escaped = pair.replace(/'/g, `"'"'`);
			return `-e '${escaped}'`;
		})
		.join(" ");

	const jsonlPath = path.join(input.stageDirPath, runtimeFileNames.jsonl);
	const textPath = path.join(input.stageDirPath, runtimeFileNames.text);
	const stderrPath = path.join(input.stageDirPath, runtimeFileNames.stderr);
	const stdoutPath = path.join(input.stageDirPath, runtimeFileNames.stdout);
	const usagePath = path.join(input.stageDirPath, runtimeFileNames.usage);
	const containerBootstrapPath = path.join(
		input.stageDirPath,
		CONTAINER_BOOTSTRAP_LOG_FILE_NAME,
	);
	const runtimeArtifacts = createCodexRuntimeArtifacts({
		runtimeDir: input.stageDirPath,
		jsonlFileName: runtimeFileNames.jsonl,
		textFileName: runtimeFileNames.text,
		stderrFileName: runtimeFileNames.stderr,
		stdoutFileName: runtimeFileNames.stdout,
		usageFileName: runtimeFileNames.usage,
	});

	const memoryArgs = [
		target.memoryLimit ? `--memory ${target.memoryLimit}` : null,
		target.memoryReservation ? `--memory-reservation ${target.memoryReservation}` : null,
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
		jsonlPath,
		textPath,
		stderrPath,
		stdoutPath,
		usagePath,
		containerBootstrapPath,
		runtimeArtifacts,
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

	await withHostBootstrapLog(logPath, "runtime_files_initialized_on_host", "", () =>
		initializeRuntimeFiles({
			runtimeDir: input.stageDirPath,
			jsonlPath: runtime.jsonlPath,
			textPath: runtime.textPath,
			stderrPath: runtime.stderrPath,
			stdoutPath: runtime.stdoutPath,
			usagePath: runtime.runtimeArtifacts.usagePath,
		}),
	);
	await withHostBootstrapLog(logPath, "metadata_files_initialized_on_host", "", () =>
		initializeCodexRuntimeMetadataFiles({
			cursorPath: runtime.runtimeArtifacts.cursorPath,
			statePath: runtime.runtimeArtifacts.statePath,
		}),
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

	await withHostBootstrapLog(
		logPath,
		"runtime_files_initialized_in_container",
		"",
		() =>
			initializeRuntimeFilesInContainer({
				containerName: input.containerName,
				runtimeDirInContainer: input.stageRootInContainer,
				jsonlFileName: runtime.runtimeArtifacts.jsonlFileName,
				textFileName: runtime.runtimeArtifacts.textFileName,
				stderrFileName: runtime.runtimeArtifacts.stderrFileName,
				stdoutFileName: runtime.runtimeArtifacts.stdoutFileName,
				usageFileName: runtime.runtimeArtifacts.usageFileName,
			}),
	);
	await withHostBootstrapLog(
		logPath,
		"metadata_files_initialized_in_container",
		"",
		() =>
			initializeCodexRuntimeMetadataFilesInContainer({
				containerName: input.containerName,
				runtimeDirInContainer: input.stageRootInContainer,
				cursorFileName: runtime.runtimeArtifacts.cursorFileName,
				stateFileName: runtime.runtimeArtifacts.stateFileName,
				writeContainerFile,
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

const SANDBOX_AGENT_DRIVER_FILE_NAME = "sandbox-agent-driver.mjs";
const SANDBOX_AGENT_DRIVER_INPUT_FILE_NAME = "sandbox-agent-driver-input.json";
const SANDBOX_AGENT_DRIVER_STDOUT_FILE_NAME = "sandbox-agent-driver-stdout.log";
const SANDBOX_AGENT_DRIVER_LAUNCH_FILE_NAME = "sandbox-agent-driver-launch.sh";
const SANDBOX_AGENT_DRIVER_PID_FILE_NAME = "sandbox-agent-driver.pid";
const SANDBOX_AGENT_DRIVER_LIFECYCLE_FILE_NAME =
	"sandbox-agent-driver-lifecycle.log";
const CONTAINER_BOOTSTRAP_LOG_FILE_NAME = "container-bootstrap.log";
const SANDBOX_AGENT_DRIVER_TASK_DIR_NAME = "sandbox-agent-driver-tasks";
const SANDBOX_AGENT_AGENT_HOME_DIR_NAME = "agent-home";
const SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;
const SANDBOX_AGENT_DRIVER_VERSION = "2026-06-01-fork-model-alias-v1";

const buildSandboxAgentDriverScript =
	() => String.raw`import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const SANDBOX_AGENT_DRIVER_VERSION = "${SANDBOX_AGENT_DRIVER_VERSION}";
const SANDBOX_AGENT_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
const SANDBOX_AGENT_POST_PROMPT_EVENT_IDLE_MS = 30 * 1000;
const SANDBOX_AGENT_POST_PROMPT_EVENT_POLL_MS = 100;
const DEFAULT_TASK_ALIAS_ROOT_IN_CONTAINER = "/task";

const acpFetch = async (input, init = {}) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const transport = url.protocol === "https:" ? https : http;
  const bodyBuffer =
    request.method === "GET" || request.method === "HEAD"
      ? null
      : Buffer.from(await request.arrayBuffer());

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback) => {
      if (settled) {
        return;
      }
      settled = true;
      request.signal.removeEventListener("abort", onAbort);
      callback();
    };
    const fail = (error) => finish(() => reject(error));
    const onAbort = () => {
      req.destroy(new Error("sandbox-agent fetch aborted"));
      fail(new Error("sandbox-agent fetch aborted"));
    };

    const req = transport.request(
      url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers.entries()),
      },
      (res) => {
        finish(() =>
          resolve(
            new Response(Readable.toWeb(res), {
              status: res.statusCode || 0,
              statusText: res.statusMessage || "",
              headers: res.headers,
            }),
          ),
        );
        res.on("error", fail);
      },
    );

    req.on("error", fail);

    if (request.signal.aborted) {
      onAbort();
      return;
    }
    request.signal.addEventListener("abort", onAbort, { once: true });

    if (bodyBuffer && bodyBuffer.length > 0) {
      req.write(bodyBuffer);
    }
    req.end();
  });
};

const asRecord = (value) =>
  value && typeof value === "object" ? value : null;

const asString = (value) => (typeof value === "string" ? value : "");

const appendScanRuntimeFile = async (filePath, content) => {
  if (!content) return;
  await fs.appendFile(filePath, content, "utf-8");
};

const formatSandboxAgentSessionEvent = (event) =>
  JSON.stringify(event) + String.fromCharCode(10);

const getEventPayloadRecord = (event) => asRecord(event.payload);
const getEventParamsRecord = (event) => asRecord(getEventPayloadRecord(event)?.params);
const getEventUpdate = (event) => {
  const paramsUpdate = getEventParamsRecord(event)?.update;
  return paramsUpdate !== undefined ? paramsUpdate : event.payload;
};

const isAgentThoughtChunkEvent = (event) => {
  const update = getEventUpdate(event);
  return asString(asRecord(update)?.sessionUpdate) === "agent_thought_chunk";
};

const extractTextValue = (value) => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(extractTextValue).join("");
  if (!value || typeof value !== "object") return "";
  return [value.text, value.value, value.content].map(extractTextValue).find(Boolean) || "";
};

const extractPayloadText = (payload) => {
  if (typeof payload === "string") return payload;
  if (Array.isArray(payload)) {
    return payload.map(extractPayloadText).join("");
  }
  const record = asRecord(payload);
  if (!record) return "";
  return (
    extractTextValue(record.content) ||
    extractTextValue(record.delta) ||
    extractTextValue(record.message) ||
    extractTextValue(record.result) ||
    extractTextValue(record.text) ||
    extractTextValue(record.value)
  );
};

const extractRawOutputText = (rawOutput) => {
  const record = asRecord(rawOutput);
  if (!record) return extractTextValue(rawOutput);
  const lines = [];
  const exitCode = record.exit_code ?? record.exitCode ?? record.code;
  const status = asString(record.status);
  if (exitCode !== undefined) lines.push("exit_code: " + String(exitCode));
  if (status) lines.push("status: " + status);
  const stderr = extractTextValue(record.stderr);
  if (stderr) lines.push("stderr:\n" + stderr);
  const stdout =
    extractTextValue(record.stdout) ||
    extractTextValue(record.aggregated_output) ||
    extractTextValue(record.aggregatedOutput) ||
    extractTextValue(record.output);
  if (stdout) lines.push("output:\n" + stdout);
  return lines.join("\n") || extractTextValue(rawOutput);
};

const mergeToolTextWithRawOutput = (text, record) => {
  const rawOutputText = extractRawOutputText(record?.rawOutput);
  if (!rawOutputText) return text;
  if (!text) return rawOutputText;
  if (text.includes(rawOutputText) || rawOutputText.includes(text)) {
    return text;
  }
  return text + "\nrawOutput:\n" + rawOutputText;
};

const getEventRenderKey = (event) => {
  const update = getEventUpdate(event);
  const record = asRecord(update);
  const updateType = asString(record?.sessionUpdate);
  const toolCallId = asString(record?.toolCallId);
  const itemId =
    asString(record?.itemId) ||
    asString(record?.item?.id) ||
    asString(record?.messageId) ||
    asString(record?.id);
  return [updateType || "event", toolCallId, itemId, asString(record?.kind)]
    .filter(Boolean)
    .join(":");
};

const filterRenderedSandboxAgentText = (state, event, rendered) => {
  if (!rendered || !rendered.trim()) {
    return "";
  }
  const key = getEventRenderKey(event);
  if (key) {
    const previous = state.renderedTextByKey[key] || "";
    if (previous === rendered) {
      return "";
    }
    state.renderedTextByKey[key] = rendered;
    const updateType = asString(asRecord(getEventUpdate(event))?.sessionUpdate);
    if (
      previous &&
      (updateType === "agent_message_chunk" ||
        updateType === "agent_thought_chunk" ||
        updateType === "user_message_chunk") &&
      rendered.startsWith(previous)
    ) {
      return rendered.slice(previous.length);
    }
  }
  if (state.lastRenderedText === rendered) {
    return "";
  }
  state.lastRenderedText = rendered;
  return rendered;
};

const renderSandboxAgentEvent = (event, state) => {
  const update = getEventUpdate(event);
  const record = asRecord(update);
  const updateType = asString(record?.sessionUpdate);
  const text = extractPayloadText(update);
  let rendered = "";
  switch (updateType) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "user_message_chunk":
      rendered = text;
      break;
    case "tool_call":
    case "tool_call_update": {
      const toolText = mergeToolTextWithRawOutput(text, record);
      rendered = toolText ? "\n[tool] " + toolText + "\n" : "";
      break;
    }
    case "plan":
      rendered = text ? "\n[plan] " + text + "\n" : "";
      break;
    case "usage_update":
    case "session_info_update":
      rendered = "";
      break;
    default:
      rendered = text;
      break;
  }
  return state ? filterRenderedSandboxAgentText(state, event, rendered) : rendered;
};

const byteLength = (value) => Buffer.byteLength(value, "utf-8");

const withTimeout = async (promise, timeoutMs, errorFactory) => {
  let timeout = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(errorFactory()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

const withHeartbeat = async (promise, intervalMs, heartbeat) => {
  let interval = null;
  try {
    interval = setInterval(() => {
      void heartbeat().catch(() => {});
    }, intervalMs);
    return await promise;
  } finally {
    if (interval) clearInterval(interval);
  }
};

const appendSessionEvent = async (paths, state, event) => {
  state.eventCount += 1;
  state.lastEventAt = Date.now();
  if (!isAgentThoughtChunkEvent(event)) {
    await appendScanRuntimeFile(paths.jsonlPath, formatSandboxAgentSessionEvent(event));
  }
  const rendered = renderSandboxAgentEvent(event, state);
  if (rendered) {
    await appendScanRuntimeFile(paths.textPath, rendered);
  }
  const update = getEventUpdate(event);
  const payloadRecord = asRecord(update);
  const sessionUpdate = asString(payloadRecord?.sessionUpdate);
  const toolCallId = asString(payloadRecord?.toolCallId);
  state.lastEventSummary = {
    eventIndex: event.eventIndex ?? null,
    createdAt: event.createdAt || null,
    sender: event.sender || null,
    sessionUpdate: sessionUpdate || null,
    kind: asString(payloadRecord?.kind) || null,
    status: asString(payloadRecord?.status) || null,
    toolCallId: toolCallId || null,
  };
  if (toolCallId && sessionUpdate === "tool_call") {
    state.activeToolCalls[toolCallId] = {
      toolCallId,
      title: asString(payloadRecord?.title).slice(0, 240) || null,
      startedAt: event.createdAt || new Date().toISOString(),
      eventIndex: event.eventIndex ?? null,
    };
  } else if (
    toolCallId &&
    sessionUpdate === "tool_call_update" &&
    ["completed", "failed", "cancelled"].includes(asString(payloadRecord?.status))
  ) {
    delete state.activeToolCalls[toolCallId];
  }
  if (sessionUpdate === "agent_message_chunk") {
    const chunkText = extractPayloadText(update);
    state.agentMessageText += chunkText;
  }
  const eventPayloadRecord = getEventPayloadRecord(event);
  const resultRecord = asRecord(eventPayloadRecord?.result);
  if (asString(resultRecord?.stopReason) === "end_turn") {
    state.endTurnReceived = true;
    state.endTurnEventIndex = event.eventIndex ?? null;
  }
};

const appendDriverLog = async (stderrPath, message) => {
  await appendScanRuntimeFile(
    stderrPath,
    "[sandbox-agent-driver] " + new Date().toISOString() + " " + message + "\n",
  );
};

const formatErrorForLifecycle = (error) => {
  if (error instanceof Error) return error.stack || error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const appendDriverLifecycleLog = async (input, message) => {
  const logPath = input?.driverLifecyclePath || input?.stderrPath;
  if (!logPath) return;
  await appendScanRuntimeFile(
    logPath,
    "[sandbox-agent-driver-lifecycle] " +
      new Date().toISOString() +
      " pid=" +
      String(process.pid) +
      " " +
      message +
      "\n",
  );
};

const appendDriverLifecycleLogSync = (input, message) => {
  const logPath = input?.driverLifecyclePath || input?.stderrPath;
  if (!logPath) return;
  try {
    fsSync.appendFileSync(
      logPath,
      "[sandbox-agent-driver-lifecycle] " +
        new Date().toISOString() +
        " pid=" +
        String(process.pid) +
        " " +
        message +
        "\n",
      "utf-8",
    );
  } catch {}
};

const resolveTaskRuntimeDir = (taskInput) => {
  const explicitRoot = asString(taskInput?.taskStageRootInContainer);
  if (explicitRoot) {
    return explicitRoot;
  }
  const runtimeFilePath =
    asString(taskInput?.structuredOutputResultPathInContainer) ||
    asString(taskInput?.jsonlPath) ||
    asString(taskInput?.stderrPath);
  return runtimeFilePath ? path.dirname(runtimeFilePath) : "";
};

const updateTaskAliasSymlink = async (taskInput) => {
  const aliasRoot =
    asString(taskInput?.taskAliasRootInContainer) ||
    DEFAULT_TASK_ALIAS_ROOT_IN_CONTAINER;
  const taskRuntimeDir = resolveTaskRuntimeDir(taskInput);
  if (!aliasRoot || !taskRuntimeDir || aliasRoot === taskRuntimeDir) {
    return;
  }
  await fs.mkdir(taskRuntimeDir, { recursive: true });
  await fs.rm(aliasRoot, { recursive: true, force: true });
  await fs.symlink(taskRuntimeDir, aliasRoot, "dir");
  await appendDriverLifecycleLog(
    taskInput,
    "task_alias_updated alias_root=" +
      aliasRoot +
      " target=" +
      taskRuntimeDir +
      " task_id=" +
      String(taskInput?.taskId || ""),
  ).catch(() => {});
};

const getEventSessionUpdate = (event) => {
  const update = getEventUpdate(event);
  return asString(asRecord(update)?.sessionUpdate);
};

const getEventStopReason = (event) => {
  const payload = getEventPayloadRecord(event);
  return asString(asRecord(payload?.result)?.stopReason);
};

const summarizeEventForDiagnostics = (event) => {
  const update = getEventUpdate(event);
  const updateRecord = asRecord(update) || {};
  return (
    "event_index=" +
    String(event?.eventIndex ?? "") +
    " session_id=" +
    String(event?.sessionId ?? "") +
    " connection_id=" +
    String(event?.connectionId ?? "") +
    " sender=" +
    String(event?.sender ?? "") +
    " session_update=" +
    String(asString(updateRecord.sessionUpdate)) +
    " status=" +
    String(asString(updateRecord.status)) +
    " tool_call_id=" +
    String(asString(updateRecord.toolCallId)) +
    " stop_reason=" +
    String(getEventStopReason(event))
  );
};

const shouldLogEventDiagnostic = (count, event) => {
  if (count <= 5 || count % 100 === 0) return true;
  const sessionUpdate = getEventSessionUpdate(event);
  return (
    getEventStopReason(event) === "end_turn" ||
    sessionUpdate === "tool_call" ||
    sessionUpdate === "tool_call_update"
  );
};

const sleep = async (ms) =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const createTaskState = () => ({
  agentMessageText: "",
  activeToolCalls: {},
  exitRequested: false,
  endTurnReceived: false,
  endTurnEventIndex: null,
  eventCount: 0,
  lastEventAt: 0,
  lastEventSummary: null,
  lastRenderedText: "",
  renderedTextByKey: {},
  outputFile: null,
});

const inspectOutputEnvelopeFile = async (filePath) => {
  const result = {
    path: filePath,
    exists: false,
    validJson: false,
    validEnvelope: false,
    route: null,
    exit: false,
    error: null,
  };
  try {
    const content = await fs.readFile(filePath, "utf-8");
    result.exists = true;
    let parsed;
    try {
      parsed = JSON.parse(content);
      result.validJson = true;
    } catch (error) {
      result.error = "Invalid output.json: " + (error instanceof Error ? error.message : String(error));
      return result;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      result.error = "output.json must be a JSON object";
      return result;
    }
    if (!("route" in parsed) || !(parsed.route === null || typeof parsed.route === "string")) {
      result.error = "output.json route must be a string or null";
      return result;
    }
    if (typeof parsed.exit !== "boolean") {
      result.error = "output.json exit must be boolean";
      return result;
    }
    if (!("output" in parsed)) {
      result.error = "output.json output field is required";
      return result;
    }
    result.validEnvelope = true;
    result.route = parsed.route;
    result.exit = parsed.exit;
    return result;
  } catch (error) {
    result.error = "output.json not found or unreadable: " + (error instanceof Error ? error.message : String(error));
    return result;
  }
};

const writeNullableOutputFallbackIfMissing = async (taskInput, state) => {
  if (!taskInput.nullableOutput || !state.endTurnReceived) {
    return null;
  }
  const outputFile = await inspectOutputEnvelopeFile(
    taskInput.structuredOutputResultPathInContainer,
  );
  if (outputFile.exists) {
    return outputFile;
  }
  await fs.writeFile(
    taskInput.structuredOutputResultPathInContainer,
    JSON.stringify({ route: null, exit: false, output: null }, null, 2) + "\\n",
    "utf-8",
  );
  await appendDriverLog(
    taskInput.stderrPath,
    "nullable output fallback wrote output.json with output=null",
  );
  return await inspectOutputEnvelopeFile(
    taskInput.structuredOutputResultPathInContainer,
  );
};

const writeTaskStateFile = async (taskInput, state, extra = {}) => {
  if (!taskInput.statePath) return;
  await fs.writeFile(
    taskInput.statePath,
    JSON.stringify(
      {
        promptFinished: Boolean(state.promptFinished),
        endTurnReceived: Boolean(state.endTurnReceived),
        endTurnEventIndex: state.endTurnEventIndex ?? null,
        eventCount: state.eventCount || 0,
        lastEventAt: state.lastEventAt || null,
        lastEventAgeMs:
          state.lastEventAt > 0 ? Math.max(0, Date.now() - state.lastEventAt) : null,
        lastEventSummary: state.lastEventSummary || null,
        activeToolCalls: Object.values(state.activeToolCalls || {}),
        outputFile: state.outputFile || null,
        completedAt: state.completedAt || null,
        ...extra,
      },
      null,
      2,
    ) + "\n",
    "utf-8",
  );
};

const inheritForkRuntimeArtifactsOnce = async (taskInput, sessionId) => {
  if (taskInput.sessionMode !== "fork") {
    return;
  }
  const parentSessionId = asString(taskInput.parentSessionId);
  if (!parentSessionId || !taskInput.parentSessionPersistPath) {
    await appendDriverLifecycleLog(
      taskInput,
      "fork_inheritance_skipped parent_agent_session_id=" +
        parentSessionId +
        " reason=missing_parent_artifacts",
    );
    return;
  }
  const markerPath =
    (taskInput.statePath || taskInput.jsonlPath || "") + ".fork-inheritance.done";
  const markerExists = markerPath ? Boolean(await fs.stat(markerPath).catch(() => null)) : false;
  if (markerExists) {
    await appendDriverLifecycleLog(
      taskInput,
      "fork_inheritance_skipped parent_agent_session_id=" +
        parentSessionId +
        " child_agent_session_id=" +
        sessionId +
        " reason=already_inherited",
    );
    return;
  }
  if (markerPath) {
    await fs.writeFile(
      markerPath,
      JSON.stringify(
        {
          inheritedAt: new Date().toISOString(),
          parentAgentSessionId: parentSessionId,
          childAgentSessionId: sessionId,
          jsonl: {
            copied: false,
            bytes: 0,
            reason: "disabled",
          },
          text: {
            copied: false,
            bytes: 0,
            reason: "parent_runtime_disabled",
          },
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    ).catch(() => {});
  }
  await appendDriverLifecycleLog(
    taskInput,
    "fork_inheritance_complete parent_agent_session_id=" +
      parentSessionId +
      " child_agent_session_id=" +
      sessionId +
      " jsonl_copied=false jsonl_bytes=0 jsonl_reason=disabled" +
      " text_copied=false text_bytes=0 text_reason=parent_runtime_disabled",
  );
};

const extractQueuedTaskId = (content) => {
  const match = content.match(/"taskId"\s*:\s*"([^"]+)"/);
  return match ? match[1] : "";
};

const formatQueueReadFailureLog = (value) =>
  String(value).replace(/\s+/g, " ").slice(0, 1000);

const readNextPersistentTaskInput = async (taskQueueDir, lifecycleInput) => {
  await fs.mkdir(taskQueueDir, { recursive: true });
  const entries = (await fs.readdir(taskQueueDir))
    .filter(
      (entry) =>
        entry.endsWith(".json") &&
        !entry.endsWith(".running.json") &&
        !entry.endsWith(".done.json") &&
        !entry.endsWith(".failed.json") &&
        !entry.endsWith(".failed.reason.json"),
    )
    .sort();
  for (const entry of entries) {
    const taskPath = path.join(taskQueueDir, entry);
    const runningPath = taskPath.replace(/\.json$/, ".running.json");
    try {
      await fs.rename(taskPath, runningPath);
      let rawInput = "";
      try {
        rawInput = await fs.readFile(runningPath, "utf-8");
        const taskInput = JSON.parse(rawInput);
        taskInput.__queueEntry = entry;
        taskInput.__queueRunningPath = runningPath;
        await fs.rename(runningPath, runningPath.replace(/\.running\.json$/, ".done.json")).catch(() => {});
        return taskInput;
      } catch (error) {
        const failedPath = runningPath.replace(/\.running\.json$/, ".failed.json");
        const taskId = extractQueuedTaskId(rawInput);
        await fs.rename(runningPath, failedPath).catch(() => {});
        const reasonPath = failedPath.replace(/\.failed\.json$/, ".failed.reason.json");
        await fs.writeFile(
          reasonPath,
          JSON.stringify(
            {
              taskId: taskId || null,
              queueEntry: entry,
              taskPath,
              runningPath,
              failedPath,
              rawBytes: byteLength(rawInput),
              error: formatErrorForLifecycle(error),
              failedAt: new Date().toISOString(),
            },
            null,
            2,
          ) + "\n",
          "utf-8",
        ).catch(() => {});
        await appendDriverLifecycleLog(
          lifecycleInput,
          "queue_task_read_failed task_id=" +
            taskId +
            " queue_entry=" +
            entry +
            " running_path=" +
            runningPath +
            " failed_path=" +
            failedPath +
            " raw_bytes=" +
            String(byteLength(rawInput)) +
            " error=" +
            formatQueueReadFailureLog(formatErrorForLifecycle(error)),
        );
      }
    } catch (error) {
      await appendDriverLifecycleLog(
        lifecycleInput,
        "queue_task_claim_failed queue_entry=" +
          entry +
          " task_path=" +
          taskPath +
          " running_path=" +
          runningPath +
          " error=" +
          formatQueueReadFailureLog(formatErrorForLifecycle(error)),
      );
    }
  }
  return null;
};

const waitForPostPromptEventDrain = async (input, state, getEventWriteChain) => {
  const startedAt = Date.now();
  let logged = false;
  let loggedEndTurn = false;
  let stopReason = "end_turn";
  while (!state.endTurnReceived) {
    if (!logged) {
      logged = true;
      await appendDriverLog(
        input.stderrPath,
        "waiting for post-prompt events after prompt resolved idle_ms=" +
          String(SANDBOX_AGENT_POST_PROMPT_EVENT_IDLE_MS),
      );
    }
    await getEventWriteChain();

    if (state.endTurnReceived) {
      if (!loggedEndTurn) {
        loggedEndTurn = true;
        await appendDriverLog(
          input.stderrPath,
          "received end_turn event index=" + String(state.endTurnEventIndex ?? ""),
        );
      }
      break;
    }

    const now = Date.now();
    const lastEventAt = state.lastEventAt || startedAt;
    if (now - lastEventAt >= SANDBOX_AGENT_POST_PROMPT_EVENT_IDLE_MS) {
      stopReason = "idle";
      break;
    }

    await sleep(SANDBOX_AGENT_POST_PROMPT_EVENT_POLL_MS);
  }
  await getEventWriteChain();
  if (!state.endTurnReceived) {
    const now = Date.now();
    const lastEventAt = state.lastEventAt || startedAt;
    await appendDriverLog(
      input.stderrPath,
      "post-prompt event drain stopped reason=" +
        stopReason +
        " elapsed_ms=" +
        String(now - startedAt) +
        " idle_ms=" +
        String(now - lastEventAt) +
        " events=" +
        String(state.eventCount || 0) +
        " end_turn=" +
        String(Boolean(state.endTurnReceived)),
    );
  }
};

const getPermissionRequestId = (request) =>
  asString(request?.id) ||
  asString(request?.permissionId) ||
  asString(asRecord(request?.permission)?.id) ||
  asString(asRecord(request?.rawRequest)?.id);

const autoApprovePermissionRequest = async (session, input, request) => {
  const permissionId = getPermissionRequestId(request);
  if (!permissionId) {
    await appendScanRuntimeFile(
      input.stderrPath,
      "[sandbox-agent-permission] unable to auto-approve permission without id\n",
    );
    return;
  }

  const availableReplies = Array.isArray(request?.availableReplies)
    ? request.availableReplies
        .map((reply) => String(reply))
        .filter((reply) => reply.length > 0)
    : [];
  const replies = [
    ...availableReplies.filter((reply) => reply === "always"),
    ...availableReplies.filter((reply) => reply === "once"),
    "always",
    "once",
  ].filter((reply, index, values) => values.indexOf(reply) === index);

  for (const reply of replies) {
    try {
      await session.respondPermission(permissionId, reply);
      await appendDriverLog(
        input.stderrPath,
        "auto-approved permission id=" + permissionId + " reply=" + reply,
      );
      return;
    } catch (error) {
      await appendScanRuntimeFile(
        input.stderrPath,
        "[sandbox-agent-permission] auto-approve attempt failed id=" +
          permissionId +
          " reply=" +
          reply +
          " error=" +
          (error instanceof Error ? error.message : String(error)) +
          "\n",
      );
    }
  }
};

class FileSessionPersistDriver {
  constructor(filePath) {
    this.filePath = filePath;
    this.rootDir = path.dirname(filePath);
    this.sessionsDir = path.join(this.rootDir, "sessions");
    this.lockPath = path.join(this.rootDir, ".persist.lock");
    this.insertEventCount = 0;
    this.diagnosticPath = path.join(this.rootDir, "persist-diagnostics.log");
  }

  encodeSessionId(sessionId) {
    return encodeURIComponent(String(sessionId));
  }

  decodeSessionId(sessionDirName) {
    try {
      return decodeURIComponent(String(sessionDirName));
    } catch {
      return String(sessionDirName);
    }
  }

  sessionDir(sessionId) {
    return path.join(this.sessionsDir, this.encodeSessionId(sessionId));
  }

  sessionJournalPath(sessionId) {
    return path.join(this.sessionDir(sessionId), "session.jsonl");
  }

  eventJournalPath(sessionId) {
    return path.join(this.sessionDir(sessionId), "events.jsonl");
  }

  async appendJsonLine(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, JSON.stringify(value) + "\n", "utf-8");
  }

  async readJsonl(filePath) {
    let content = "";
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const items = [];
    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        items.push(JSON.parse(line));
      } catch {
        // Ignore a partial trailing line from an interrupted append.
      }
    }
    return items;
  }

  async readLegacyData() {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf-8"));
      return {
        sessions: asRecord(parsed.sessions) || {},
        eventsBySession: asRecord(parsed.eventsBySession) || {},
      };
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        return { sessions: {}, eventsBySession: {} };
      }
      throw error;
    }
  }

  normalizeSessionJournalEntry(entry) {
    if (!entry || typeof entry !== "object") {
      return null;
    }
    if (entry.__op === "renamed") {
      return { op: "renamed", oldId: entry.oldId, newId: entry.newId };
    }
    if (entry.__op === "save_session") {
      return entry.session && typeof entry.session === "object"
        ? entry.session
        : null;
    }
    return entry;
  }

  async readSessionFromJournal(sessionId) {
    const entries = await this.readJsonl(this.sessionJournalPath(sessionId));
    let latest = null;
    for (const entry of entries) {
      const normalized = this.normalizeSessionJournalEntry(entry);
      if (!normalized) {
        continue;
      }
      if (normalized.op === "renamed") {
        latest = null;
        continue;
      }
      latest = normalized;
    }
    return latest;
  }

  async readEvents(sessionId) {
    const legacy = await this.readLegacyData();
    const legacyEvents = Array.isArray(legacy.eventsBySession[sessionId])
      ? legacy.eventsBySession[sessionId]
      : [];
    const journalEvents = await this.readJsonl(this.eventJournalPath(sessionId));
    return [...legacyEvents, ...journalEvents];
  }

  async listSessionIdsFromDirectories() {
    const entries = await fs.readdir(this.sessionsDir, { withFileTypes: true }).catch(
      () => [],
    );
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.decodeSessionId(entry.name));
  }

  async readData() {
    const legacy = await this.readLegacyData();
    const sessions = { ...legacy.sessions };
    const eventsBySession = { ...legacy.eventsBySession };
    const sessionIds = new Set([
      ...Object.keys(legacy.sessions),
      ...Object.keys(legacy.eventsBySession),
      ...(await this.listSessionIdsFromDirectories()),
    ]);
    for (const sessionId of sessionIds) {
      const journalSession = await this.readSessionFromJournal(sessionId);
      if (journalSession) {
        sessions[sessionId] = journalSession;
      }
      const events = await this.readEvents(sessionId);
      if (events.length) {
        eventsBySession[sessionId] = events;
      }
    }
    return { sessions, eventsBySession };
  }

  async withLock(callback) {
    const deadline = Date.now() + 30000;
    while (true) {
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.mkdir(this.lockPath, { recursive: false });
        await fs.writeFile(
          path.join(this.lockPath, "owner.json"),
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
          "utf-8",
        );
        break;
      } catch (error) {
        if (!(error && typeof error === "object" && error.code === "EEXIST")) {
          throw error;
        }
        const stat = await fs.stat(this.lockPath).catch(() => null);
        const stale =
          stat && Date.now() - Number(stat.mtimeMs || 0) > 30000;
        if (stale) {
          await fs.rm(this.lockPath, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        if (Date.now() > deadline) {
          throw error;
        }
        await sleep(100);
      }
    }

    try {
      return await callback();
    } finally {
      await fs.rm(this.lockPath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async getSession(id) {
    const sessionId = asString(id);
    if (!sessionId) {
      return undefined;
    }
    const journalSession = await this.readSessionFromJournal(sessionId);
    if (journalSession) {
      return journalSession;
    }
    const legacy = await this.readLegacyData();
    return legacy.sessions[sessionId];
  }

  async listSessions(request = {}) {
    const data = await this.readData();
    const items = Object.values(data.sessions).sort(
      (left, right) => (left.createdAt || 0) - (right.createdAt || 0),
    );
    const cursor = Number.parseInt(String(request.cursor || "0"), 10) || 0;
    const limit = Number.parseInt(String(request.limit || items.length || "0"), 10);
    const pageItems = items.slice(cursor, limit ? cursor + limit : undefined);
    const nextCursor =
      limit && cursor + limit < items.length ? String(cursor + limit) : undefined;
    return { items: pageItems, nextCursor };
  }

  async updateSession(session) {
    await this.withLock(async () => {
      const id = getAgentSessionId(session);
      await this.appendJsonLine(this.sessionJournalPath(id), {
        __op: "save_session",
        session,
        writtenAt: Date.now(),
      });
    });
  }

  async renameSessionId(oldId, newId) {
    const sourceId = asString(oldId);
    const targetId = asString(newId);
    if (!sourceId || !targetId || sourceId === targetId) {
      return;
    }
    await this.withLock(async () => {
      const sourceSession = await this.getSession(sourceId);
      const targetSession = await this.getSession(targetId);
      if (sourceSession && !targetSession) {
        await this.appendJsonLine(this.sessionJournalPath(targetId), {
          __op: "save_session",
          session: {
            ...sourceSession,
            id: targetId,
            agentSessionId:
              asString(sourceSession?.agentSessionId) || targetId,
          },
          writtenAt: Date.now(),
        });
      }
      await this.appendJsonLine(this.sessionJournalPath(sourceId), {
        __op: "renamed",
        oldId: sourceId,
        newId: targetId,
        writtenAt: Date.now(),
      });
      const sourceEvents = await this.readEvents(sourceId);
      if (sourceEvents.length) {
        await fs.mkdir(this.sessionDir(targetId), { recursive: true });
        const rewritten = sourceEvents.map((event) =>
          event && typeof event === "object"
            ? {
                ...event,
                sessionId: targetId,
              }
            : event,
        );
        await fs.appendFile(
          this.eventJournalPath(targetId),
          rewritten.map((event) => JSON.stringify(event)).join("\n") + "\n",
          "utf-8",
        );
      }
    });
  }

  async importEventsFrom(sourcePersist, sourceSessionId, targetSessionId) {
    const sourceId = asString(sourceSessionId);
    const targetId = asString(targetSessionId);
    if (!sourcePersist || !sourceId || !targetId) {
      return { imported: false, count: 0, reason: "missing_input" };
    }
    const sourceEvents = await sourcePersist.readEvents(sourceId);
    if (!sourceEvents.length) {
      return { imported: false, count: 0, reason: "no_source_events" };
    }
    return await this.withLock(async () => {
      const existing = await this.readEvents(targetId);
      if (existing.length > 0) {
        return {
          imported: false,
          count: existing.length,
          reason: "target_has_events",
        };
      }
      await fs.mkdir(this.sessionDir(targetId), { recursive: true });
      const rewritten = sourceEvents.map((event) =>
        event && typeof event === "object" ? { ...event, sessionId: targetId } : event,
      );
      await fs.appendFile(
        this.eventJournalPath(targetId),
        rewritten.map((event) => JSON.stringify(event)).join("\n") + "\n",
        "utf-8",
      );
      return { imported: true, count: sourceEvents.length, reason: "imported" };
    });
  }

  async listEvents(request) {
    const events = await this.readEvents(request.sessionId);
    const items = events
      .slice()
      .sort((left, right) => (left.eventIndex || 0) - (right.eventIndex || 0));
    const cursor = Number.parseInt(String(request.cursor || "0"), 10) || 0;
    const limit = Number.parseInt(String(request.limit || items.length || "0"), 10);
    const pageItems = items.slice(cursor, limit ? cursor + limit : undefined);
    const nextCursor =
      limit && cursor + limit < items.length ? String(cursor + limit) : undefined;
    return { items: pageItems, nextCursor };
  }

  async insertEvent(sessionId, event) {
    this.insertEventCount += 1;
    if (shouldLogEventDiagnostic(this.insertEventCount, event)) {
      await appendScanRuntimeFile(
        this.diagnosticPath,
        "[sandbox-agent-persist] " +
          new Date().toISOString() +
          " pid=" +
          String(process.pid) +
          " count=" +
          String(this.insertEventCount) +
          " requested_session_id=" +
          String(sessionId || "") +
          " " +
          summarizeEventForDiagnostics(event) +
          "\n",
      ).catch(() => {});
    }
    await this.withLock(async () => {
      await this.appendJsonLine(this.eventJournalPath(sessionId), event);
    });
  }

}

const getAgentSessionId = (session) => {
  const sessionId = asString(session?.agentSessionId);
  if (!sessionId) {
    throw new Error("sandbox-agent session is missing native agentSessionId");
  }
  return sessionId;
};

const createNewSession = async (client, input) =>
  await client.createSession({
    agent: input.provider,
    cwd: input.cwd,
    model: input.model || undefined,
    thoughtLevel: input.thinkingLevel || undefined,
    mode: input.provider === "codex" ? "full-access" : undefined,
  });

const resolveForkSessionModel = (input) => {
  const model = asString(input.model);
  if (!model || input.provider !== "claude") {
    return model || undefined;
  }
  const normalized = model.toLowerCase();
  if (normalized.includes("flash") || normalized.includes("haiku")) {
    return "haiku";
  }
  if (normalized.includes("sonnet")) {
    return "sonnet";
  }
  if (normalized.includes("opus")) {
    return "opus";
  }
  return model;
};

const resolveParentAgentSessionId = (input) => {
  const parentSessionId = asString(input.parentSessionId);
  if (!parentSessionId) {
    throw new Error("fork session requested but parentSessionId is missing");
  }
  return parentSessionId;
};

const forkParentSessionAsChild = async (client, input) => {
  if (typeof client.forkSession !== "function") {
    throw new Error("sandbox-agent client does not support forkSession");
  }
  const parentAgentSessionId = resolveParentAgentSessionId(input);
  await appendDriverLog(
    input.stderrPath,
    "forking parent native session parent_agent_session_id=" +
      parentAgentSessionId,
  );
  const session = await client.forkSession({
    agent: input.provider,
    agentSessionId: parentAgentSessionId,
    cwd: input.cwd,
    model: resolveForkSessionModel(input),
    thoughtLevel: input.thinkingLevel || undefined,
    mode: input.provider === "codex" ? "full-access" : undefined,
  });
  await appendDriverLog(
    input.stderrPath,
    "forked parent native session parent_agent_session_id=" +
      parentAgentSessionId +
      " child_agent_session_id=" +
      getAgentSessionId(session),
  );
  return { session };
};

const createDriverSession = async (client, input, persist, parentPersist = null) => {
  if (input.sessionMode !== "fork") {
    await appendDriverLog(input.stderrPath, "creating session");
    return {
      session: await createNewSession(client, input),
    };
  }

  await appendDriverLog(
    input.stderrPath,
    "preparing native parent session load " + String(input.parentSessionId || ""),
  );
  if (!persist) {
    throw new Error("fork session requested but sessionPersistPath is missing");
  }
  const parentAgentSessionId = resolveParentAgentSessionId(input);
  const { session: childSession } = await forkParentSessionAsChild(client, input);
  const childAgentSessionId = getAgentSessionId(childSession);
  if (parentPersist) {
    const importResult = await persist.importEventsFrom(
      parentPersist,
      parentAgentSessionId,
      childAgentSessionId,
    );
    await appendDriverLog(
      input.stderrPath,
      "fork event inheritance persist_import parent_agent_session_id=" +
        parentAgentSessionId +
        " child_agent_session_id=" +
        childAgentSessionId +
        " imported=" +
        String(Boolean(importResult.imported)) +
        " count=" +
        String(importResult.count || 0) +
        " reason=" +
        String(importResult.reason || ""),
    );
  }
  return {
    session: childSession,
  };
};

const main = async () => {
  const inputPath = process.argv[2];
  if (!inputPath) {
    throw new Error("sandbox-agent driver input path is required");
  }

  const sandboxAgentModulePath = process.env.SANDBOX_AGENT_MODULE_PATH;
  if (!sandboxAgentModulePath) {
    throw new Error("SANDBOX_AGENT_MODULE_PATH is required");
  }
  const { SandboxAgent } = await import(
    pathToFileURL(path.join(sandboxAgentModulePath, "dist/index.js")).href
  );
  const input = JSON.parse(await fs.readFile(inputPath, "utf-8"));
  let activeInput = input;
  let activePhase = "bootstrap";
  let activeTaskId = String(input.taskId || "");
  process.on("uncaughtException", (error) => {
    appendDriverLifecycleLogSync(
      activeInput || input,
      "uncaught_exception phase=" +
        activePhase +
        " active_task_id=" +
        activeTaskId +
        " error=" +
        formatErrorForLifecycle(error),
    );
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    appendDriverLifecycleLogSync(
      activeInput || input,
      "unhandled_rejection phase=" +
        activePhase +
        " active_task_id=" +
        activeTaskId +
        " reason=" +
        formatErrorForLifecycle(reason),
    );
    process.exit(1);
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      appendDriverLifecycleLogSync(
        activeInput || input,
        "signal signal=" +
          signal +
          " phase=" +
          activePhase +
          " active_task_id=" +
          activeTaskId,
      );
      process.exit(128 + (signal === "SIGTERM" ? 15 : signal === "SIGINT" ? 2 : 1));
    });
  }
  process.on("exit", (code) => {
    appendDriverLifecycleLogSync(
      activeInput || input,
      "process_exit code=" +
        String(code) +
        " phase=" +
        activePhase +
        " active_task_id=" +
        activeTaskId,
    );
  });
  await appendDriverLifecycleLog(
    input,
    "driver_start input_path=" +
      inputPath +
      " task_id=" +
      String(input.taskId || "") +
      " persistent=" +
      String(Boolean(input.persistent)) +
      " queue_dir=" +
      String(input.taskQueueDir || "") +
      " base_url=" +
      String(input.baseUrl || ""),
  );
  await appendDriverLog(
    input.stderrPath,
    "loaded input provider=" +
      String(input.provider || "") +
      " model=" +
      String(input.model || "") +
      " cwd=" +
      String(input.cwd || "") +
      " baseUrl=" +
      String(input.baseUrl || ""),
  );
  await appendDriverLog(input.stderrPath, "connecting to sandbox-agent");
  const persist = input.sessionPersistPath
    ? new FileSessionPersistDriver(input.sessionPersistPath)
    : null;
  const parentPersist = input.parentSessionPersistPath
    ? new FileSessionPersistDriver(input.parentSessionPersistPath)
    : null;
  const client = await SandboxAgent.connect({
    baseUrl: input.baseUrl,
    fetch: acpFetch,
    ...(persist ? { persist } : {}),
  });
  await appendDriverLog(input.stderrPath, "sandbox-agent connected");

  const driverSession = await withHeartbeat(
    createDriverSession(client, input, persist, parentPersist),
    30000,
    async () => {
      await appendDriverLog(
        input.stderrPath,
        "waiting for session mode=" + String(input.sessionMode || "new"),
      );
      process.stdout.write(
        "SESSION_HEARTBEAT:" + new Date().toISOString() + "\n",
      );
    },
  );
  const session = driverSession.session || driverSession;
  const sessionRecord = asRecord(session);
  await appendDriverLog(
    input.stderrPath,
    "session ready mode=" +
      String(input.sessionMode || "new") +
      " keys=" +
      JSON.stringify(Object.keys(sessionRecord || {})),
  );

  const sessionId = getAgentSessionId(session);
  await inheritForkRuntimeArtifactsOnce(input, sessionId);
  await appendDriverLog(input.stderrPath, "emitting thread id");
  process.stdout.write("THREAD_ID:" + sessionId + "\n");

  let state = createTaskState();
  let eventWriteChain = Promise.resolve();
  let onEventCount = 0;

  const handlePermissionEvent = async (event) => {
    const payload = getEventPayloadRecord(event);
    if (asString(payload?.method) !== "session/request_permission") {
      return;
    }
    const params = asRecord(payload?.params) || {};
    await autoApprovePermissionRequest(session, activeInput, {
      ...params,
      id: asString(payload?.id) || asString(params.id) || undefined,
    });
  };

  session.onEvent((event) => {
    const eventInput = activeInput || input;
    const eventState = state;
    const eventTaskId = activeTaskId;
    const eventPhase = activePhase;
    onEventCount += 1;
    if (shouldLogEventDiagnostic(onEventCount, event)) {
      void appendDriverLifecycleLog(
        eventInput,
        "session_on_event count=" +
          String(onEventCount) +
          " active_task_id=" +
          String(eventTaskId || "") +
          " active_phase=" +
          String(eventPhase || "") +
          " jsonl_path=" +
          String(eventInput?.jsonlPath || "") +
          " state_event_count_before=" +
          String(eventState.eventCount || 0) +
          " " +
          summarizeEventForDiagnostics(event),
      ).catch(() => {});
    }
    eventWriteChain = eventWriteChain
      .then(() => appendSessionEvent(eventInput, eventState, event))
      .catch(async (error) => {
        await appendScanRuntimeFile(
          input.stderrPath,
          "[sandbox-agent-event] " +
            (error instanceof Error ? error.message : "unknown error") +
            "\n",
        );
      });
    void handlePermissionEvent(event).catch(async (error) => {
      await appendScanRuntimeFile(
        eventInput.stderrPath || input.stderrPath,
        "[sandbox-agent-permission] " +
          (error instanceof Error ? error.message : String(error)) +
          "\n",
      ).catch(() => {});
    });
  });

  session.onPermissionRequest((request) => {
    void autoApprovePermissionRequest(session, activeInput, request);
  });

  const runPromptTask = async (taskInput) => {
    activeInput = taskInput;
    activeTaskId = String(taskInput.taskId || "");
    activePhase = "prompt";
    state = createTaskState();
    onEventCount = 0;
    await appendDriverLifecycleLog(
      taskInput,
      "prompt_start task_id=" +
        String(taskInput.taskId || "") +
        " session_mode=" +
        String(taskInput.sessionMode || "new") +
        " queue_entry=" +
        String(taskInput.__queueEntry || "") +
        " jsonl_path=" +
        String(taskInput.jsonlPath || "") +
        " session_persist_path=" +
        String(taskInput.sessionPersistPath || "") +
        " parent_session_persist_path=" +
        String(taskInput.parentSessionPersistPath || ""),
    );
    await updateTaskAliasSymlink(taskInput);
    if (sessionId) {
      await appendScanRuntimeFile(taskInput.stdoutPath || "", "THREAD_ID:" + sessionId + "\n").catch(() => {});
      process.stdout.write("THREAD_ID:" + sessionId + "\n");
    }
    await appendDriverLog(taskInput.stderrPath, "starting prompt task_id=" + String(taskInput.taskId || ""));
    const promptStartedAt = Date.now();
	    const promptResponse = await withHeartbeat(
	      withTimeout(
	        session.prompt([{ type: "text", text: taskInput.prompt }]),
	        SANDBOX_AGENT_PROMPT_TIMEOUT_MS,
        () =>
          new Error(
            "sandbox-agent session.prompt timed out after " +
              SANDBOX_AGENT_PROMPT_TIMEOUT_MS / 1000 +
              "s",
          ),
      ),
        30000,
        async () => {
          const outputFile = await inspectOutputEnvelopeFile(
            taskInput.structuredOutputResultPathInContainer,
          );
          await appendDriverLog(
            taskInput.stderrPath,
            "waiting for prompt completion elapsed_ms=" +
              String(Date.now() - promptStartedAt) +
              " events=" +
              String(state.eventCount || 0) +
              " last_event_age_ms=" +
              String(state.lastEventAt ? Date.now() - state.lastEventAt : null) +
              " end_turn=" +
              String(Boolean(state.endTurnReceived)) +
              " output_exists=" +
              String(Boolean(outputFile.exists)) +
              " output_valid_envelope=" +
              String(Boolean(outputFile.validEnvelope)) +
              " output_route=" +
              String(outputFile.route ?? "") +
              " active_tool_calls=" +
              String(Object.keys(state.activeToolCalls || {}).length),
          );
          await writeTaskStateFile(taskInput, state, {
            promptWaiting: true,
            promptElapsedMs: Date.now() - promptStartedAt,
            outputFile,
          });
	        },
	      );
	    const promptUsage = asRecord(promptResponse)?.usage ?? null;
	    if (taskInput.usagePath) {
	      await fs.writeFile(
	        taskInput.usagePath,
	        JSON.stringify(promptUsage, null, 2) + "\n",
	        "utf-8",
	      );
	    }
	    await appendDriverLog(taskInput.stderrPath, "prompt finished");
    await appendDriverLifecycleLog(
      taskInput,
      "prompt_resolved task_id=" +
        String(taskInput.taskId || "") +
        " events=" +
        String(state.eventCount || 0) +
        " end_turn=" +
        String(Boolean(state.endTurnReceived)),
    );
    state.promptFinished = true;
    activePhase = "post_prompt_drain";
    await waitForPostPromptEventDrain(taskInput, state, () => eventWriteChain);
    state.outputFile =
      (await writeNullableOutputFallbackIfMissing(taskInput, state)) ||
      (await inspectOutputEnvelopeFile(
        taskInput.structuredOutputResultPathInContainer,
      ));
    const rawExitRequested = Boolean(state.outputFile?.validEnvelope && state.outputFile.exit);
    state.exitRequested = Boolean(taskInput.allowAgentExit && rawExitRequested);
    state.completedAt = new Date().toISOString();
    await writeTaskStateFile(taskInput, state);
    if (!state.endTurnReceived) {
      await appendScanRuntimeFile(
        taskInput.stderrPath,
        "[sandbox-agent-driver] prompt completed without end_turn\n",
      );
    }
    if (state.exitRequested) {
      await appendDriverLog(taskInput.stderrPath, "output.json requested lane exit");
    } else if (rawExitRequested) {
      await appendDriverLog(
        taskInput.stderrPath,
        "output.json requested lane exit but allowAgentExit=false; keeping lane alive",
      );
    }
    await appendDriverLifecycleLog(
      taskInput,
      "prompt_task_complete task_id=" +
        String(taskInput.taskId || "") +
        " events=" +
        String(state.eventCount || 0) +
        " end_turn=" +
        String(Boolean(state.endTurnReceived)) +
        " output_exists=" +
        String(Boolean(state.outputFile?.exists)) +
        " output_valid_envelope=" +
        String(Boolean(state.outputFile?.validEnvelope)) +
        " output_route=" +
        String(state.outputFile?.route ?? "") +
        " exit_requested=" +
        String(Boolean(state.exitRequested)),
    );
    activePhase = "idle";
    return state;
  };

  try {
    await runPromptTask(input);
    let lastIdleLifecycleLogAt = 0;
    while (input.persistent && !state.exitRequested) {
      activeInput = input;
      activeTaskId = "";
      activePhase = "idle";
      const now = Date.now();
      if (now - lastIdleLifecycleLogAt >= 30000) {
        lastIdleLifecycleLogAt = now;
        await appendDriverLifecycleLog(
          input,
          "persistent_idle queue_dir=" + String(input.taskQueueDir || ""),
        );
      }
      const nextTaskInput = await readNextPersistentTaskInput(
        input.taskQueueDir,
        input,
      );
      if (!nextTaskInput) {
        await sleep(500);
        continue;
      }
      nextTaskInput.driverLifecyclePath =
        nextTaskInput.driverLifecyclePath || input.driverLifecyclePath;
      await appendDriverLifecycleLog(
        nextTaskInput,
        "queue_task_claimed task_id=" +
          String(nextTaskInput.taskId || "") +
          " queue_entry=" +
          String(nextTaskInput.__queueEntry || "") +
          " running_path=" +
          String(nextTaskInput.__queueRunningPath || ""),
      );
      await runPromptTask(nextTaskInput, "");
    }
    activePhase = "complete";
    await appendDriverLifecycleLog(
      input,
      "driver_loop_complete exit_requested=" + String(Boolean(state.exitRequested)),
    );
  } finally {
    activePhase = "cleanup";
    await appendDriverLifecycleLog(input, "cleanup_start");
    try {
      await session.close();
      await appendDriverLifecycleLog(input, "session_close_done");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await appendDriverLifecycleLog(input, "session_close_failed error=" + message).catch(() => {});
      await appendScanRuntimeFile(
        input.stderrPath,
        "[sandbox-agent-cleanup] session.close failed: " + message + "\\n",
      ).catch(() => {});
    }
    if (typeof client.close === "function") {
      try {
        await client.close();
        await appendDriverLifecycleLog(input, "client_close_done");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendDriverLifecycleLog(input, "client_close_failed error=" + message).catch(() => {});
        await appendScanRuntimeFile(
          input.stderrPath,
          "[sandbox-agent-cleanup] client.close failed: " + message + "\\n",
        ).catch(() => {});
      }
    } else {
      await appendDriverLifecycleLog(input, "client_close_skipped");
    }
  }
};

main().catch(async (error) => {
  const inputPath = process.argv[2];
  if (inputPath) {
    try {
      const input = JSON.parse(await fs.readFile(inputPath, "utf-8"));
      await appendDriverLifecycleLog(
        input,
        "main_catch error=" +
          (error instanceof Error ? error.stack || error.message : String(error)),
      ).catch(() => {});
      await appendScanRuntimeFile(
        input.stderrPath,
        "[sandbox-agent-driver] " +
          (error instanceof Error ? error.stack || error.message : String(error)) +
          "\n",
      );
    } catch {}
  }
  process.exit(1);
});
`;

const buildSandboxAgentDriverLaunchScript = (input: {
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

nohup bash -lc 'echo "[sandbox-agent-driver-lifecycle] $(date -Iseconds) shell_start pid=$$" >> "${input.driverLifecyclePath}"; export SANDBOX_AGENT_MODULE_PATH="$(npm root -g)/sandbox-agent" && node "${input.driverScriptPath}" "${input.driverInputPath}" > >(tee -a "${input.driverStdoutPath}" "${input.taskStdoutPath}" >/dev/null) 2>> "${input.stderrPath}"; status=$?; echo "[sandbox-agent-driver] exit_code=$status" >> "${input.stderrPath}"; echo "[sandbox-agent-driver-lifecycle] $(date -Iseconds) shell_exit status=$status" >> "${input.driverLifecyclePath}"' >/dev/null 2>&1 &
driver_pid=$!
echo "[sandbox-agent-driver] pid=$driver_pid" >> '${escapeSingleQuotes(input.stderrPath)}'
echo "[sandbox-agent-driver-lifecycle] $(date -Iseconds) launch_background_pid=$driver_pid" >> '${escapeSingleQuotes(input.driverLifecyclePath)}'
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
			SANDBOX_AGENT_DRIVER_VERSION,
		)}' '${escapeSingleQuotes(input.driverScriptPath)}' >/dev/null 2>&1 && echo yes || echo no"`,
	);
	return stdout.trim() === "yes";
};

const buildTaskSessionPersistPathInContainer = (taskRootInContainer: string) =>
	path.posix.join(
		taskRootInContainer,
		SANDBOX_AGENT_SESSION_STORE_DIR_NAME,
		SANDBOX_AGENT_SESSION_PERSIST_FILE_NAME,
	);

const buildTaskAgentHomePathInContainer = (taskRootInContainer: string) =>
	path.posix.join(taskRootInContainer, SANDBOX_AGENT_AGENT_HOME_DIR_NAME);

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

const prepareForkRuntimeArtifactsOnHost = async (input: {
	runInput: RunSingleTurnAgentInput;
	taskStageDirPath: string;
	runtimeFileNames: {
		jsonl: string;
		text: string;
		stderr: string;
		stdout: string;
		usage?: string;
	};
}) => {
	if (input.runInput.sessionMode !== "fork" || !input.runInput.parentTaskId) {
		return {
			parentRuntimeRootPathInContainer: undefined,
			parentSessionPersistPathInContainer: undefined,
			parentAgentHomePathInContainer: undefined,
		};
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
		SANDBOX_AGENT_AGENT_HOME_DIR_NAME,
	);
	const childAgentHomeRootOnHost = input.runInput.persistent
		? input.runInput.stageDirPath
		: input.taskStageDirPath;
	const childAgentHomeOnHost = path.join(
		childAgentHomeRootOnHost,
		SANDBOX_AGENT_AGENT_HOME_DIR_NAME,
	);
	const childAgentHomeExists = await pathExists(childAgentHomeOnHost);
	const copiedAgentHome =
		input.runInput.persistent && childAgentHomeExists
			? true
			: await copyDirectoryReplacing(parentAgentHomeOnHost, childAgentHomeOnHost);

	const parentSessionStoreOnHost = path.join(
		parentRuntimeRootOnHost,
		SANDBOX_AGENT_SESSION_STORE_DIR_NAME,
	);
	const childRuntimeRootOnHost = input.runInput.persistent
		? input.runInput.stageDirPath
		: input.taskStageDirPath;
	const childParentSessionStoreOnHost = path.join(
		childRuntimeRootOnHost,
		"parent-session-store",
	);
	const copiedParentSessionStore = await copyDirectoryReplacing(
		parentSessionStoreOnHost,
		childParentSessionStoreOnHost,
	);

	if (!copiedAgentHome) {
		throw new Error(
			`Fork session requested but parent agent-home was not found at ${parentAgentHomeOnHost}`,
		);
	}
	if (!copiedParentSessionStore) {
		throw new Error(
			`Fork session requested but parent session-store was not found at ${parentSessionStoreOnHost}`,
		);
	}

	return {
		parentRuntimeRootPathInContainer: null,
		parentSessionPersistPathInContainer: path.posix.join(
			TASK_PARENT_SESSION_STORE_ROOT_IN_CONTAINER,
			SANDBOX_AGENT_SESSION_PERSIST_FILE_NAME,
		),
		parentAgentHomePathInContainer: null,
	};
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

const resolveParentSessionPersistPathInContainer = async (
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
		return buildTaskSessionPersistPathInContainer(
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
		return buildTaskSessionPersistPathInContainer(
			buildLaneRootInContainer({
				scanJobId: input.scanJob.scanJobId,
				stageName: parentTask.stageName,
				laneIndex: parentLaneRuntime.laneIndex,
			}),
		);
	}
	const parentTaskRoot = await resolveParentTaskRootInContainer(input);
	return parentTaskRoot
		? buildTaskSessionPersistPathInContainer(parentTaskRoot)
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
	const promptWithOutputSchema =
		input.outputSchema || input.routeOutputSchemas?.length
			? `${resolvedPrompt.trimEnd()}\n${buildStructuredOutputPromptSuffix(
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
			: resolvedPrompt;
	const runtimeFileNames = {
		...SANDBOX_AGENT_RUNTIME_FILE_NAMES,
		...(input.runtimeFileNames || {}),
	};
	const taskStderrPath = path.join(taskStageDirPath, runtimeFileNames.stderr);
	const taskRuntimeArtifacts = createCodexRuntimeArtifacts({
		runtimeDir: taskStageDirPath,
		jsonlFileName: runtimeFileNames.jsonl,
		textFileName: runtimeFileNames.text,
		stderrFileName: runtimeFileNames.stderr,
		stdoutFileName: runtimeFileNames.stdout,
		usageFileName: runtimeFileNames.usage,
	});
	await initializeRuntimeFiles({
		runtimeDir: taskStageDirPath,
		jsonlPath: path.join(taskStageDirPath, runtimeFileNames.jsonl),
		textPath: path.join(taskStageDirPath, runtimeFileNames.text),
		stderrPath: path.join(taskStageDirPath, runtimeFileNames.stderr),
		stdoutPath: path.join(taskStageDirPath, runtimeFileNames.stdout),
		usagePath: path.join(taskStageDirPath, runtimeFileNames.usage),
	});
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
	await initializeCodexRuntimeMetadataFiles({
		cursorPath: taskRuntimeArtifacts.cursorPath,
		statePath: taskRuntimeArtifacts.statePath,
	});
	await updateTaskAliasSymlinkInContainer({
		containerName: input.containerName,
		taskRootInContainer: realTaskRootInContainer,
		logPath: taskStderrPath,
	});
	await withHostBootstrapLog(
		taskStderrPath,
		"task_runtime_files_initialized_in_container",
		"",
		() =>
			initializeRuntimeFilesInContainer({
				containerName: input.containerName,
				runtimeDirInContainer: taskStageRootInContainer,
				jsonlFileName: runtimeFileNames.jsonl,
				textFileName: runtimeFileNames.text,
				stderrFileName: runtimeFileNames.stderr,
				stdoutFileName: runtimeFileNames.stdout,
				usageFileName: runtimeFileNames.usage,
			}),
	);
	await withHostBootstrapLog(
		taskStderrPath,
		"task_metadata_files_initialized_in_container",
		"",
		() =>
			initializeCodexRuntimeMetadataFilesInContainer({
				containerName: input.containerName,
				runtimeDirInContainer: taskStageRootInContainer,
				cursorFileName: taskRuntimeArtifacts.cursorFileName,
				stateFileName: taskRuntimeArtifacts.stateFileName,
				writeContainerFile,
			}),
	);
	const forkRuntimeArtifacts = await withHostBootstrapLog(
		taskStderrPath,
		"prepare_fork_runtime_artifacts",
		`session_mode=${input.sessionMode || ""} parent_task_id=${input.parentTaskId || ""}`,
		() =>
			prepareForkRuntimeArtifactsOnHost({
				runInput: input,
				taskStageDirPath,
				runtimeFileNames,
			}),
	);
	const agentProvider = input.agentProfile?.provider || "codex";
	const driverScriptPath = path.posix.join(
		input.stageRootInContainer,
		SANDBOX_AGENT_DRIVER_FILE_NAME,
	);
	const driverInputPath = path.posix.join(
		input.stageRootInContainer,
		SANDBOX_AGENT_DRIVER_INPUT_FILE_NAME,
	);
	const driverStdoutPath = path.posix.join(
		input.stageRootInContainer,
		SANDBOX_AGENT_DRIVER_STDOUT_FILE_NAME,
	);
	const driverLaunchPath = path.posix.join(
		input.stageRootInContainer,
		SANDBOX_AGENT_DRIVER_LAUNCH_FILE_NAME,
	);
	const driverPidPath = path.posix.join(
		input.stageRootInContainer,
		SANDBOX_AGENT_DRIVER_PID_FILE_NAME,
	);
	const driverLifecyclePath = path.posix.join(
		input.stageRootInContainer,
		SANDBOX_AGENT_DRIVER_LIFECYCLE_FILE_NAME,
	);
	const taskQueueDir = path.posix.join(
		input.stageRootInContainer,
		SANDBOX_AGENT_DRIVER_TASK_DIR_NAME,
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
			`expected=${SANDBOX_AGENT_DRIVER_VERSION}`,
			() =>
				persistentDriverScriptMatchesCurrentVersion({
					containerName: input.containerName,
					driverScriptPath,
				}),
		).catch(() => false);
		if (!driverScriptCurrent) {
			await appendHostBootstrapLog(
				taskStderrPath,
				`persistent_driver_script_stale expected=${SANDBOX_AGENT_DRIVER_VERSION}; restarting driver`,
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
	const parentTaskRootInContainer =
		forkRuntimeArtifacts.parentRuntimeRootPathInContainer !== undefined
			? forkRuntimeArtifacts.parentRuntimeRootPathInContainer
			: input.sessionMode === "fork"
				? await resolveParentTaskRootInContainer(input)
				: null;
	const parentAgentHomePathInContainer =
		forkRuntimeArtifacts.parentAgentHomePathInContainer !== undefined
			? forkRuntimeArtifacts.parentAgentHomePathInContainer
			: await resolveParentAgentHomePathInContainer(input);
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

	const sessionPersistPathInContainer = buildTaskSessionPersistPathInContainer(
		input.stageRootInContainer,
	);
	const parentSessionPersistPathInContainer =
		forkRuntimeArtifacts.parentSessionPersistPathInContainer !== undefined
			? forkRuntimeArtifacts.parentSessionPersistPathInContainer
			: await resolveParentSessionPersistPathInContainer(input);
	const buildDriverTaskInput = (baseUrl: string) => ({
		taskId: input.taskId || undefined,
		baseUrl,
		provider:
			input.agentProfile?.provider === "claude_code" ? "claude" : "codex",
		cwd: input.cwd,
		prompt: promptWithOutputSchema,
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
		parentRuntimeRootPath: parentTaskRootInContainer,
		parentSessionPersistPath: parentSessionPersistPathInContainer,
		sessionPersistPath: sessionPersistPathInContainer,
		jsonlPath: path.posix.join(
			taskStageRootInContainer,
			runtimeFileNames.jsonl,
		),
		textPath: path.posix.join(taskStageRootInContainer, runtimeFileNames.text),
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
		statePath: path.posix.join(
			taskStageRootInContainer,
			taskRuntimeArtifacts.stateFileName,
		),
		driverLifecyclePath,
		agentHomePathInContainer: taskAgentHome.agentHomePathInContainer,
		agentHomeLinkPathInContainer: taskAgentHome.agentHomeLinkPathInContainer,
		parentAgentHomePathInContainer:
			taskAgentHome.parentAgentHomePathInContainer,
		agentHomeCopiedFromParent: taskAgentHome.agentHomeCopiedFromParent,
	});
	if (persistentDriverAlive) {
		const driverTaskInput = buildDriverTaskInput("");
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
			`[sandbox-agent-driver-lifecycle] ${new Date().toISOString()} host_enqueue task_id=${input.taskId || ""} request_path=${requestPath} lane_thread_id=${input.laneThreadId || ""}\n`,
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
	const sandboxRuntime = await withHostBootstrapLog(
		taskStderrPath,
		"prepare_sandbox_agent_runtime",
		`provider=${agentProvider} reuse_existing=false`,
		() =>
			prepareSandboxAgentRuntime({
				containerName: input.containerName,
				stageDirPath: input.stageDirPath,
				stageDirInContainer: input.stageRootInContainer,
				provider: input.agentProfile?.provider || "codex",
				homeDir: "/root",
				envPairs:
					agentProvider === "claude_code" && input.agentProfile
						? buildClaudeEnvPairs(
								input.agentProfile,
								taskAgentHome.agentHomePathInContainer,
							).concat([
								`SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS=${SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS}`,
							])
						: [
								`CODEX_HOME=${taskAgentHome.agentHomePathInContainer}`,
								`SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS=${SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS}`,
								...(input.agentProfile
									? parseAgentProfileEnvPairs(input.agentProfile)
									: []),
							],
				reuseExisting: false,
			}),
	);
	const driverTaskInput = buildDriverTaskInput(sandboxRuntime.server.baseUrl);
	if (input.persistent && input.laneThreadId && persistentDriverHealth) {
		await appendContainerFile(
			input.containerName,
			driverLifecyclePath,
			`[sandbox-agent-driver-lifecycle] ${new Date().toISOString()} host_driver_unhealthy task_id=${input.taskId || ""} reason=${persistentDriverHealth.reason || ""} pid=${persistentDriverHealth.pid || ""} state=${persistentDriverHealth.state || ""} lifecycle_age_ms=${persistentDriverHealth.lifecycleAgeMs ?? ""} last_lifecycle=${JSON.stringify(persistentDriverHealth.lastLifecycleLine || "")}\n`,
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

	await withHostBootstrapLog(taskStderrPath, "write_driver_script", "", () =>
		writeContainerFile(
			input.containerName,
			driverScriptPath,
			buildSandboxAgentDriverScript(),
		),
	);
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
				buildSandboxAgentDriverLaunchScript({
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
