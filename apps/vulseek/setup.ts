import { exit } from "node:process";
import { execAsync } from "@vulseek/server";
import { setupDirectories } from "@vulseek/server/setup/config-paths";
import { initializePostgres } from "@vulseek/server/setup/postgres-setup";
import { initializeRedis } from "@vulseek/server/setup/redis-setup";
import {
	initializeNetwork,
	initializeSwarm,
} from "@vulseek/server/setup/setup";
import {
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	initializeStandaloneTraefik,
} from "@vulseek/server/setup/traefik-setup";

(async () => {
	try {
		setupDirectories();
		createDefaultMiddlewares();
		await initializeSwarm();
		await initializeNetwork();
		createDefaultTraefikConfig();
		createDefaultServerTraefikConfig();
		await execAsync("docker pull traefik:v3.5.0");
		await initializeStandaloneTraefik();
		await initializeRedis();
		await initializePostgres();
		console.log("Vulseek setup completed");
		exit(0);
	} catch (e) {
		console.error("Error in vulseek setup", e);
	}
})();
