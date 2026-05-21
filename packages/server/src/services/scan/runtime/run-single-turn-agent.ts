import { promises as fs } from "node:fs";
import path from "node:path";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ScanJob, AgentProfileLike } from "../types";
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

const RUNTIME_CUSTOM_SKILLS = [
	"codeql",
	"semgrep",
	"delta-scan",
	"full-scan",
	"full-scan-subagent",
	"repository-scanner",
	"module-scanner",
	"function-scanner",
	"deep-analysis",
	"libafl",
	"libafl-build",
	"libafl-fuzz",
	"address-sanitizer",
	"coverage-analysis",
	"analysis-critic",
	"verify",
	"search-registries",
	"tree-sitter",
	"serena",
] as const;

const DEFAULT_ANALYSIS_CONCURRENCY = 2;
const DEFAULT_VERIFY_CONCURRENCY = 1;
const DEFAULT_FULL_SCAN_MODULE_CONCURRENCY = 4;
const DEFAULT_FULL_SCAN_FUNCTION_CONCURRENCY = 4;
const CONTAINER_SCAN_CONTEXT_ROOT = "/scan-context";
const TASK_ALIAS_ROOT_IN_CONTAINER = "/task";
const TASK_PARENT_RUNTIME_ROOT_IN_CONTAINER = "/task/parent-runtime";
const TASK_PARENT_SESSION_STORE_ROOT_IN_CONTAINER = "/task/parent-session-store";
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
	value.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/-+/g, "-");

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

const buildCodexConfigToml = (agentProfile: AgentProfileLike) => {
	const providerName = sanitizeProviderName(agentProfile.agentProfileId);

	return withCodexAutoApproveConfigToml([
		`model = "${agentProfile.model}"`,
		`model_reasoning_effort = "${agentProfile.thinkingLevel}"`,
		`model_provider = "${providerName}"`,
		`preferred_auth_method = "apikey"`,
		"",
		`[model_providers.${providerName}]`,
		`name = "${providerName}"`,
		`base_url = "${agentProfile.baseUrl}"`,
		`wire_api = "responses"`,
		"",
	].join("\n"));
};

const loadCodexMcpConfigToml = async (agentsDir: string | null) => {
	if (!agentsDir) {
		return "";
	}

	const mcpDir = path.join(agentsDir, "mcp");
	try {
		const entries = await fs.readdir(mcpDir, { withFileTypes: true });
		const tomlFiles = entries
			.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".toml"))
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

