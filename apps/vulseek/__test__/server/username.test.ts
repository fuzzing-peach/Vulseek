import {
	createAvailableUsername,
	normalizeUsername,
	usernameSchema,
} from "@vulseek/server/lib/username";
import { describe, expect, it } from "vitest";

describe("username", () => {
	it("normalizes usernames to lowercase", () => {
		expect(normalizeUsername(" Alice.Dev ")).toBe("alice.dev");
	});

	it("accepts only 3-30 letters, digits, underscores, dots, and hyphens", () => {
		expect(usernameSchema.safeParse("alice_01.dev").success).toBe(true);
		expect(usernameSchema.safeParse("alice-user").success).toBe(true);
		expect(usernameSchema.safeParse("ab").success).toBe(false);
		expect(usernameSchema.safeParse("alice+user").success).toBe(false);
		expect(usernameSchema.safeParse("用户").success).toBe(false);
	});

	it("derives a valid username from an email address", async () => {
		await expect(
			createAvailableUsername("A-li+ce@example.com", async () => false),
		).resolves.toBe("a-lice");
	});

	it("uses a stable fallback for short or empty email prefixes", async () => {
		await expect(
			createAvailableUsername("a@example.com", async () => false),
		).resolves.toBe("user_a");
		await expect(
			createAvailableUsername("+++@example.com", async () => false),
		).resolves.toBe("user");
	});

	it("adds a numeric suffix when a generated username is taken", async () => {
		const taken = new Set(["alice", "alice1", "alice2"]);
		await expect(
			createAvailableUsername("alice@example.com", async (value) =>
				taken.has(value),
			),
		).resolves.toBe("alice3");
	});

	it("keeps generated usernames within 30 characters", async () => {
		const prefix = "abcdefghijklmnopqrstuvwxyz123456789";
		await expect(
			createAvailableUsername(
				`${prefix}@example.com`,
				async (value) => value === prefix.slice(0, 30),
			),
		).resolves.toBe(`${prefix.slice(0, 29)}1`);
	});
});
