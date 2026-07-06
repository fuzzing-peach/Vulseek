import { readdirSync } from "node:fs";
import { join } from "node:path";
import { docker } from "@dokploy/server/constants";
import {
	execAsync,
	execAsyncRemote,
} from "@dokploy/server/utils/process/execAsync";
import { type Dispatcher, ProxyAgent, fetch as undiciFetch } from "undici";
import {
	initializeStandaloneTraefik,
	initializeTraefikService,
	type TraefikOptions,
} from "../setup/traefik-setup";
import { findAdmin } from "./admin";
import { updateUser } from "./user";

export interface IUpdateData {
	latestVersion: string | null;
	updateAvailable: boolean;
}

export const DEFAULT_UPDATE_DATA: IUpdateData = {
	latestVersion: null,
	updateAvailable: false,
};

const DEFAULT_DOKPLOY_IMAGE_REPOSITORY = "ghcr.io/fuzzing-peach/vulseek";

/** Returns current Dokploy docker image tag or `latest` by default. */
export const getDokployImageTag = () => {
	return process.env.RELEASE_TAG || "latest";
};

export const getDokployImageRepository = () => {
	return process.env.DOKPLOY_IMAGE_REPOSITORY || DEFAULT_DOKPLOY_IMAGE_REPOSITORY;
};

export const getDokployImage = () => {
	return `${getDokployImageRepository()}:${getDokployImageTag()}`;
};

export const getDokployServiceName = () => {
	return process.env.DOKPLOY_SERVICE_NAME || "dokploy";
};

let proxyAgentCache: { proxyUrl: string; agent: Dispatcher } | null = null;

type RegistryRequestInit = {
	method?: string;
	headers?: HeadersInit;
};

const getProxyUrl = () =>
	process.env.HTTPS_PROXY ||
	process.env.https_proxy ||
	process.env.HTTP_PROXY ||
	process.env.http_proxy ||
	process.env.ALL_PROXY ||
	process.env.all_proxy;

const fetchRegistry = (url: string, init?: RegistryRequestInit) => {
	const proxyUrl = getProxyUrl();
	const requestInit = {
		method: "GET",
		headers: { "Content-Type": "application/json" },
		...init,
	};

	if (!proxyUrl) {
		return fetch(url, requestInit);
	}

	if (proxyAgentCache?.proxyUrl !== proxyUrl) {
		proxyAgentCache = { proxyUrl, agent: new ProxyAgent(proxyUrl) };
	}

	return undiciFetch(url, {
		...requestInit,
		dispatcher: proxyAgentCache.agent,
	});
};

const parseBearerChallenge = (challenge: string | null) => {
	if (!challenge?.startsWith("Bearer ")) {
		return null;
	}

	const values = new Map<string, string>();
	for (const part of challenge.slice("Bearer ".length).split(",")) {
		const [key, rawValue] = part.trim().split("=");
		if (key && rawValue) {
			values.set(key, rawValue.replace(/^"|"$/g, ""));
		}
	}

	const realm = values.get("realm");
	if (!realm) {
		return null;
	}

	return {
		realm,
		scope: values.get("scope"),
		service: values.get("service"),
	};
};

const fetchRegistryWithBearerAuth = async (
	url: string,
	init?: RegistryRequestInit,
) => {
	const response = await fetchRegistry(url, init);
	if (response.status !== 401) {
		return response;
	}

	const challenge = parseBearerChallenge(response.headers.get("www-authenticate"));
	if (!challenge) {
		return response;
	}

	const tokenUrl = new URL(challenge.realm);
	if (challenge.service) {
		tokenUrl.searchParams.set("service", challenge.service);
	}
	if (challenge.scope) {
		tokenUrl.searchParams.set("scope", challenge.scope);
	}

	const tokenResponse = await fetchRegistry(tokenUrl.toString());
	if (!tokenResponse.ok) {
		return response;
	}

	const tokenData = (await tokenResponse.json()) as {
		token?: string;
		access_token?: string;
	};
	const token = tokenData.token || tokenData.access_token;
	if (!token) {
		return response;
	}

	const headers = new Headers(init?.headers);
	headers.set("Authorization", `Bearer ${token}`);

	return fetchRegistry(url, {
		...init,
		headers,
	});
};

