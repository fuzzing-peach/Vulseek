import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["__test__/**/*.test.{ts,tsx}"],
		exclude: ["**/node_modules/**", "**/dist/**", "**/.docker/**"],
		pool: "forks",
		// Component tests render with @testing-library/react in jsdom;
		// plain Node tests keep the default node environment.
		environmentMatchGlobs: [["**/*.test.tsx", "jsdom"]],
		setupFiles: ["__test__/react/setup.ts"],
	},
	define: {
		"process.env": {
			NODE: "test",
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, ".."),
			"@vulseek/server": path.resolve(
				__dirname,
				"../../../packages/server/src",
			),
		},
	},
});
