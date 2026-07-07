import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";

const sanitizeRoutePart = (value: string) =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9._-]/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "sandbox-agent";

const trimTrailingSlash = (value: string) => value.replace(/\/+$/g, "");

export const resolveSandboxAgentTraefikBaseOrigin = () => {
	const configured =
		process.env.SANDBOX_AGENT_PUBLIC_BASE_URL?.trim() ||
		process.env.BETTER_AUTH_URL?.trim() ||
		"";
	return configured ? trimTrailingSlash(configured) : "";
};

const TRAEFIK_DYNAMIC_DIR =
	process.env.VULSEEK_DEV_TRAEFIK_DYNAMIC_DIR?.trim() ||
	"/etc/traefik/dynamic";

const writeTraefikDynamicConfig = async (fileName: string, content: string) => {
	await mkdir(TRAEFIK_DYNAMIC_DIR, { recursive: true });
	await writeFile(path.join(TRAEFIK_DYNAMIC_DIR, fileName), content, "utf8");
};

export const ensureVulseekDevTraefikRootRoute = async () => {
	const config = {
		http: {
			routers: {
				"vulseek-dev-root": {
					rule: "PathPrefix(`/`)",
					service: "vulseek-dev-root-service",
					entryPoints: ["web"],
					priority: 1,
				},
			},
			services: {
				"vulseek-dev-root-service": {
					loadBalancer: {
						servers: [{ url: "http://vulseek-dev:3000" }],
						passHostHeader: true,
					},
				},
			},
		},
	};
	await writeTraefikDynamicConfig("vulseek-dev-root.yml", stringify(config));
};

export const configureSandboxAgentTraefikProxy = async (input: {
	routeId: string;
	targetHost: string;
	targetPort: number;
}) => {
	const routeId = sanitizeRoutePart(input.routeId);
	const routePath = `/sandbox-agent/${routeId}`;
	const routerName = `sandbox-agent-${routeId}`;
	const serviceName = `${routerName}-service`;
	const middlewareName = `${routerName}-strip-prefix`;
	const router = {
		rule: `PathPrefix(\`${routePath}\`)`,
		service: serviceName,
		entryPoints: ["web", "websecure"],
		middlewares: [middlewareName],
	};
	const config = {
		http: {
			routers: {
				[routerName]: router,
			},
			middlewares: {
				[middlewareName]: {
					stripPrefix: {
						prefixes: [routePath],
					},
				},
			},
			services: {
				[serviceName]: {
					loadBalancer: {
						servers: [
							{
								url: `http://${input.targetHost}:${input.targetPort}`,
							},
						],
						passHostHeader: true,
					},
				},
			},
		},
	};
	const fileName = `${routerName}.yml`;
	await writeTraefikDynamicConfig(fileName, stringify(config));

	const origin = resolveSandboxAgentTraefikBaseOrigin();
	return {
		routeId,
		routePath,
		configPath: `/etc/traefik/dynamic/${fileName}`,
		baseUrl: origin ? `${origin}${routePath}` : routePath,
	};
};