const getRegistryRepositoryPath = () => {
	const repository = getDokployImageRepository();
	return repository.replace(/^ghcr\.io\//, "");
};

const getRemoteImageDigest = async (tag: string) => {
	const repositoryPath = getRegistryRepositoryPath();
	const manifestUrl = `https://ghcr.io/v2/${repositoryPath}/manifests/${tag}`;
	const response = await fetchRegistryWithBearerAuth(manifestUrl, {
		method: "HEAD",
		headers: {
			Accept: [
				"application/vnd.docker.distribution.manifest.v2+json",
				"application/vnd.docker.distribution.manifest.list.v2+json",
				"application/vnd.oci.image.manifest.v1+json",
				"application/vnd.oci.image.index.v1+json",
			].join(", "),
		},
	});

	if (!response.ok) {
		return null;
	}

	return response.headers.get("docker-content-digest");
};

export const pullLatestRelease = async () => {
	const stream = await docker.pull(getDokployImage());
	await new Promise((resolve, reject) => {
		docker.modem.followProgress(stream, (err, res) =>
			err ? reject(err) : resolve(res),
		);
	});
};

/** Returns Dokploy docker service image digest */
export const getServiceImageDigest = async () => {
	const { stdout } = await execAsync(
		`docker service inspect ${getDokployServiceName()} --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'`,
	);

	const currentDigest = stdout.trim().split("@")[1];

	if (!currentDigest) {
		throw new Error("Could not get current service image digest");
	}

	return currentDigest;
};

/** Returns latest version number and information whether server update is available by comparing current image's digest against the GHCR manifest digest. */
export const getUpdateData = async (): Promise<IUpdateData> => {
	let currentDigest: string;
	try {
		currentDigest = await getServiceImageDigest();
	} catch {
		// Docker service might not exist locally
		// You can run the # Installation command for docker service create mentioned in the below docs to test it locally:
		// https://docs.dokploy.com/docs/core/manual-installation
		return DEFAULT_UPDATE_DATA;
	}

	const imageTag = getDokployImageTag();
	const remoteDigest = await getRemoteImageDigest(imageTag);
	if (!remoteDigest) {
		return DEFAULT_UPDATE_DATA;
	}

	const updateAvailable = remoteDigest !== currentDigest;
	return { latestVersion: imageTag, updateAvailable };
};

interface TreeDataItem {
	id: string;
	name: string;
	type: "file" | "directory";
	children?: TreeDataItem[];
}

export const readDirectory = async (
	dirPath: string,
	serverId?: string,
): Promise<TreeDataItem[]> => {
	if (serverId) {
		const { stdout } = await execAsyncRemote(
			serverId,
			`
process_items() {
    local parent_dir="$1"
    local __resultvar=$2

    local items_json=""
    local first=true
    for item in "$parent_dir"/*; do
        [ -e "$item" ] || continue
        process_item "$item" item_json
        if [ "$first" = true ]; then
            first=false
            items_json="$item_json"
        else
            items_json="$items_json,$item_json"
        fi
    done

    eval $__resultvar="'[$items_json]'"
}

process_item() {
    local item_path="$1"
    local __resultvar=$2

    local item_name=$(basename "$item_path")
    local escaped_name=$(echo "$item_name" | sed 's/"/\\"/g')
    local escaped_path=$(echo "$item_path" | sed 's/"/\\"/g')

    if [ -d "$item_path" ]; then
        # Is directory
        process_items "$item_path" children_json
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"directory","children":'"$children_json"'}'
    else
        # Is file
        local json='{"id":"'"$escaped_path"'","name":"'"$escaped_name"'","type":"file"}'
    fi

    eval $__resultvar="'$json'"
}

root_dir=${dirPath}

process_items "$root_dir" json_output

echo "$json_output"
			`,
		);
		const result = JSON.parse(stdout);
		return result;
	}

	const stack = [dirPath];
	const result: TreeDataItem[] = [];
	const parentMap: Record<string, TreeDataItem[]> = {};

	while (stack.length > 0) {
		const currentPath = stack.pop();
		if (!currentPath) continue;

		const items = readdirSync(currentPath, { withFileTypes: true });
		const currentDirectoryResult: TreeDataItem[] = [];

		for (const item of items) {
			const fullPath = join(currentPath, item.name);
			if (item.isDirectory()) {
				stack.push(fullPath);
				const directoryItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "directory",
					children: [],
				};
				currentDirectoryResult.push(directoryItem);
				parentMap[fullPath] = directoryItem.children as TreeDataItem[];
			} else {
				const fileItem: TreeDataItem = {
					id: fullPath,
					name: item.name,
					type: "file",
				};
				currentDirectoryResult.push(fileItem);
			}
		}

		if (parentMap[currentPath]) {
			parentMap[currentPath].push(...currentDirectoryResult);
		} else {
			result.push(...currentDirectoryResult);
		}
	}
	return result;
};

