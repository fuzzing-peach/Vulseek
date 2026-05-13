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
import type { StageOutputTextChannel } from "../pipeline/stage-definition";

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
const STRUCTURED_OUTPUT_SCHEMA_FILE_NAME = "output.schema.json";
const STRUCTURED_OUTPUT_RESULT_FILE_NAME = "structured-output.json";
const SHARED_AGENT_HOME_CONTAINER_ROOT = "/scan-context/agent-home";
const CODEX_HOME_IN_CONTAINER = "/root/.codex";
const CLAUDE_HOME_IN_CONTAINER = "/root/.claude";

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

const buildProjectProfileContextRoot = () => CONTAINER_SCAN_CONTEXT_ROOT;
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

const sleep = async (ms: number) =>
	await new Promise<void>((resolve) => {
		setTimeout(resolve, ms);
	});

const execDockerRunWithRetry = async (input: {
	containerName: string;
	command: string;
}) => {
	let lastError: unknown = null;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			return await execAsync(input.command);
		} catch (error) {
			lastError = error;
			await execAsync(`docker rm -f ${input.containerName}`).catch(() => {});
			if (attempt < 3) {
				await sleep(attempt * 1500);
			}
		}
	}
	throw lastError;
};

const resolveConfiguredScanContextHostPath = () =>
	process.env.DOKPLOY_SCAN_CONTEXT_HOST_PATH?.trim() || "";

