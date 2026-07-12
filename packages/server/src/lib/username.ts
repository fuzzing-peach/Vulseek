import { z } from "zod";

export const usernameSchema = z
	.string()
	.trim()
	.min(3, "Username must be at least 3 characters")
	.max(30, "Username must be at most 30 characters")
	.regex(
		/^[a-zA-Z0-9_.-]+$/,
		"Username may only contain letters, numbers, underscores, dots, and hyphens",
	);

export const loginIdentifierSchema = z.object({
	identifier: z.string().trim().min(1, "Email or username is required"),
	password: z.string().min(8),
});

export const normalizeUsername = (username: string) =>
	username.trim().toLowerCase();

const usernameFromEmail = (email: string) => {
	const localPart = email.split("@", 1)[0]?.toLowerCase() || "";
	const cleaned = localPart.replace(/[^a-z0-9_.-]/g, "").slice(0, 30);
	if (cleaned.length >= 3) return cleaned;
	if (cleaned.length > 0) return `user_${cleaned}`;
	return "user";
};

export const createAvailableUsername = async (
	email: string,
	isTaken: (username: string) => Promise<boolean>,
) => {
	const base = usernameFromEmail(email);
	if (!(await isTaken(base))) return base;

	for (let suffix = 1; ; suffix += 1) {
		const suffixText = String(suffix);
		const candidate = `${base.slice(0, 30 - suffixText.length)}${suffixText}`;
		if (!(await isTaken(candidate))) return candidate;
	}
};