export const cleanupFullDocker = async (serverId?: string | null) => {
	const cleanupImages = "docker image prune --force";
	const cleanupVolumes = "docker volume prune --force";
	const cleanupContainers = "docker container prune --force";
	const cleanupSystem = "docker system prune  --force --volumes";
	const cleanupBuilder = "docker builder prune  --force";

	try {
		if (serverId) {
			await execAsyncRemote(
				serverId,
				`
	${cleanupImages}
	${cleanupVolumes}
	${cleanupContainers}
	${cleanupSystem}
	${cleanupBuilder}
			`,
			);
		}
		await execAsync(`
			${cleanupImages}
			${cleanupVolumes}
			${cleanupContainers}
			${cleanupSystem}
			${cleanupBuilder}
					`);
	} catch (error) {
		console.log(error);
	}
};

export const resolveDockerResourceName = async (
	resourceNames: string[],
	serverId?: string,
) => {
	for (const resourceName of resourceNames) {
		const resourceType = await getDockerResourceType(resourceName, serverId);
		if (resourceType !== "unknown") {
			return resourceName;
		}
	}

	throw new Error("Resource type not found");
};

export const getTraefikResourceName = async (serverId?: string) =>
	await resolveDockerResourceName(
		["dokploy-traefik", "dokploy-traefik-dev"],
		serverId,
	);

export const getDockerResourceType = async (
	resourceName: string,
	serverId?: string,
) => {
	try {
		let result = "";
		const command = `
RESOURCE_NAME="${resourceName}"
if docker service inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "service"
elif docker inspect "$RESOURCE_NAME" >/dev/null 2>&1; then
	echo "standalone"
else
	echo "unknown"
fi`;

		if (serverId) {
			const { stdout } = await execAsyncRemote(serverId, command);
			result = stdout.trim();
		} else {
			const { stdout } = await execAsync(command);
			result = stdout.trim();
		}
		if (result === "service") {
			return "service";
		}
		if (result === "standalone") {
			return "standalone";
		}
		return "unknown";
	} catch (error) {
		console.error(error);
		return "unknown";
	}
};

export const getContainerEnvironmentSetting = async () => {
	try {
		const admin = await findAdmin();
		return admin.user.containerEnvironment || "";
	} catch {
		return "";
	}
};

export const updateContainerEnvironmentSetting = async (
	containerEnvironment: string,
) => {
	const admin = await findAdmin();
	await updateUser(admin.user.id, {
		containerEnvironment,
	});
	process.env.DOKPLOY_CONTAINER_ENV = containerEnvironment;
	return true;
};