const buildClaudeEnvPairs = (agentProfile: AgentProfileLike) => [
	`CLAUDE_CONFIG_DIR=${CLAUDE_HOME_IN_CONTAINER}`,
	`CLAUDE_HOME=${CLAUDE_HOME_IN_CONTAINER}`,
	`ANTHROPIC_BASE_URL=${agentProfile.baseUrl}`,
	`ANTHROPIC_API_KEY=${agentProfile.apiKey}`,
	`ANTHROPIC_AUTH_TOKEN=${agentProfile.apiKey}`,
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

const getErrorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const execDockerRunWithRetry = async (input: {
	containerName: string;
	command: string;
	taskId?: string;
}) => {
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= 6; attempt += 1) {
		try {
			return await execAsync(input.command);
		} catch (error) {
			lastError = error;
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

const remapServerRuntimeDirToDockerHostPath = (input: {
	runtimeDir: string;
	mountedProfileDir: string;
	hostProfileDir: string;
}) => {
	const runtimeDir = path.resolve(input.runtimeDir);
	const mountedProfileDir = path.resolve(input.mountedProfileDir);
	const hostProfileDir = path.resolve(input.hostProfileDir);
	const relativeToMounted = path.relative(mountedProfileDir, runtimeDir);
	if (
		relativeToMounted === "" ||
		(!relativeToMounted.startsWith(`..${path.sep}`) &&
			relativeToMounted !== ".." &&
			!path.isAbsolute(relativeToMounted))
	) {
		return path.join(hostProfileDir, relativeToMounted);
	}
	return runtimeDir;
};

const resolveScanExecutionContext = async (scanJob: ScanJob) => {
	const isApplicationJob = Boolean(scanJob.applicationId);
	const target = isApplicationJob
		? await findApplicationById(scanJob.applicationId as string)
		: await findComposeById(scanJob.composeId as string);
	const targetDefaultAgentProfile =
		("agentProfile" in target && target.agentProfile) || null;

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
		scanAgentProfile:
			("scanAgentProfile" in target && target.scanAgentProfile) ||
			targetDefaultAgentProfile ||
			null,
		analysisAgentProfile:
			("analysisAgentProfile" in target && target.analysisAgentProfile) ||
			targetDefaultAgentProfile ||
			null,
		verifierAgentProfile:
			("verifierAgentProfile" in target && target.verifierAgentProfile) ||
			targetDefaultAgentProfile ||
			null,
		analysisConcurrency:
			"analysisConcurrency" in target &&
			typeof target.analysisConcurrency === "number"
				? target.analysisConcurrency
				: DEFAULT_ANALYSIS_CONCURRENCY,
		verifyConcurrency:
			"verifyConcurrency" in target && typeof target.verifyConcurrency === "number"
				? target.verifyConcurrency
				: DEFAULT_VERIFY_CONCURRENCY,
		fullScanModuleConcurrency:
			("fullScanModuleConcurrency" in target &&
			typeof target.fullScanModuleConcurrency === "number"
				? target.fullScanModuleConcurrency
				: DEFAULT_FULL_SCAN_MODULE_CONCURRENCY),
		fullScanFunctionConcurrency:
			("fullScanFunctionConcurrency" in target &&
			typeof target.fullScanFunctionConcurrency === "number"
				? target.fullScanFunctionConcurrency
				: DEFAULT_FULL_SCAN_FUNCTION_CONCURRENCY),
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
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				joinTomlBlocks(
					buildCodexConfigToml(agentProfile),
					mcpConfigToml,
				),
			);
			await writeContainerFile(
				containerName,
				`${codexHome}/auth.json`,
				buildCodexAuthJson(agentProfile),
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
	try {
		await fs.stat(codexAuthPath);
		await execAsync(
			`docker cp "${codexAuthPath}" ${containerName}:"${codexHome}/auth.json"`,
		);
	} catch {}
};

const initializeClaudeHomeInContainer = async (
	containerName: string,
	claudeHome: string,
) => {
	await writeContainerFile(
		containerName,
		`${claudeHome}/settings.json`,
		`${JSON.stringify(
			{
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
			},
			null,
			2,
		)}\n`,
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
	persistent?: boolean;
	runtimeFileNames?: {
		jsonl: string;
		text: string;
		stderr: string;
		stdout: string;
	};
};

export type RunSingleTurnAgentInput = StageContainerInput & {
	taskId?: string;
	cwd: string;
	prompt: string | ((containerName: string) => Promise<string>);
	taskStageDirPath?: string;
	taskStageRootInContainer?: string;
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
) => {
	const buildOutputSchema = (outputSchema: ZodTypeAny) =>
		zodToJsonSchema(outputSchema, {
			target: "jsonSchema7",
			$refStrategy: "none",
		});
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
			output: buildOutputSchema(input.outputSchema),
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
) => {
	const jsonSchema = buildStructuredOutputEnvelopeJsonSchema(
		schema,
		routeOutputSchemas,
	);

	return [
		"",
		"Structured JSON output requirement:",
		`- Write the final structured result to ${outputFilePath}.`,
		"- The output file content must be only a JSON object, with no markdown fences, comments, or prose.",
		"- The top-level JSON object must be an envelope with exactly these fields: route, exit, output.",
		"- Set exit to true only when this lane should be discarded after this task; otherwise set exit to false.",
		`- The JSON Schema for the complete output.json envelope is written to ${schemaFilePath}.`,
		"- You must use that schema file as the source of truth and validate output.json against it before ending your turn.",
		"- Perform validation with Python and the jsonschema package available in the container environment.",
		`- Load ${outputFilePath}, load ${schemaFilePath}, and validate it locally with python before ending your turn.`,
		"- During validation, do not print the full JSON object to the terminal or write it to a tool-output file; print only a short success/failure line.",
		"- If validation fails, fix the JSON and validate again before returning.",
		"- The output.json envelope must conform exactly to that JSON Schema.",
		"- Do not add extra fields outside the schema.",
		"- Use null for nullable fields instead of omitting them unless the schema explicitly allows omission.",
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
	const {
		imageTag,
		projectName,
		serviceName,
	} = await resolveScanExecutionContext(input.scanJob);
	const agentsDir = await resolveAgentsDirectory();
	const hostProfileDir = await resolveProjectProfileHostPath({
		projectName,
		profileName: serviceName,
	});
	const mountedProfileDir = resolveMountedProjectProfilePath({
		projectName,
		profileName: serviceName,
	});
	const runtimeMountSource = remapServerRuntimeDirToDockerHostPath({
		runtimeDir: input.stageDirPath,
		mountedProfileDir,
		hostProfileDir,
	});
	await fs.mkdir(runtimeMountSource, { recursive: true });
	await fs.mkdir(input.stageDirPath, { recursive: true });
	const containerEnvPairs = [
		...getGlobalContainerEnvironmentPairs(),
		`VULSEEK_PROJECT_PROFILE_DIR=${input.stageRootInContainer}`,
		`VULSEEK_PROJECT_CACHE_DIR=${path.posix.join(input.stageRootInContainer, "cache")}`,
	];
	const runtimeFileNames = input.runtimeFileNames || {
		...SANDBOX_AGENT_RUNTIME_FILE_NAMES,
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
	const runtimeArtifacts = createCodexRuntimeArtifacts({
		runtimeDir: input.stageDirPath,
		jsonlFileName: runtimeFileNames.jsonl,
		textFileName: runtimeFileNames.text,
		stderrFileName: runtimeFileNames.stderr,
		stdoutFileName: runtimeFileNames.stdout,
	});

	return {
		imageTag,
		agentsDir,
		taskRuntimeMount: {
			mountSource: runtimeMountSource,
			mountDescription: `host_path:${runtimeMountSource}`,
			dockerMountArg: `-v '${escapeSingleQuotes(runtimeMountSource)}':${input.stageRootInContainer}`,
		},
		agentHome: {
			codexContainerDir: CODEX_HOME_IN_CONTAINER,
			claudeContainerDir: CLAUDE_HOME_IN_CONTAINER,
		},
		containerNetworkArg,
		containerEnvArgs,
		jsonlPath,
		textPath,
		stderrPath,
		stdoutPath,
		runtimeArtifacts,
	};
};

export const startContainer = async (input: StageContainerInput) => {
	const runtime = await resolveStageContainerRuntime(input);

	if (input.persistent) {
		const running = await execAsync(
			`docker inspect -f '{{.State.Running}}' ${input.containerName}`,
		)
			.then(({ stdout }) => stdout.trim() === "true")
			.catch(() => false);
		if (running) {
			await execAsync(
				`docker exec ${input.containerName} bash -lc "mkdir -p '${input.stageRootInContainer}' '${runtime.agentHome.codexContainerDir}/skills' '${runtime.agentHome.claudeContainerDir}'"`,
			);
			return;
		}
		await execAsync(`docker rm -f ${input.containerName}`).catch(() => {});
	} else {
		// Recovery/retry may encounter leftover containers with the same deterministic
		// name. Remove them first so restart logic can safely recreate the runtime.
		await execAsync(`docker rm -f ${input.containerName}`).catch(() => {});
	}

	await initializeRuntimeFiles({
		runtimeDir: input.stageDirPath,
		jsonlPath: runtime.jsonlPath,
		textPath: runtime.textPath,
		stderrPath: runtime.stderrPath,
		stdoutPath: runtime.stdoutPath,
	});
	await initializeCodexRuntimeMetadataFiles({
		cursorPath: runtime.runtimeArtifacts.cursorPath,
		statePath: runtime.runtimeArtifacts.statePath,
	});
	await execDockerRunWithRetry({
		containerName: input.containerName,
		taskId: input.taskId,
		command: `docker run -d --name ${input.containerName} ${runtime.containerNetworkArg} ${buildNamespaceEnabledContainerArgs()} ${runtime.taskRuntimeMount.dockerMountArg} ${runtime.containerEnvArgs} ${runtime.imageTag} bash -lc "mkdir -p '${input.stageRootInContainer}' '${runtime.agentHome.codexContainerDir}/skills' '${runtime.agentHome.claudeContainerDir}' && sleep infinity"`,
	});

	await initializeRuntimeFilesInContainer({
		containerName: input.containerName,
		runtimeDirInContainer: input.stageRootInContainer,
		jsonlFileName: runtime.runtimeArtifacts.jsonlFileName,
		textFileName: runtime.runtimeArtifacts.textFileName,
		stderrFileName: runtime.runtimeArtifacts.stderrFileName,
		stdoutFileName: runtime.runtimeArtifacts.stdoutFileName,
	});
	await initializeCodexRuntimeMetadataFilesInContainer({
		containerName: input.containerName,
		runtimeDirInContainer: input.stageRootInContainer,
		cursorFileName: runtime.runtimeArtifacts.cursorFileName,
		stateFileName: runtime.runtimeArtifacts.stateFileName,
		writeContainerFile,
	});
	await copyCodexAssetsToContainerHome(
		input.containerName,
		runtime.agentHome.codexContainerDir,
		runtime.agentsDir,
		input.agentProfile,
	);
	await initializeClaudeHomeInContainer(
		input.containerName,
		runtime.agentHome.claudeContainerDir,
	);
	await installRuntimeSkillsInContainer({
		containerName: input.containerName,
		agentsDir: runtime.agentsDir,
		skillNames: RUNTIME_CUSTOM_SKILLS,
	});
};

export const stopContainer = async (containerName: string) => {
	await execAsync(`docker stop ${containerName}`).catch(() => {});
};

export const removeContainer = async (containerName: string) => {
	await execAsync(`docker rm -f ${containerName}`).catch(() => {});
};

const SANDBOX_AGENT_DRIVER_FILE_NAME = "sandbox-agent-driver.mjs";
const SANDBOX_AGENT_DRIVER_INPUT_FILE_NAME = "sandbox-agent-driver-input.json";
const SANDBOX_AGENT_DRIVER_STDOUT_FILE_NAME = "sandbox-agent-driver-stdout.log";
const SANDBOX_AGENT_DRIVER_LAUNCH_FILE_NAME = "sandbox-agent-driver-launch.sh";
const SANDBOX_AGENT_DRIVER_PID_FILE_NAME = "sandbox-agent-driver.pid";
const SANDBOX_AGENT_DRIVER_LIFECYCLE_FILE_NAME =
	"sandbox-agent-driver-lifecycle.log";
const SANDBOX_AGENT_DRIVER_TASK_DIR_NAME = "sandbox-agent-driver-tasks";
const SANDBOX_AGENT_AGENT_HOME_DIR_NAME = "agent-home";

const buildSandboxAgentDriverScript = () => String.raw`import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

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
    extractTextValue(record)
  );
};

const renderSandboxAgentEvent = (event) => {
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
      return text ? "\n[tool] " + text + "\n" : "";
    case "plan":
      return text ? "\n[plan] " + text + "\n" : "";
    case "usage_update":
      return "";
    case "session_info_update":
      return text ? "\n[session] " + text + "\n" : "";
    default:
      return text;
  }
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
  await appendScanRuntimeFile(paths.jsonlPath, formatSandboxAgentSessionEvent(event));
  const rendered = renderSandboxAgentEvent(event);
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

const fileSizeOrZero = async (filePath) => {
  if (!filePath) return 0;
  const stat = await fs.stat(filePath).catch(() => null);
  return stat ? Number(stat.size || 0) : 0;
};

const copyParentRuntimeFileOnce = async (input, parentPath, childPath) => {
  if (!parentPath || !childPath) {
    return { copied: false, bytes: 0, reason: "missing_path" };
  }
  const parentSize = await fileSizeOrZero(parentPath);
  if (parentSize <= 0) {
    return { copied: false, bytes: 0, reason: "empty_parent" };
  }
  const childSize = await fileSizeOrZero(childPath);
  if (childSize > 0) {
    return { copied: false, bytes: childSize, reason: "target_has_content" };
  }
  await fs.mkdir(path.dirname(childPath), { recursive: true });
  const content = await fs.readFile(parentPath, "utf-8");
  await fs.writeFile(childPath, content, "utf-8");
  return { copied: true, bytes: Buffer.byteLength(content, "utf-8"), reason: "copied" };
};

const deriveParentRuntimePath = (parentSessionPersistPath, filePath, parentRuntimeRootPath) => {
  if (parentRuntimeRootPath && filePath) {
    return path.join(parentRuntimeRootPath, path.basename(filePath));
  }
  if (!parentSessionPersistPath || !filePath) return "";
  return path.join(
    path.dirname(path.dirname(parentSessionPersistPath)),
    path.basename(filePath),
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
  const textResult = await copyParentRuntimeFileOnce(
    taskInput,
    deriveParentRuntimePath(
      taskInput.parentSessionPersistPath,
      taskInput.textPath,
      taskInput.parentRuntimeRootPath,
    ),
    taskInput.textPath,
  );
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
          text: textResult,
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
      " text_copied=" +
      String(Boolean(textResult.copied)) +
      " text_bytes=" +
      String(textResult.bytes || 0) +
      " text_reason=" +
      String(textResult.reason || ""),
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

const resolveParentAgentSessionId = (input) => {
  const parentSessionId = asString(input.parentSessionId);
  if (!parentSessionId) {
    throw new Error("fork session requested but parentSessionId is missing");
  }
  return parentSessionId;
};

const loadParentSessionAsChild = async (client, input) => {
  if (typeof client.loadSession !== "function") {
    throw new Error("sandbox-agent client does not support loadSession");
  }
  const parentAgentSessionId = resolveParentAgentSessionId(input);
  await appendDriverLog(
    input.stderrPath,
    "loading parent native session parent_agent_session_id=" +
      parentAgentSessionId,
  );
  const session = await client.loadSession({
    agent: input.provider,
    agentSessionId: parentAgentSessionId,
    cwd: input.cwd,
    model: input.model || undefined,
    thoughtLevel: input.thinkingLevel || undefined,
    mode: input.provider === "codex" ? "full-access" : undefined,
  });
  await appendDriverLog(
    input.stderrPath,
    "loaded parent native session parent_agent_session_id=" +
      parentAgentSessionId +
      " session_handle_agent_session_id=" +
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
  if (parentPersist) {
    const parentAgentSessionId = resolveParentAgentSessionId(input);
    const importResult = await persist.importEventsFrom(
      parentPersist,
      parentAgentSessionId,
      parentAgentSessionId,
    );
    await appendDriverLog(
      input.stderrPath,
      "fork event inheritance persist_import parent_agent_session_id=" +
        parentAgentSessionId +
        " imported=" +
        String(Boolean(importResult.imported)) +
        " count=" +
        String(importResult.count || 0) +
        " reason=" +
        String(importResult.reason || ""),
    );
  }
  const { session: childSession } = await loadParentSessionAsChild(client, input);
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
    onEventCount += 1;
    if (shouldLogEventDiagnostic(onEventCount, event)) {
      void appendDriverLifecycleLog(
        activeInput || input,
        "session_on_event count=" +
          String(onEventCount) +
          " active_task_id=" +
          String(activeTaskId || "") +
          " active_phase=" +
          String(activePhase || "") +
          " jsonl_path=" +
          String((activeInput || input)?.jsonlPath || "") +
          " state_event_count_before=" +
          String(state.eventCount || 0) +
          " " +
          summarizeEventForDiagnostics(event),
      ).catch(() => {});
    }
    eventWriteChain = eventWriteChain
      .then(() => appendSessionEvent(activeInput, state, event))
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
        activeInput.stderrPath || input.stderrPath,
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
    await withHeartbeat(
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
    state.outputFile = await inspectOutputEnvelopeFile(
      taskInput.structuredOutputResultPathInContainer,
    );
    state.exitRequested = Boolean(state.outputFile?.validEnvelope && state.outputFile.exit);
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
	await execAsync(`docker exec ${input.containerName} bash '${input.driverLaunchPath}'`);
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
		"if [ -f \"$pid_path\" ]; then pid=$(cat \"$pid_path\" 2>/dev/null || true); fi",
		"if [ -z \"$pid\" ]; then echo 'alive=false'; echo 'reason=missing_pid'; exit 0; fi",
		"state=$(ps -p \"$pid\" -o stat= 2>/dev/null | tr -d '[:space:]' || true)",
		"if [ -z \"$state\" ]; then echo 'alive=false'; echo 'reason=process_not_running'; echo \"pid=$pid\"; exit 0; fi",
		"case \"$state\" in *Z*) echo 'alive=false'; echo 'reason=process_zombie'; echo \"pid=$pid\"; echo \"state=$state\"; exit 0;; esac",
		"if ! kill -0 \"$pid\" 2>/dev/null; then echo 'alive=false'; echo 'reason=kill_check_failed'; echo \"pid=$pid\"; echo \"state=$state\"; exit 0; fi",
		"if [ ! -f \"$lifecycle_path\" ]; then echo 'alive=false'; echo 'reason=missing_lifecycle'; echo \"pid=$pid\"; echo \"state=$state\"; exit 0; fi",
		"now=$(date +%s)",
		"mtime=$(stat -c %Y \"$lifecycle_path\" 2>/dev/null || echo 0)",
		"age_seconds=$((now - mtime))",
		"age_ms=$((age_seconds * 1000))",
		"last_line=$(tail -n 1 \"$lifecycle_path\" 2>/dev/null | tr '\\n' ' ' || true)",
		"if [ \"$age_seconds\" -gt \"$max_idle_seconds\" ]; then echo 'alive=false'; echo 'reason=stale_lifecycle'; echo \"pid=$pid\"; echo \"state=$state\"; echo \"age_ms=$age_ms\"; echo \"last_line=$last_line\"; exit 0; fi",
		"echo 'alive=true'",
		"echo 'reason=ok'",
		"echo \"pid=$pid\"",
		"echo \"state=$state\"",
		"echo \"age_ms=$age_ms\"",
		"echo \"last_line=$last_line\"",
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
		"if [ -f \"$pid_path\" ]; then pid=$(cat \"$pid_path\" 2>/dev/null || true); fi",
		"if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then kill \"$pid\" 2>/dev/null || true; sleep 1; fi",
		"if [ -n \"$pid\" ] && kill -0 \"$pid\" 2>/dev/null; then kill -9 \"$pid\" 2>/dev/null || true; fi",
		"rm -f \"$pid_path\"",
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
		"if [ -d \"$queue_dir\" ]; then mv \"$queue_dir\" \"$queue_dir.stale-$(date +%s)-$$\" 2>/dev/null || true; fi",
		"mkdir -p \"$queue_dir\"",
	].join("; ");
	await execAsync(
		`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(script)}'`,
	).catch(() => {});
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
	const parentTask = await findTaskByIdRepo(input.parentTaskId).catch(() => null);
	if (!parentTask) {
		throw new Error(
			`Fork session requested but parent task '${input.parentTaskId}' was not found`,
		);
	}
	return buildTaskRootInContainer({
		scanJobId: input.scanJob.scanJobId,
		stageName: parentTask.stageName,
		name:
			resolveStageTaskName(parentTask.stageName, parentTask.input) ||
			parentTask.name,
		taskId: parentTask.taskId,
	});
};

const resolveParentRuntimeRootOnHost = async (
	input: RunSingleTurnAgentInput,
) => {
	if (input.sessionMode !== "fork" || !input.parentTaskId) {
		return null;
	}
	const parentTask = await findTaskByIdRepo(input.parentTaskId).catch(() => null);
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
			resolveStageTaskName(parentTask.stageName, parentTask.input) ||
			parentTask.name,
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

const copyFileIfPresent = async (source: string, target: string) => {
	if (!(await pathExists(source))) {
		return false;
	}
	await fs.mkdir(path.dirname(target), { recursive: true });
	await fs.copyFile(source, target);
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
		return {
			parentRuntimeRootPathInContainer: undefined,
			parentSessionPersistPathInContainer: undefined,
			parentAgentHomePathInContainer: undefined,
		};
	}

	const parentAgentHomeOnHost = path.join(
		parentRuntimeRootOnHost,
		SANDBOX_AGENT_AGENT_HOME_DIR_NAME,
	);
	const childAgentHomeOnHost = path.join(
		input.taskStageDirPath,
		SANDBOX_AGENT_AGENT_HOME_DIR_NAME,
	);
	const copiedAgentHome = await copyDirectoryReplacing(
		parentAgentHomeOnHost,
		childAgentHomeOnHost,
	);

	const parentSessionStoreOnHost = path.join(
		parentRuntimeRootOnHost,
		SANDBOX_AGENT_SESSION_STORE_DIR_NAME,
	);
	const childParentSessionStoreOnHost = path.join(
		input.taskStageDirPath,
		"parent-session-store",
	);
	const copiedParentSessionStore = await copyDirectoryReplacing(
		parentSessionStoreOnHost,
		childParentSessionStoreOnHost,
	);

	const childParentRuntimeOnHost = path.join(
		input.taskStageDirPath,
		"parent-runtime",
	);
	await fs.rm(childParentRuntimeOnHost, { recursive: true, force: true });
	await fs.mkdir(childParentRuntimeOnHost, { recursive: true });
	await Promise.all([
		copyFileIfPresent(
			path.join(parentRuntimeRootOnHost, input.runtimeFileNames.text),
			path.join(childParentRuntimeOnHost, input.runtimeFileNames.text),
		),
		copyFileIfPresent(
			path.join(parentRuntimeRootOnHost, input.runtimeFileNames.jsonl),
			path.join(childParentRuntimeOnHost, input.runtimeFileNames.jsonl),
		),
	]);

	if (!copiedAgentHome) {
		throw new Error(
			`Fork session requested but parent agent-home was not found at ${parentAgentHomeOnHost}`,
		);
	}

	return {
		parentRuntimeRootPathInContainer: TASK_PARENT_RUNTIME_ROOT_IN_CONTAINER,
		parentSessionPersistPathInContainer: copiedParentSessionStore
			? path.posix.join(
					TASK_PARENT_SESSION_STORE_ROOT_IN_CONTAINER,
					SANDBOX_AGENT_SESSION_PERSIST_FILE_NAME,
				)
			: null,
		parentAgentHomePathInContainer: null,
	};
};

const resolveParentAgentHomePathInContainer = async (
	input: RunSingleTurnAgentInput,
) => {
	if (input.sessionMode !== "fork" || !input.parentTaskId) {
		return null;
	}
	const parentTask = await findTaskByIdRepo(input.parentTaskId).catch(() => null);
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
	return parentTaskRoot ? buildTaskAgentHomePathInContainer(parentTaskRoot) : null;
};

const resolveParentSessionPersistPathInContainer = async (
	input: RunSingleTurnAgentInput,
) => {
	if (input.sessionMode !== "fork" || !input.parentTaskId) {
		return null;
	}
	const parentTask = await findTaskByIdRepo(input.parentTaskId).catch(() => null);
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
	return parentTaskRoot ? buildTaskSessionPersistPathInContainer(parentTaskRoot) : null;
};

const resolveAgentHomeLinkPathInContainer = (agentProvider: string) =>
	agentProvider === "claude_code"
		? CLAUDE_HOME_IN_CONTAINER
		: CODEX_HOME_IN_CONTAINER;

const prepareTaskAgentHomeInContainer = async (input: {
	containerName: string;
	agentProvider: string;
	agentProfile: AgentProfileLike | null;
	agentsDir: string | null;
	agentHomeRootInContainer: string;
	sessionMode?: "new" | "fork";
	parentAgentHomePathInContainer: string | null;
	reuseExistingAgentHome?: boolean;
}) => {
	const agentHomePathInContainer = buildTaskAgentHomePathInContainer(
		input.agentHomeRootInContainer,
	);
	const agentHomeLinkPathInContainer = resolveAgentHomeLinkPathInContainer(
		input.agentProvider,
	);
	const isFork = input.sessionMode === "fork";
	const setupScript = [
		"set -euo pipefail",
		`agent_home='${escapeSingleQuotes(agentHomePathInContainer)}'`,
		`agent_home_link='${escapeSingleQuotes(agentHomeLinkPathInContainer)}'`,
		`parent_agent_home='${escapeSingleQuotes(input.parentAgentHomePathInContainer || "")}'`,
		`reuse_existing='${input.reuseExistingAgentHome ? "1" : "0"}'`,
		"mkdir -p \"$(dirname \"$agent_home\")\" \"$(dirname \"$agent_home_link\")\"",
		"if [ \"$reuse_existing\" = \"1\" ] && [ -d \"$agent_home\" ]; then",
		"  :",
		"else",
		isFork
			? [
					"  if [ -d \"$agent_home\" ]; then",
					"    :",
					"  elif [ -n \"$parent_agent_home\" ] && [ -d \"$parent_agent_home\" ]; then",
					"    rm -rf \"$agent_home\"",
					"    cp -a \"$parent_agent_home\" \"$agent_home\"",
					"  else",
					"    echo \"fork session requested but neither current nor parent agent-home is available: $agent_home / $parent_agent_home\" >&2",
					"    exit 1",
					"  fi",
			  ].join("\n")
			: "  rm -rf \"$agent_home\" && mkdir -p \"$agent_home\"",
		"fi",
		"rm -rf \"$agent_home_link\"",
		"ln -s \"$agent_home\" \"$agent_home_link\"",
		"mkdir -p \"$agent_home/skills\"",
	].join("\n");

	await execAsync(
		`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(setupScript)}'`,
	);

	if (input.agentProvider === "claude_code") {
		await initializeClaudeHomeInContainer(
			input.containerName,
			agentHomePathInContainer,
		);
	} else {
		await copyCodexAssetsToContainerHome(
			input.containerName,
			agentHomePathInContainer,
			input.agentsDir,
			input.agentProfile,
		);
	}

	return {
		agentHomePathInContainer,
		agentHomeLinkPathInContainer,
		parentAgentHomePathInContainer: input.parentAgentHomePathInContainer,
		agentHomeCopiedFromParent: isFork,
	};
};

export const runSingleTurnAgentInContainer = async (
	input: RunSingleTurnAgentInput,
): Promise<RunSingleTurnAgentResult> => {
	const taskStageDirPath = input.taskStageDirPath || input.stageDirPath;
	const taskStageRootInContainer =
		input.taskStageRootInContainer || input.stageRootInContainer;
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
		const jsonSchema = buildStructuredOutputEnvelopeJsonSchema(
			input.outputSchema || input.routeOutputSchemas![0]!.schema,
			input.routeOutputSchemas,
		);
		await fs.mkdir(taskStageDirPath, { recursive: true });
		await fs.writeFile(
			structuredOutputSchemaPathOnHost,
			`${JSON.stringify(jsonSchema, null, 2)}\n`,
			"utf-8",
		);
	}

	const resolvedPrompt =
		typeof input.prompt === "string"
			? input.prompt
			: await input.prompt(input.containerName);
	const promptWithOutputSchema = input.outputSchema || input.routeOutputSchemas?.length
		? `${resolvedPrompt.trimEnd()}\n${buildStructuredOutputPromptSuffix(
				input.outputSchema || input.routeOutputSchemas![0]!.schema,
				structuredOutputSchemaAgentPathInContainer,
				structuredOutputResultAgentPathInContainer,
				input.routeOutputSchemas,
			)}`
		: resolvedPrompt;
	const runtimeFileNames = input.runtimeFileNames || {
		...SANDBOX_AGENT_RUNTIME_FILE_NAMES,
	};
	const taskRuntimeArtifacts = createCodexRuntimeArtifacts({
		runtimeDir: taskStageDirPath,
		jsonlFileName: runtimeFileNames.jsonl,
		textFileName: runtimeFileNames.text,
		stderrFileName: runtimeFileNames.stderr,
		stdoutFileName: runtimeFileNames.stdout,
	});
	await initializeRuntimeFiles({
		runtimeDir: taskStageDirPath,
		jsonlPath: path.join(taskStageDirPath, runtimeFileNames.jsonl),
		textPath: path.join(taskStageDirPath, runtimeFileNames.text),
		stderrPath: path.join(taskStageDirPath, runtimeFileNames.stderr),
		stdoutPath: path.join(taskStageDirPath, runtimeFileNames.stdout),
	});
	await initializeCodexRuntimeMetadataFiles({
		cursorPath: taskRuntimeArtifacts.cursorPath,
		statePath: taskRuntimeArtifacts.statePath,
	});
	await initializeRuntimeFilesInContainer({
		containerName: input.containerName,
		runtimeDirInContainer: taskStageRootInContainer,
		jsonlFileName: runtimeFileNames.jsonl,
		textFileName: runtimeFileNames.text,
		stderrFileName: runtimeFileNames.stderr,
		stdoutFileName: runtimeFileNames.stdout,
	});
	await initializeCodexRuntimeMetadataFilesInContainer({
		containerName: input.containerName,
		runtimeDirInContainer: taskStageRootInContainer,
		cursorFileName: taskRuntimeArtifacts.cursorFileName,
		stateFileName: taskRuntimeArtifacts.stateFileName,
		writeContainerFile,
	});
	const forkRuntimeArtifacts = await prepareForkRuntimeArtifactsOnHost({
		runInput: input,
		taskStageDirPath,
		runtimeFileNames,
	});
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
		? await inspectDriverHealth({
				containerName: input.containerName,
				driverPidPath,
				driverLifecyclePath,
			})
		: null;
	const persistentDriverAlive = Boolean(
		input.persistent && persistentDriverHealth?.alive,
	);
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
				agentHomeLinkPathInContainer: resolveAgentHomeLinkPathInContainer(
					agentProvider,
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
		  });

	const sandboxRuntime = await prepareSandboxAgentRuntime({
		containerName: input.containerName,
		stageDirPath: input.stageDirPath,
		stageDirInContainer: input.stageRootInContainer,
		provider: input.agentProfile?.provider || "codex",
		homeDir: "/root",
		envPairs:
			agentProvider === "claude_code" && input.agentProfile
				? buildClaudeEnvPairs(input.agentProfile)
					: [
						`CODEX_HOME=${CODEX_HOME_IN_CONTAINER}`,
						...(input.agentProfile
							? parseAgentProfileEnvPairs(input.agentProfile)
							: []),
					],
		reuseExisting: input.persistent,
	});
	const sessionPersistPathInContainer = buildTaskSessionPersistPathInContainer(
		input.stageRootInContainer,
	);
	const parentSessionPersistPathInContainer =
		forkRuntimeArtifacts.parentSessionPersistPathInContainer !== undefined
			? forkRuntimeArtifacts.parentSessionPersistPathInContainer
			: await resolveParentSessionPersistPathInContainer(input);
	const driverTaskInput = {
		taskId: input.taskId || undefined,
		baseUrl: sandboxRuntime.server.baseUrl,
		provider:
			input.agentProfile?.provider === "claude_code" ? "claude" : "codex",
		cwd: input.cwd,
		prompt: promptWithOutputSchema,
		taskStageRootInContainer,
		taskAliasRootInContainer: TASK_ALIAS_ROOT_IN_CONTAINER,
		structuredOutputResultPathInContainer,
		model: input.agentProfile?.model || null,
		thinkingLevel: input.agentProfile?.thinkingLevel || null,
		sessionMode: input.laneThreadId ? "persistent" : input.sessionMode || "new",
		parentSessionId: input.parentSessionId || null,
		parentRuntimeRootPath: parentTaskRootInContainer,
		parentSessionPersistPath: parentSessionPersistPathInContainer,
		sessionPersistPath: sessionPersistPathInContainer,
		jsonlPath: path.posix.join(
			taskStageRootInContainer,
			runtimeFileNames.jsonl,
		),
		textPath: path.posix.join(
			taskStageRootInContainer,
			runtimeFileNames.text,
		),
		stderrPath: path.posix.join(
			taskStageRootInContainer,
			runtimeFileNames.stderr,
		),
		stdoutPath: path.posix.join(
			taskStageRootInContainer,
			runtimeFileNames.stdout,
		),
		statePath: path.posix.join(
			taskStageRootInContainer,
			taskRuntimeArtifacts.stateFileName,
		),
		driverLifecyclePath,
		agentHomePathInContainer: taskAgentHome.agentHomePathInContainer,
		agentHomeLinkPathInContainer: taskAgentHome.agentHomeLinkPathInContainer,
		parentAgentHomePathInContainer: taskAgentHome.parentAgentHomePathInContainer,
		agentHomeCopiedFromParent: taskAgentHome.agentHomeCopiedFromParent,
	};
	if (persistentDriverAlive) {
		const requestPath = path.posix.join(
			taskQueueDir,
			`${Date.now()}-${input.scanJob.scanJobId}-${Math.random().toString(16).slice(2)}.json`,
		);
		await appendContainerFile(
			input.containerName,
			driverLifecyclePath,
			`[sandbox-agent-driver-lifecycle] ${new Date().toISOString()} host_enqueue task_id=${input.taskId || ""} request_path=${requestPath} lane_thread_id=${input.laneThreadId || ""}\n`,
		).catch(() => {});
		await writeContainerFileAtomically(
			input.containerName,
			requestPath,
			JSON.stringify(driverTaskInput, null, 2),
		);
		return {
			threadId: input.laneThreadId || null,
		};
	}
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

	await writeContainerFile(
		input.containerName,
		driverScriptPath,
		buildSandboxAgentDriverScript(),
	);
	await writeContainerFile(
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
	);
	await writeContainerFile(
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
	);
	await execAsync(
		`docker exec ${input.containerName} bash -lc "chmod +x '${driverLaunchPath}'"`,
	);
	await launchDriver({
		containerName: input.containerName,
		driverLaunchPath,
	});

	return {
		threadId: null,
	};
};
