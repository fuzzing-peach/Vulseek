import { promises as fs } from "node:fs";
import path from "node:path";
import { execAsync } from "../../utils/process/execAsync";
import { configureSandboxAgentTraefikProxy } from "../scan/runtime/sandbox-agent-traefik";
import {
	createSandboxAgentRuntimeArtifacts,
	initializeSandboxAgentRuntimeFiles,
	persistSandboxAgentRuntimeMetadata,
} from "./persistence";
import type {
	PrepareSandboxAgentRuntimeResult,
	SandboxAgentProvider,
	StartSandboxAgentServerInput,
} from "./types";

const DEFAULT_SANDBOX_AGENT_CONTAINER_PORT = 2468;
const DEFAULT_SANDBOX_AGENT_STARTUP_TIMEOUT_MS = 15000;

const escapeSingleQuotes = (value: string) => value.replace(/'/g, `'\\''`);

const buildShellExports = (pairs: string[]) =>
	pairs
		.map((pair) => {
			const index = pair.indexOf("=");
			const key = index === -1 ? pair : pair.slice(0, index);
			const value = index === -1 ? "" : pair.slice(index + 1);
			return `export ${key}='${escapeSingleQuotes(value)}'`;
		})
		.join("; ");

const coerceProvider = (provider: string): SandboxAgentProvider | null => {
	if (provider === "codex") {
		return "codex";
	}
	if (provider === "claude_code") {
		return "claude";
	}
	return null;
};

const inspectContainerIpAddress = async (containerName: string) => {
	const { stdout } = await execAsync(
		`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerName}`,
	);
	const value = stdout.trim();
	if (!value) {
		throw new Error(`Unable to resolve container IP for ${containerName}`);
	}
	return value;
};

const waitForSandboxAgentHealth = async (baseUrl: string) => {
	const deadline = Date.now() + DEFAULT_SANDBOX_AGENT_STARTUP_TIMEOUT_MS;
	let lastError = "";

	while (Date.now() < deadline) {
		for (const pathname of ["/health", "/v1/health"]) {
			try {
				const response = await fetch(`${baseUrl}${pathname}`);
				if (response.ok) {
					return;
				}
				lastError = `HTTP ${response.status} from ${pathname}`;
			} catch (error) {
				lastError =
					error instanceof Error
						? error.message
						: "Unknown health check failure";
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}

	throw new Error(
		`Timed out waiting for sandbox-agent health check (${lastError || "no response"})`,
	);
};

const startSandboxAgentServerInContainer = async (
	input: StartSandboxAgentServerInput,
) => {
	const artifacts = createSandboxAgentRuntimeArtifacts(input.stageDirPath);

	await initializeSandboxAgentRuntimeFiles(artifacts);

	const exportLines = buildShellExports([
		`HOME=${input.homeDir || "/root"}`,
		"SANDBOX_AGENT_REQUIRE_PREINSTALL=1",
		...(input.envPairs || []),
	]);

	const stagePidPath = path.posix.join(
		input.stageDirInContainer,
		artifacts.pidFileName,
	);
	const stageLogPath = path.posix.join(
		input.stageDirInContainer,
		artifacts.serverLogFileName,
	);

	await execAsync(
		`docker exec ${input.containerName} bash -lc "mkdir -p '${input.stageDirInContainer}' && if [ -s '${stagePidPath}' ]; then kill \\$(cat '${stagePidPath}') 2>/dev/null || true; fi && rm -f '${stagePidPath}'"`,
	);
	await execAsync(
		`docker exec ${input.containerName} bash -lc "pkill -f '[s]andbox-agent server --no-token --host 0.0.0.0 --port ${DEFAULT_SANDBOX_AGENT_CONTAINER_PORT}' 2>/dev/null || true"`,
	);
	await execAsync(
		`docker exec ${input.containerName} bash -lc ": > '${stageLogPath}' && ${exportLines}${exportLines ? "; " : ""}nohup sandbox-agent server --no-token --host 0.0.0.0 --port ${DEFAULT_SANDBOX_AGENT_CONTAINER_PORT} > '${stageLogPath}' 2>&1 < /dev/null & echo \\$! > '${stagePidPath}'"`,
	);

	const containerIp = await inspectContainerIpAddress(input.containerName);
	const baseUrl = `http://${containerIp}:${DEFAULT_SANDBOX_AGENT_CONTAINER_PORT}`;
	await waitForSandboxAgentHealth(baseUrl);
	const traefikProxy = await configureSandboxAgentTraefikProxy({
		routeId: input.containerName,
		targetHost: containerIp,
		targetPort: DEFAULT_SANDBOX_AGENT_CONTAINER_PORT,
	});

	return {
		artifacts,
		server: {
			baseUrl,
			publicBaseUrl: traefikProxy.baseUrl,
			host: containerIp,
			port: DEFAULT_SANDBOX_AGENT_CONTAINER_PORT,
		},
	};
};

