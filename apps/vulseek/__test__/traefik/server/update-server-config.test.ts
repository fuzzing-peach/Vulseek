import { fs, vol } from "memfs";

vi.mock("node:fs", () => ({
	...fs,
	default: fs,
}));

import type { User } from "@vulseek/server/services/user";
import { createDefaultServerTraefikConfig } from "@vulseek/server/setup/traefik-setup";
import { loadOrCreateConfig } from "@vulseek/server/utils/traefik/application";
import type { FileConfig } from "@vulseek/server/utils/traefik/file-types";
import { updateServerTraefik } from "@vulseek/server/utils/traefik/web-server";
import { beforeEach, expect, test, vi } from "vitest";

const baseAdmin: User = {
	https: false,
	enablePaidFeatures: false,
	allowImpersonation: false,
	role: "user",
	metricsConfig: {
		containers: {
			refreshRate: 20,
			services: {
				include: [],
				exclude: [],
			},
		},
		server: {
			type: "Vulseek",
			cronJob: "",
			port: 4500,
			refreshRate: 20,
			retentionDays: 2,
			token: "",
			thresholds: {
				cpu: 0,
				memory: 0,
			},
			urlCallback: "",
		},
	},
	cleanupCacheApplications: false,
	cleanupCacheOnCompose: false,
	cleanupCacheOnPreviews: false,
	createdAt: new Date(),
	serverIp: null,
	certificateType: "none",
	host: null,
	letsEncryptEmail: null,
	sshPrivateKey: null,
	enableDockerCleanup: false,
	logCleanupCron: null,
	serversQuantity: 0,
	stripeCustomerId: "",
	stripeSubscriptionId: "",
	banExpires: new Date(),
	banned: true,
	banReason: "",
	email: "",
	expirationDate: "",
	id: "",
	isRegistered: false,
	name: "",
	createdAt2: new Date().toISOString(),
	emailVerified: false,
	image: "",
	updatedAt: new Date(),
	twoFactorEnabled: false,
	containerEnvironment: "",
	scanContextHostPath: "",
	scanJobConcurrency: 1,
};

beforeEach(() => {
	vol.reset();
	createDefaultServerTraefikConfig();
});

test("Should read the configuration file", () => {
	const config: FileConfig = loadOrCreateConfig("vulseek");
	expect(config.http?.routers?.["vulseek-router-app"]?.service).toBe(
		"vulseek-service-app",
	);
});

test("Should apply redirect-to-https", () => {
	updateServerTraefik(
		{
			...baseAdmin,
			https: true,
			certificateType: "letsencrypt",
		},
		"example.com",
	);

	const config: FileConfig = loadOrCreateConfig("vulseek");

	expect(config.http?.routers?.["vulseek-router-app"]?.middlewares).toContain(
		"redirect-to-https",
	);
});

test("Should change only host when no certificate", () => {
	updateServerTraefik(baseAdmin, "example.com");

	const config: FileConfig = loadOrCreateConfig("vulseek");

	expect(config.http?.routers?.["vulseek-router-app-secure"]).toBeUndefined();
});

test("Should not touch config without host", () => {
	const originalConfig: FileConfig = loadOrCreateConfig("vulseek");

	updateServerTraefik(baseAdmin, null);

	const config: FileConfig = loadOrCreateConfig("vulseek");

	expect(originalConfig).toEqual(config);
});

test("Should remove websecure if https rollback to http", () => {
	updateServerTraefik(
		{ ...baseAdmin, certificateType: "letsencrypt" },
		"example.com",
	);

	updateServerTraefik({ ...baseAdmin, certificateType: "none" }, "example.com");

	const config: FileConfig = loadOrCreateConfig("vulseek");

	expect(config.http?.routers?.["vulseek-router-app-secure"]).toBeUndefined();
	expect(
		config.http?.routers?.["vulseek-router-app"]?.middlewares,
	).not.toContain("redirect-to-https");
});