const resolveScanContextMount = async (input: {
	contextVolumeName?: string | null;
	projectName: string;
	profileName: string;
}) => {
	const configuredHostRoot = resolveConfiguredScanContextHostPath();
	if (!configuredHostRoot) {
		throw new Error(
			"Scan context host path is not configured. Restart dokploy-dev from dev.sh so /scan-context is mounted.",
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
	return {
		mountSource: hostProfileDir,
		mountDescription: `host_path:${hostProfileDir}`,
		dockerMountArg: `-v '${escapeSingleQuotes(hostProfileDir)}':${CONTAINER_SCAN_CONTEXT_ROOT}`,
	};
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
	agentProfile: AgentProfileLike | null;
	containerName: string;
	codexHome: string;
	stageDirPath: string;
	stageRootInContainer: string;
	runtimeFileNames?: {
		jsonl: string;
		text: string;
		stderr: string;
		stdout: string;
	};
};

export type RunSingleTurnAgentInput = StageContainerInput & {
	cwd: string;
	prompt: string | ((containerName: string) => Promise<string>);
	outputSchema?: ZodTypeAny;
	outputTextChannel?: StageOutputTextChannel;
	onThreadId?: (threadId: string) => Promise<void>;
	sessionMode?: "new" | "fork";
	parentSessionId?: string | null;
};

export type RunSingleTurnAgentResult = {
	threadId: string | null;
};

const buildStructuredOutputPromptSuffix = (
	schema: ZodTypeAny,
	schemaFilePath: string,
	outputTextChannel: StageOutputTextChannel,
	outputFilePath: string,
) => {
	const jsonSchema = zodToJsonSchema(schema, {
		target: "jsonSchema7",
		$refStrategy: "none",
	});
	const returnInstructions =
		outputTextChannel === "file"
			? [
					`- Write the validated JSON object to ${outputFilePath}.`,
					"- The output file content must be only the validated JSON object, with no markdown fences, comments, or prose.",
					"- Do not print the full JSON object to the terminal, tool output, or final visible response.",
					`- Your final visible return payload must contain exactly one <VULSEEK_RET>${outputFilePath}<VULSEEK_RET> block.`,
					"- The marker payload must be only that output file path.",
					"- Dokploy will read the JSON object from that file after receiving the marker payload.",
				]
			: [
					"- Only after your structured output passes that validation may you return it inside <VULSEEK_RET>...<VULSEEK_RET>.",
					"- Your final visible return payload must contain exactly one <VULSEEK_RET>...<VULSEEK_RET> block whose inner content is only the validated JSON object.",
					"- You do not need to write the final JSON object to any output file. Only return the validated top-level JSON object inside <VULSEEK_RET>...<VULSEEK_RET>.",
				];

	return [
		"",
		"Structured JSON output requirement:",
		`- The JSON Schema for this stage is written to ${schemaFilePath}.`,
		"- You must use that schema file as the source of truth and validate your final structured output against it before returning.",
		"- Perform validation with Python and the jsonschema package available in the container environment.",
		"- Load the JSON object you intend to return, load the schema from the schema file, and validate it locally with python before returning.",
		"- During validation, do not print the full JSON object to the terminal or write it to a tool-output file; print only a short success/failure line.",
		"- If validation fails, fix the JSON and validate again before returning.",
		"- The structured JSON object you produce for this stage must conform exactly to that JSON Schema.",
		"- Do not add extra fields outside the schema.",
		"- Use null for nullable fields instead of omitting them unless the schema explicitly allows omission.",
		"- Ensure the top-level value is a JSON object.",
		...returnInstructions,
		"",
		"```json",
		JSON.stringify(jsonSchema, null, 2),
		"```",
	].join("\n");
};

const resolveStageContainerRuntime = async (input: StageContainerInput) => {
	const {
		imageTag,
		contextVolumeName,
		projectName,
		serviceName,
		projectProfileContextRoot,
		projectProfileCacheRoot,
	} = await resolveScanExecutionContext(input.scanJob);
	const agentsDir = await resolveAgentsDirectory();
	const scanContextMount = await resolveScanContextMount({
		contextVolumeName,
		projectName,
		profileName: serviceName,
	});
	const sharedAgentHomeHostRoot = path.join(
		scanContextMount.mountSource,
		"jobs",
		input.scanJob.scanJobId,
		"agent-home",
	);
	const sharedAgentHomeLocalRoot = path.join(
		CONTAINER_SCAN_CONTEXT_ROOT,
		"projects",
		sanitizeContextPathPart(projectName),
		"profiles",
		sanitizeContextPathPart(serviceName),
		"jobs",
		input.scanJob.scanJobId,
		"agent-home",
	);
	const codexHostDir = path.join(sharedAgentHomeHostRoot, ".codex");
	const claudeHostDir = path.join(sharedAgentHomeHostRoot, ".claude");
	const codexLocalDir = path.join(sharedAgentHomeLocalRoot, ".codex");
	const claudeLocalDir = path.join(sharedAgentHomeLocalRoot, ".claude");
	const containerEnvPairs = [
		...getGlobalContainerEnvironmentPairs(),
		`VULSEEK_PROJECT_PROFILE_DIR=${projectProfileContextRoot}`,
		`VULSEEK_PROJECT_CACHE_DIR=${projectProfileCacheRoot}`,
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
		scanContextMount,
		sharedAgentHome: {
			hostRoot: sharedAgentHomeHostRoot,
			codexHostDir,
			claudeHostDir,
			localRoot: sharedAgentHomeLocalRoot,
			codexLocalDir,
			claudeLocalDir,
			containerRoot: path.posix.join(
				SHARED_AGENT_HOME_CONTAINER_ROOT,
				input.scanJob.scanJobId,
			),
			codexContainerDir: CODEX_HOME_IN_CONTAINER,
			claudeContainerDir: CLAUDE_HOME_IN_CONTAINER,
			dockerMountArgs: [
				`-v '${escapeSingleQuotes(codexHostDir)}':'${CODEX_HOME_IN_CONTAINER}'`,
				`-v '${escapeSingleQuotes(claudeHostDir)}':'${CLAUDE_HOME_IN_CONTAINER}'`,
			].join(" "),
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

	// Recovery/retry may encounter leftover containers with the same deterministic
	// name. Remove them first so restart logic can safely recreate the runtime.
	await execAsync(`docker rm -f ${input.containerName}`).catch(() => {});

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
	await fs.mkdir(runtime.sharedAgentHome.codexLocalDir, { recursive: true });
	await fs.mkdir(runtime.sharedAgentHome.claudeLocalDir, { recursive: true });
	await fs.writeFile(
		path.join(runtime.sharedAgentHome.claudeLocalDir, "settings.json"),
		`${JSON.stringify({}, null, 2)}\n`,
		{ flag: "wx" },
	).catch((error: unknown) => {
		if (
			!(
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "EEXIST"
			)
		) {
			throw error;
		}
	});

	await execDockerRunWithRetry({
		containerName: input.containerName,
		command: `docker run -d --name ${input.containerName} ${runtime.containerNetworkArg} ${buildNamespaceEnabledContainerArgs()} ${runtime.scanContextMount.dockerMountArg} ${runtime.sharedAgentHome.dockerMountArgs} ${runtime.containerEnvArgs} ${runtime.imageTag} bash -lc "mkdir -p '${input.stageRootInContainer}' '${runtime.sharedAgentHome.codexContainerDir}/skills' '${runtime.sharedAgentHome.claudeContainerDir}' && sleep infinity"`,
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
		runtime.sharedAgentHome.codexContainerDir,
		runtime.agentsDir,
		input.agentProfile,
	);
	await initializeClaudeHomeInContainer(
		input.containerName,
		runtime.sharedAgentHome.claudeContainerDir,
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
const SANDBOX_AGENT_FORK_DEBUG_FILE_NAME = "sandbox-agent-fork-debug.json";

const buildSandboxAgentDriverScript = () => String.raw`import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const ACP_HTTP_TIMEOUT_MS = 15 * 60 * 1000;
const SANDBOX_AGENT_PROMPT_TIMEOUT_MS = 30 * 60 * 1000;
const SANDBOX_AGENT_POST_PROMPT_EVENT_IDLE_MS = 30 * 1000;
const SANDBOX_AGENT_POST_PROMPT_EVENT_POLL_MS = 100;
const VULSEEK_RET_MARKER = "<VULSEEK_RET>";
const VULSEEK_RET_XML_CLOSE_MARKER = "</VULSEEK_RET>";

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

    req.setTimeout(ACP_HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error("sandbox-agent fetch timed out waiting for response"));
    });
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

const extractVulseekRetValue = (content) => {
	const acceptPairedPayload = (payload) => {
		const trimmed = payload.trim();
		return trimmed || null;
	};

	const acceptTrailingStructuredPayload = (payload) => {
		const trimmed = payload.trim();
		if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
			return null;
		}
    try {
      JSON.parse(trimmed);
    } catch {
      return null;
    }
		return trimmed;
	};

  const xmlEnd = content.lastIndexOf(VULSEEK_RET_XML_CLOSE_MARKER);
  if (xmlEnd > 0) {
    const xmlStart = content.lastIndexOf(VULSEEK_RET_MARKER, xmlEnd - 1);
    if (xmlStart >= 0) {
      return acceptPairedPayload(content.slice(xmlStart + VULSEEK_RET_MARKER.length, xmlEnd));
    }
  }

	const end = content.lastIndexOf(VULSEEK_RET_MARKER);
	if (end >= 0) {
    const trailingPayload = acceptTrailingStructuredPayload(
      content.slice(end + VULSEEK_RET_MARKER.length),
    );
    if (trailingPayload !== null) {
      return trailingPayload;
    }
  }
	if (end <= 0) return null;
	const start = content.lastIndexOf(VULSEEK_RET_MARKER, end - 1);
	if (start < 0) return null;
	return acceptPairedPayload(content.slice(start + VULSEEK_RET_MARKER.length, end));
};

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
  if (asString(payloadRecord?.sessionUpdate) === "usage_update") {
    state.usageUpdates.push({
      createdAt: event.createdAt || null,
      update: payloadRecord,
    });
  }
  if (asString(payloadRecord?.sessionUpdate) === "agent_message_chunk") {
    const chunkText = extractPayloadText(update);
    state.agentMessageText += chunkText;
    const nextReturnValue = extractVulseekRetValue(state.agentMessageText);
    if (nextReturnValue !== null) {
      state.returnValue = nextReturnValue;
    }
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

const sleep = async (ms) =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitForPostPromptEventDrain = async (input, state, getEventWriteChain) => {
  const startedAt = Date.now();
  let logged = false;
  let loggedEndTurn = false;
  let stopReason = "return_value";
  while (!state.returnValue) {
    if (!logged) {
      logged = true;
      await appendDriverLog(
        input.stderrPath,
        "waiting for post-prompt events after prompt resolved idle_ms=" +
          String(SANDBOX_AGENT_POST_PROMPT_EVENT_IDLE_MS),
      );
    }
    await getEventWriteChain();

    if (state.returnValue) {
      break;
    }

    if (state.endTurnReceived && !loggedEndTurn) {
      loggedEndTurn = true;
      await appendDriverLog(
        input.stderrPath,
        "received end_turn event index=" + String(state.endTurnEventIndex ?? ""),
      );
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
  if (!state.returnValue) {
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
    this.lockPath = filePath + ".lock";
  }

  async readData() {
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

  async writeData(data) {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath =
      this.filePath + "." + process.pid + "." + Date.now() + ".tmp";
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await fs.rename(tmpPath, this.filePath);
  }

  async withLock(callback) {
    const deadline = Date.now() + 30000;
    while (true) {
      try {
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
    const data = await this.readData();
    return data.sessions[id];
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
      const data = await this.readData();
      data.sessions[session.id] = session;
      await this.writeData(data);
    });
  }

  async listEvents(request) {
    const data = await this.readData();
    const events = Array.isArray(data.eventsBySession[request.sessionId])
      ? data.eventsBySession[request.sessionId]
      : [];
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
    await this.withLock(async () => {
      const data = await this.readData();
      const events = Array.isArray(data.eventsBySession[sessionId])
        ? data.eventsBySession[sessionId]
        : [];
      events.push(event);
      data.eventsBySession[sessionId] = events;
      await this.writeData(data);
    });
  }

  async forkSession(parentSessionId, childSessionId) {
    return await this.withLock(async () => {
      const data = await this.readData();
      const parentRecord = data.sessions[parentSessionId];
      if (!parentRecord) {
        throw new Error("parent session '" + parentSessionId + "' not found in shared persist");
      }
      const parentEvents = Array.isArray(data.eventsBySession[parentSessionId])
        ? data.eventsBySession[parentSessionId]
        : [];
      data.sessions[childSessionId] = {
        ...parentRecord,
        id: childSessionId,
        agentSessionId: "",
        lastConnectionId: "",
        createdAt: Date.now(),
        destroyedAt: undefined,
      };
      data.eventsBySession[childSessionId] = parentEvents.map((event) => ({
        ...event,
        id: crypto.randomUUID(),
        sessionId: childSessionId,
      }));
      await this.writeData(data);
      return parentEvents.length;
    });
  }
}

const normalizePersistEventForForkCompare = (event) => {
  if (!event || typeof event !== "object") return event;
  const normalized = { ...event };
  delete normalized.id;
  delete normalized.sessionId;
  return normalized;
};

const writeForkDebugFile = async (input, persist, details = {}) => {
  if (!input.forkDebugPath) {
    return;
  }
  const parentSessionId = asString(input.parentSessionId);
  const childSessionId = asString(details.childSessionId);
  let parentEventCount = null;
  let childEventCount = null;
  let childHasParentPrefix = null;
  let parentFirstEventMethod = null;
  let childFirstEventMethod = null;
  let childFirstPromptTextPrefix = null;

  if (persist && parentSessionId && childSessionId) {
    const data = await persist.readData();
    const parentEvents = Array.isArray(data.eventsBySession[parentSessionId])
      ? data.eventsBySession[parentSessionId]
      : [];
    const childEvents = Array.isArray(data.eventsBySession[childSessionId])
      ? data.eventsBySession[childSessionId]
      : [];
    const parentNormalized = parentEvents.map(normalizePersistEventForForkCompare);
    const childNormalizedPrefix = childEvents
      .slice(0, parentEvents.length)
      .map(normalizePersistEventForForkCompare);
    parentEventCount = parentEvents.length;
    childEventCount = childEvents.length;
    childHasParentPrefix =
      parentEventCount > 0 &&
      JSON.stringify(parentNormalized) === JSON.stringify(childNormalizedPrefix);
    parentFirstEventMethod = asString(asRecord(parentEvents[0]?.payload)?.method);
    childFirstEventMethod = asString(asRecord(childEvents[0]?.payload)?.method);
    const firstPrompt = childEvents.find(
      (event) => asString(asRecord(event?.payload)?.method) === "session/prompt",
    );
    const prompt = asRecord(asRecord(firstPrompt?.payload)?.params)?.prompt;
    childFirstPromptTextPrefix = Array.isArray(prompt)
      ? prompt.map((item) => asString(asRecord(item)?.text)).join("").slice(0, 240)
      : null;
  }

  const debug = {
    writtenAt: new Date().toISOString(),
    sessionMode: String(input.sessionMode || "new"),
    provider: String(input.provider || ""),
    parentSessionId: parentSessionId || null,
    childSessionId: childSessionId || null,
    resumedSessionId: asString(details.resumedSessionId) || null,
    persistPath: input.sessionPersistPath || null,
    parentEventCount,
    childEventCount,
    childHasParentPrefix,
    parentFirstEventMethod,
    childFirstEventMethod,
    childFirstPromptTextPrefix,
    stageCwd: input.cwd || null,
    note:
      childHasParentPrefix === true
        ? "child persist begins with normalized parent events"
        : "prefix check unavailable or failed",
  };
  await fs.mkdir(path.dirname(input.forkDebugPath), { recursive: true });
  await fs.writeFile(input.forkDebugPath, JSON.stringify(debug, null, 2), "utf-8");
};

const mergeForkDebugFile = async (input, patch) => {
  if (!input.forkDebugPath) {
    return;
  }
  let existing = {};
  try {
    existing = JSON.parse(await fs.readFile(input.forkDebugPath, "utf-8"));
  } catch {}
  await fs.mkdir(path.dirname(input.forkDebugPath), { recursive: true });
  await fs.writeFile(
    input.forkDebugPath,
    JSON.stringify(
      {
        ...asRecord(existing),
        ...patch,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
};

const readUsageUsed = (usage) => {
  const record = asRecord(usage);
  const used = record?.used;
  const totalTokens = record?.totalTokens ?? record?.total_tokens ?? record?.total;
  if (typeof used === "number") return used;
  if (typeof totalTokens === "number") return totalTokens;
  return null;
};

const extractUsageUpdateFromEvent = (event) => {
  const update = asRecord(getEventUpdate(event));
  if (asString(update?.sessionUpdate) !== "usage_update") {
    return null;
  }
  return {
    createdAt: event.createdAt || null,
    update,
  };
};

const getLastPersistUsageUpdate = (events) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const usage = extractUsageUpdateFromEvent(events[index]);
    if (usage) {
      return usage;
    }
  }
  return null;
};

const buildUsageForkCheck = async (input, persist, state, sessionId) => {
  if (!persist || String(input.sessionMode || "new") !== "fork") {
    return null;
  }
  const parentSessionId = asString(input.parentSessionId);
  if (!parentSessionId) {
    return null;
  }
  const data = await persist.readData();
  const parentEvents = Array.isArray(data.eventsBySession[parentSessionId])
    ? data.eventsBySession[parentSessionId]
    : [];
  const childEvents = Array.isArray(data.eventsBySession[sessionId])
    ? data.eventsBySession[sessionId]
    : [];
  const parentLastUsage = getLastPersistUsageUpdate(parentEvents);
  const childPersistLastUsage = getLastPersistUsageUpdate(childEvents);
  const childFirstObservedUsage = state.usageUpdates[0] || null;
  const childLastObservedUsage =
    state.usageUpdates.length > 0
      ? state.usageUpdates[state.usageUpdates.length - 1]
      : null;
  const stagePromptEstimatedTokens = Math.ceil(asString(input.prompt).length / 4);
  const childFirstUsed = readUsageUsed(childFirstObservedUsage?.update);
  const parentLastUsed = readUsageUsed(parentLastUsage?.update);
  const usageExceedsStagePromptEstimate =
    typeof childFirstUsed === "number"
      ? childFirstUsed > stagePromptEstimatedTokens + 1000
      : null;
  const childUsageAtLeastParentUsage =
    typeof childFirstUsed === "number" && typeof parentLastUsed === "number"
      ? childFirstUsed >= Math.floor(parentLastUsed * 0.8)
      : null;
  return {
    enabled: true,
    method: "usage_update_heuristic",
    stagePromptCharCount: asString(input.prompt).length,
    stagePromptEstimatedTokens,
    observedUsageUpdateCount: state.usageUpdates.length,
    parentLastUsage,
    childFirstObservedUsage,
    childLastObservedUsage,
    childPersistLastUsage,
    usageExceedsStagePromptEstimate,
    childUsageAtLeastParentUsage,
    likelyForkContextLoadedFromUsage:
      usageExceedsStagePromptEstimate === true ||
      childUsageAtLeastParentUsage === true,
    note:
      "usage_update is a heuristic signal: it can indicate inherited context pressure, but it is not a strict proof that the model semantically used parent context.",
  };
};

const getSessionId = (session) =>
  asString(session?.id) || asString(session?.agentSessionId) || "";

const createNewSession = async (client, input) =>
  await client.createSession({
    agent: input.provider,
    cwd: input.cwd,
    model: input.model || undefined,
    thoughtLevel: input.thinkingLevel || undefined,
    mode: input.provider === "codex" ? "full-access" : undefined,
  });

const resumeParentSession = async (client, input) => {
  const parentSessionId = asString(input.parentSessionId);
  if (!parentSessionId) {
    throw new Error("fork session requested but parentSessionId is missing");
  }
  if (typeof client.resumeSession !== "function") {
    throw new Error("sandbox-agent client does not support resumeSession");
  }
  return await client.resumeSession(parentSessionId);
};

const forkPersistedSession = async (persist, input) => {
  const parentSessionId = asString(input.parentSessionId);
  if (!parentSessionId) {
    throw new Error("fork session requested but parentSessionId is missing");
  }
  const childSessionId = crypto.randomUUID();
  const parentEventCount = await persist.forkSession(
    parentSessionId,
    childSessionId,
  );
  await appendDriverLog(
    input.stderrPath,
    "forked persisted parent session " +
      parentSessionId +
      " into child session " +
      childSessionId +
      " with events=" +
      String(parentEventCount),
  );
  return childSessionId;
};

const forkFromResumedSession = async (client, parentSession, input) => {
  const parentSessionId = asString(input.parentSessionId);
  if (parentSession && typeof parentSession.fork === "function") {
    return await parentSession.fork({
      cwd: input.cwd,
      model: input.model || undefined,
      thoughtLevel: input.thinkingLevel || undefined,
      mode: input.provider === "codex" ? "full-access" : undefined,
    });
  }
  if (parentSession && typeof parentSession.forkSession === "function") {
    return await parentSession.forkSession({
      cwd: input.cwd,
      model: input.model || undefined,
      thoughtLevel: input.thinkingLevel || undefined,
      mode: input.provider === "codex" ? "full-access" : undefined,
    });
  }
  if (typeof client.forkSession === "function") {
    const forkInput = {
      agent: input.provider,
      cwd: input.cwd,
      agentSessionId: parentSessionId,
      sessionId: parentSessionId,
      id: parentSessionId,
      model: input.model || undefined,
      thoughtLevel: input.thinkingLevel || undefined,
      mode: input.provider === "codex" ? "full-access" : undefined,
    };
    try {
      return await client.forkSession(forkInput);
    } catch (error) {
      await appendDriverLog(
        input.stderrPath,
        "forkSession object form failed: " +
          (error instanceof Error ? error.message : String(error)),
      );
      return await client.forkSession(parentSessionId, forkInput);
    }
  }
  throw new Error("sandbox-agent client does not support session fork");
};

const createDriverSession = async (client, input, persist) => {
  if (input.sessionMode !== "fork") {
    await appendDriverLog(input.stderrPath, "creating session");
    return await createNewSession(client, input);
  }

  await appendDriverLog(
    input.stderrPath,
    "resuming parent session " + String(input.parentSessionId || ""),
  );
  if (persist) {
    const childSessionId = await forkPersistedSession(persist, input);
    process.stdout.write("THREAD_ID:" + childSessionId + "\n");
    await appendDriverLog(
      input.stderrPath,
      "reported forked child session " + childSessionId,
    );
    await appendDriverLog(input.stderrPath, "resuming forked child session");
    const childSession = await client.resumeSession(childSessionId);
    await writeForkDebugFile(input, persist, {
      childSessionId,
      resumedSessionId: getSessionId(childSession),
    });
    return childSession;
  }

  const parentSession = await resumeParentSession(client, input);
  await appendDriverLog(
    input.stderrPath,
    "parent session resumed keys=" +
      JSON.stringify(Object.keys(asRecord(parentSession) || {})),
  );
  await appendDriverLog(input.stderrPath, "forking session from parent");
  const childSession = await forkFromResumedSession(client, parentSession, input);
  await writeForkDebugFile(input, persist, {
    childSessionId: getSessionId(childSession),
    resumedSessionId: getSessionId(childSession),
  });
  return childSession;
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
  const client = await SandboxAgent.connect({
    baseUrl: input.baseUrl,
    fetch: acpFetch,
    ...(persist ? { persist } : {}),
  });
  await appendDriverLog(input.stderrPath, "sandbox-agent connected");

  const session = await withHeartbeat(
    createDriverSession(client, input, persist),
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
  const sessionRecord = asRecord(session);
  await appendDriverLog(
    input.stderrPath,
    "session ready mode=" +
      String(input.sessionMode || "new") +
      " keys=" +
      JSON.stringify(Object.keys(sessionRecord || {})),
  );

  const sessionId = getSessionId(session);
  if (sessionId) {
    await appendDriverLog(input.stderrPath, "emitting thread id");
    process.stdout.write("THREAD_ID:" + sessionId + "\n");
  } else {
    await appendDriverLog(
      input.stderrPath,
      "session created without thread id agentSessionId=" +
        String(asString(session?.agentSessionId) || "") +
        " id=" +
        String(asString(session?.id) || ""),
    );
  }

  const state = {
    agentMessageText: "",
    usageUpdates: [],
    returnValue: "",
    endTurnReceived: false,
    endTurnEventIndex: null,
    eventCount: 0,
    lastEventAt: 0,
  };
  let eventWriteChain = Promise.resolve();

  session.onEvent((event) => {
    eventWriteChain = eventWriteChain
      .then(() => appendSessionEvent(input, state, event))
      .then(async () => {
        const payload = getEventPayloadRecord(event);
        if (asString(payload?.method) !== "session/request_permission") {
          return;
        }
        const params = asRecord(payload?.params) || {};
        await autoApprovePermissionRequest(session, input, {
          ...params,
          id: asString(payload?.id) || asString(params.id) || undefined,
        });
      })
      .catch(async (error) => {
        await appendScanRuntimeFile(
          input.stderrPath,
          "[sandbox-agent-event] " +
            (error instanceof Error ? error.message : "unknown error") +
            "\n",
        );
      });
  });

  session.onPermissionRequest((request) => {
    void autoApprovePermissionRequest(session, input, request);
  });

  await appendDriverLog(input.stderrPath, "starting prompt");
  await withTimeout(
    session.prompt([{ type: "text", text: input.prompt }]),
    SANDBOX_AGENT_PROMPT_TIMEOUT_MS,
    () =>
      new Error(
        "sandbox-agent session.prompt timed out after " +
          SANDBOX_AGENT_PROMPT_TIMEOUT_MS / 1000 +
          "s",
      ),
  );
  await appendDriverLog(input.stderrPath, "prompt finished");
  await waitForPostPromptEventDrain(input, state, () => eventWriteChain);
  if (String(input.sessionMode || "new") === "fork") {
    const usageForkCheck = await buildUsageForkCheck(
      input,
      persist,
      state,
      sessionId,
    ).catch((error) => ({
      enabled: true,
      method: "usage_update_heuristic",
      error: error instanceof Error ? error.message : String(error),
      likelyForkContextLoadedFromUsage: null,
    }));
    if (usageForkCheck) {
      await mergeForkDebugFile(input, { usageForkCheck });
    }
  }
  if (!state.returnValue) {
    await appendScanRuntimeFile(
      input.stderrPath,
      "[sandbox-agent-driver] prompt completed without <VULSEEK_RET>\n",
    );
  }
};

main().catch(async (error) => {
  const inputPath = process.argv[2];
  if (inputPath) {
    try {
      const input = JSON.parse(await fs.readFile(inputPath, "utf-8"));
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
	taskStdoutPath: string;
	stderrPath: string;
}) => `#!/usr/bin/env bash
set -euo pipefail

mkdir -p '${escapeSingleQuotes(path.posix.dirname(input.driverScriptPath))}'
: > '${escapeSingleQuotes(input.driverStdoutPath)}'

nohup bash -lc 'export SANDBOX_AGENT_MODULE_PATH="$(npm root -g)/sandbox-agent" && node "${input.driverScriptPath}" "${input.driverInputPath}" > >(tee -a "${input.driverStdoutPath}" "${input.taskStdoutPath}" >/dev/null) 2>> "${input.stderrPath}"; status=$?; echo "[sandbox-agent-driver] exit_code=$status" >> "${input.stderrPath}"' >/dev/null 2>&1 &
driver_pid=$!
echo "[sandbox-agent-driver] pid=$driver_pid" >> '${escapeSingleQuotes(input.stderrPath)}'
`;

const launchDriver = async (input: {
	containerName: string;
	driverLaunchPath: string;
}) => {
	await execAsync(`docker exec ${input.containerName} bash '${input.driverLaunchPath}'`);
};

export const runSingleTurnAgentInContainer = async (
	input: RunSingleTurnAgentInput,
): Promise<RunSingleTurnAgentResult> => {
	const structuredOutputSchemaPathInContainer = path.posix.join(
		input.stageRootInContainer,
		STRUCTURED_OUTPUT_SCHEMA_FILE_NAME,
	);
	const structuredOutputSchemaPathOnHost = path.join(
		input.stageDirPath,
		STRUCTURED_OUTPUT_SCHEMA_FILE_NAME,
	);
	const structuredOutputResultPathInContainer = path.posix.join(
		input.stageRootInContainer,
		STRUCTURED_OUTPUT_RESULT_FILE_NAME,
	);
	const outputTextChannel = input.outputTextChannel || "file";
	if (input.outputSchema) {
		const jsonSchema = zodToJsonSchema(input.outputSchema, {
			target: "jsonSchema7",
			$refStrategy: "none",
		});
		await fs.mkdir(input.stageDirPath, { recursive: true });
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
	const promptWithOutputSchema = input.outputSchema
		? `${resolvedPrompt.trimEnd()}\n${buildStructuredOutputPromptSuffix(
				input.outputSchema,
				structuredOutputSchemaPathInContainer,
				outputTextChannel,
				structuredOutputResultPathInContainer,
			)}`
		: resolvedPrompt;
	const runtimeFileNames = input.runtimeFileNames || {
		...SANDBOX_AGENT_RUNTIME_FILE_NAMES,
	};
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
	});

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
				baseUrl: sandboxRuntime.server.baseUrl,
				provider:
					input.agentProfile?.provider === "claude_code" ? "claude" : "codex",
				cwd: input.cwd,
				prompt: promptWithOutputSchema,
				outputTextChannel,
				structuredOutputResultPathInContainer,
				model: input.agentProfile?.model || null,
				thinkingLevel: input.agentProfile?.thinkingLevel || null,
				sessionMode: input.sessionMode || "new",
				parentSessionId: input.parentSessionId || null,
				sessionPersistPath: path.posix.join(
					CODEX_HOME_IN_CONTAINER,
					"sandbox-agent-persist.json",
				),
				jsonlPath: path.posix.join(
					input.stageRootInContainer,
					runtimeFileNames.jsonl,
				),
				textPath: path.posix.join(
					input.stageRootInContainer,
					runtimeFileNames.text,
				),
				stderrPath: path.posix.join(
					input.stageRootInContainer,
					runtimeFileNames.stderr,
				),
				forkDebugPath: path.posix.join(
					input.stageRootInContainer,
					SANDBOX_AGENT_FORK_DEBUG_FILE_NAME,
				),
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
			taskStdoutPath: path.posix.join(
				input.stageRootInContainer,
				runtimeFileNames.stdout,
			),
			stderrPath: path.posix.join(
				input.stageRootInContainer,
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