export const stopSandboxAgentServerInContainer = async (input: {
	containerName: string;
}) => {
	const script = [
		`server_pattern='[s]andbox-agent server --no-token --host 0.0.0.0 --port ${DEFAULT_SANDBOX_AGENT_CONTAINER_PORT}'`,
		"agent_process_pattern='[a]gent_processes/'",
		"driver_pattern='[s]andbox-agent-driver\\.mjs'",
		"echo '[sandbox-agent-stop] before'",
		'pgrep -af "$server_pattern" || true',
		'pgrep -af "$agent_process_pattern" || true',
		'pgrep -af "$driver_pattern" || true',
		'pkill -TERM -f "$server_pattern" 2>/dev/null || true',
		'pkill -TERM -f "$agent_process_pattern" 2>/dev/null || true',
		'pkill -TERM -f "$driver_pattern" 2>/dev/null || true',
		"for i in {1..20}; do",
		'  if ! pgrep -f "$server_pattern" >/dev/null && ! pgrep -f "$agent_process_pattern" >/dev/null && ! pgrep -f "$driver_pattern" >/dev/null; then exit 0; fi',
		"  sleep 0.1",
		"done",
		'pkill -KILL -f "$server_pattern" 2>/dev/null || true',
		'pkill -KILL -f "$agent_process_pattern" 2>/dev/null || true',
		'pkill -KILL -f "$driver_pattern" 2>/dev/null || true',
		"echo '[sandbox-agent-stop] after'",
		'pgrep -af "$server_pattern" || true',
		'pgrep -af "$agent_process_pattern" || true',
		'pgrep -af "$driver_pattern" || true',
	].join("\n");
	try {
		const { stdout, stderr } = await execAsync(
			`docker exec ${input.containerName} bash -lc '${escapeSingleQuotes(script)}'`,
		);
		if (stdout.trim() || stderr.trim()) {
			console.log(
				`[sandbox-agent-stop] container=${input.containerName}\n${stdout}${stderr}`,
			);
		}
	} catch (error) {
		console.warn(
			`[sandbox-agent-stop] failed container=${input.containerName}: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
};

export const prepareSandboxAgentRuntime = async (input: {
	containerName: string;
	stageDirPath: string;
	stageDirInContainer: string;
	provider: string;
	envPairs?: string[];
	homeDir?: string;
	reuseExisting?: boolean;
}): Promise<PrepareSandboxAgentRuntimeResult> => {
	const normalizedProvider = coerceProvider(input.provider);
	if (!normalizedProvider) {
		throw new Error(
			`sandbox-agent does not support provider '${input.provider}'`,
		);
	}

	if (input.reuseExisting) {
		const artifacts = createSandboxAgentRuntimeArtifacts(input.stageDirPath);
		try {
			const metadata = JSON.parse(
				await fs.readFile(artifacts.metadataPath, "utf-8"),
			) as PrepareSandboxAgentRuntimeResult & { runtime?: string };
			if (metadata.server?.baseUrl) {
				await waitForSandboxAgentHealth(metadata.server.baseUrl);
				return {
					artifacts,
					server: metadata.server,
				};
			}
		} catch {}
	}

	const result = await startSandboxAgentServerInContainer({
		containerName: input.containerName,
		stageDirPath: input.stageDirPath,
		stageDirInContainer: input.stageDirInContainer,
		envPairs: input.envPairs,
		homeDir: input.homeDir,
	});

	await persistSandboxAgentRuntimeMetadata({
		artifacts: result.artifacts,
		server: result.server,
		provider: normalizedProvider,
	});

	return result;
};
