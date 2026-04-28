import { promises as fs } from "node:fs";
import path from "node:path";
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
import { runSandboxAgentHeadlessTurnInContainer } from "./sandbox-agent-runner";
import { installRuntimeSkillsInContainer } from "./runtime-skills";

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

const buildCodexConfigToml = (agentProfile: AgentProfileLike) => {
	const providerName = sanitizeProviderName(agentProfile.agentProfileId);

	return [
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
	].join("\n");
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

const buildClaudeEnvPairs = (agentProfile: AgentProfileLike) => [
	`ANTHROPIC_BASE_URL=${agentProfile.baseUrl}`,
	`ANTHROPIC_API_KEY=${agentProfile.apiKey}`,
	`ANTHROPIC_AUTH_TOKEN=${agentProfile.apiKey}`,
	`ANTHROPIC_MODEL=${agentProfile.model}`,
	`ANTHROPIC_DEFAULT_SONNET_MODEL=${agentProfile.model}`,
	`ANTHROPIC_DEFAULT_OPUS_MODEL=${agentProfile.model}`,
	`ANTHROPIC_DEFAULT_HAIKU_MODEL=${agentProfile.model}`,
	`CLAUDE_CODE_ENTRYPOINT=dokploy-vulseek`,
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
				joinTomlBlocks(buildCodexConfigToml(agentProfile), mcpConfigToml),
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
			joinTomlBlocks(baseConfigToml, mcpConfigToml),
		);
	} catch {
		if (mcpConfigToml) {
			await writeContainerFile(
				containerName,
				`${codexHome}/config.toml`,
				mcpConfigToml,
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

export type StageContainerInput = {
	scanJob: ScanJob;
	agentProfile: AgentProfileLike | null;
	containerName: string;
	codexHome: string;
	runtimeDirHost: string;
	runtimeRootInContainer: string;
	runtimeFileNames?: {
		jsonl: string;
		text: string;
		stderr: string;
	};
};

export type RunSingleTurnAgentInput = StageContainerInput & {
	cwd: string;
	prompt: string | ((containerName: string) => Promise<string>);
	setupMarkdownPathInContainer?: string;
	setupMarkdown?: string;
	onThreadId?: (threadId: string) => Promise<void>;
};

export type RunSingleTurnAgentResult = {
	threadId: string;
	rawOutput: string;
};

const defaultWriteContainerFile = async () => {
	throw new Error("writeContainerFile callback is required");
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
	const containerEnvPairs = [
		...getGlobalContainerEnvironmentPairs(),
		`VULSEEK_PROJECT_PROFILE_DIR=${projectProfileContextRoot}`,
		`VULSEEK_PROJECT_CACHE_DIR=${projectProfileCacheRoot}`,
	];
	const runtimeFileNames = input.runtimeFileNames || {
		jsonl: "sandbox-agent-event.jsonl",
		text: "sandbox-agent-text.txt",
		stderr: "app-server-stderr.log",
	};
	const containerNetworkArg = await resolveCurrentDockerNetworkArg();
	const containerEnvArgs = containerEnvPairs
		.map((pair) => {
			const escaped = pair.replace(/'/g, `"'"'`);
			return `-e '${escaped}'`;
		})
		.join(" ");

	const jsonlPath = path.join(input.runtimeDirHost, runtimeFileNames.jsonl);
	const textPath = path.join(input.runtimeDirHost, runtimeFileNames.text);
	const stderrPath = path.join(input.runtimeDirHost, runtimeFileNames.stderr);
	const runtimeArtifacts = createCodexRuntimeArtifacts({
		runtimeDir: input.runtimeDirHost,
		jsonlFileName: runtimeFileNames.jsonl,
		textFileName: runtimeFileNames.text,
		stderrFileName: runtimeFileNames.stderr,
	});

	return {
		imageTag,
		agentsDir,
		scanContextMount,
		containerNetworkArg,
		containerEnvArgs,
		jsonlPath,
		textPath,
		stderrPath,
		runtimeArtifacts,
	};
};

export const startContainer = async (input: StageContainerInput) => {
	const runtime = await resolveStageContainerRuntime(input);

	await initializeRuntimeFiles({
		runtimeDir: input.runtimeDirHost,
		jsonlPath: runtime.jsonlPath,
		textPath: runtime.textPath,
		stderrPath: runtime.stderrPath,
	});
	await initializeCodexRuntimeMetadataFiles({
		cursorPath: runtime.runtimeArtifacts.cursorPath,
		statePath: runtime.runtimeArtifacts.statePath,
	});

	await execAsync(
		`docker run -d --name ${input.containerName} ${runtime.containerNetworkArg} ${buildNamespaceEnabledContainerArgs()} ${runtime.scanContextMount.dockerMountArg} ${runtime.containerEnvArgs} ${runtime.imageTag} bash -lc "mkdir -p '${input.runtimeRootInContainer}' '${input.codexHome}/skills' && sleep infinity"`,
	);

	await initializeRuntimeFilesInContainer({
		containerName: input.containerName,
		runtimeDirInContainer: input.runtimeRootInContainer,
		jsonlFileName: runtime.runtimeArtifacts.jsonlFileName,
		textFileName: runtime.runtimeArtifacts.textFileName,
		stderrFileName: runtime.runtimeArtifacts.stderrFileName,
	});
	await initializeCodexRuntimeMetadataFilesInContainer({
		containerName: input.containerName,
		runtimeDirInContainer: input.runtimeRootInContainer,
		cursorFileName: runtime.runtimeArtifacts.cursorFileName,
		stateFileName: runtime.runtimeArtifacts.stateFileName,
		writeContainerFile,
	});
	await copyCodexAssetsToContainerHome(
		input.containerName,
		input.codexHome,
		runtime.agentsDir,
		input.agentProfile,
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

export const runSingleTurnAgentInContainer = async (
	input: RunSingleTurnAgentInput,
): Promise<RunSingleTurnAgentResult> => {
	const resolvedPrompt =
		typeof input.prompt === "string"
			? input.prompt
			: await input.prompt(input.containerName);
	const runtimeFileNames = input.runtimeFileNames || {
		jsonl: "sandbox-agent-event.jsonl",
		text: "sandbox-agent-text.txt",
		stderr: "app-server-stderr.log",
	};
	const jsonlPath = path.join(input.runtimeDirHost, runtimeFileNames.jsonl);
	const textPath = path.join(input.runtimeDirHost, runtimeFileNames.text);
	const stderrPath = path.join(input.runtimeDirHost, runtimeFileNames.stderr);
	const agentProvider = input.agentProfile?.provider || "codex";

	if (input.setupMarkdownPathInContainer && input.setupMarkdown) {
		await (writeContainerFile || defaultWriteContainerFile)(
			input.containerName,
			input.setupMarkdownPathInContainer,
			input.setupMarkdown,
		);
	}

	const sandboxRuntime = await prepareSandboxAgentRuntime({
		containerName: input.containerName,
		runtimeDirHost: input.runtimeDirHost,
		runtimeDirInContainer: input.runtimeRootInContainer,
		provider: input.agentProfile?.provider || "codex",
		homeDir: "/root",
		envPairs:
			agentProvider === "claude_code" && input.agentProfile
				? buildClaudeEnvPairs(input.agentProfile)
				: [`CODEX_HOME=${input.codexHome}`],
	});

	let sessionId = "";
	const result = await runSandboxAgentHeadlessTurnInContainer({
		baseUrl: sandboxRuntime.server.baseUrl,
		provider:
			input.agentProfile?.provider === "claude_code" ? "claude" : "codex",
		cwd: input.cwd,
		prompt: resolvedPrompt,
		model: input.agentProfile?.model || undefined,
		thinkingLevel: input.agentProfile?.thinkingLevel || undefined,
		jsonlPath,
		textPath,
		stderrPath,
		onSessionId: async (nextSessionId) => {
			sessionId = nextSessionId;
			await input.onThreadId?.(nextSessionId);
		},
	});

	return {
		threadId: result.sessionId || sessionId,
		rawOutput: result.rawOutput || "",
	};
};