export const syncContainerEnvironmentSettingToProcess = async () => {
	const value = await getContainerEnvironmentSetting();
	process.env.DOKPLOY_CONTAINER_ENV = value;
	return value;
};

export const getScanJobConcurrencySetting = async () => {
	try {
		const admin = await findAdmin();
		return Math.max(1, admin.user.scanJobConcurrency ?? 1);
	} catch {
		return 1;
	}
};

export const updateScanJobConcurrencySetting = async (
	scanJobConcurrency: number,
) => {
	const admin = await findAdmin();
	await updateUser(admin.user.id, {
		scanJobConcurrency: Math.max(1, scanJobConcurrency),
	});
	return true;
};

export const reloadDockerResource = async (
	resourceName: string,
	serverId?: string,
) => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service update --force ${resourceName}`;
	} else if (resourceType === "standalone") {
		command = `docker restart ${resourceName}`;
	} else {
		throw new Error("Resource type not found");
	}
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};

export const readEnvironmentVariables = async (
	resourceName: string,
	serverId?: string,
) => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.TaskTemplate.ContainerSpec.Env}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .Config.Env}}'`;
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}
	if (result === "null") {
		return "";
	}
	return JSON.parse(result)?.join("\n");
};

export const readPorts = async (
	resourceName: string,
	serverId?: string,
): Promise<
	{ targetPort: number; publishedPort: number; protocol?: string }[]
> => {
	const resourceType = await getDockerResourceType(resourceName, serverId);
	let command = "";
	if (resourceType === "service") {
		command = `docker service inspect ${resourceName} --format '{{json .Spec.EndpointSpec.Ports}}'`;
	} else if (resourceType === "standalone") {
		command = `docker container inspect ${resourceName} --format '{{json .NetworkSettings.Ports}}'`;
	} else {
		throw new Error("Resource type not found");
	}
	let result = "";
	if (serverId) {
		const { stdout } = await execAsyncRemote(serverId, command);
		result = stdout.trim();
	} else {
		const { stdout } = await execAsync(command);
		result = stdout.trim();
	}

	if (result === "null") {
		return [];
	}

	const parsedResult = JSON.parse(result);

	if (resourceType === "service") {
		return parsedResult
			.map((port: any) => ({
				targetPort: port.TargetPort,
				publishedPort: port.PublishedPort,
				protocol: port.Protocol,
			}))
			.filter((port: any) => port.targetPort !== 80 && port.targetPort !== 443);
	}
	const ports: {
		targetPort: number;
		publishedPort: number;
		protocol?: string;
	}[] = [];
	for (const key in parsedResult) {
		if (Object.hasOwn(parsedResult, key)) {
			const containerPortMapppings = parsedResult[key];
			const protocol = key.split("/")[1];
			const targetPort = Number.parseInt(key.split("/")[0] ?? "0", 10);

			containerPortMapppings.forEach((mapping: any) => {
				ports.push({
					targetPort: targetPort,
					publishedPort: Number.parseInt(mapping.HostPort, 10),
					protocol: protocol,
				});
			});
		}
	}
	return ports.filter(
		(port: any) => port.targetPort !== 80 && port.targetPort !== 443,
	);
};

export const writeTraefikSetup = async (input: TraefikOptions) => {
	const traefikResourceName = await getTraefikResourceName(input.serverId);
	const resourceType = await getDockerResourceType(
		traefikResourceName,
		input.serverId,
	);

	if (resourceType === "service") {
		await initializeTraefikService({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});
	} else if (resourceType === "standalone") {
		await initializeStandaloneTraefik({
			env: input.env,
			additionalPorts: input.additionalPorts,
			serverId: input.serverId,
		});
	} else {
		throw new Error("Traefik resource type not found");
	}
};
