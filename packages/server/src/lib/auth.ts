import type { IncomingMessage } from "node:http";
import * as bcrypt from "bcrypt";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError } from "better-auth/api";
import { admin, apiKey, organization, twoFactor } from "better-auth/plugins";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { IS_CLOUD } from "../constants";
import { db } from "../db";
import * as schema from "../db/schema";
import { getUserByToken } from "../services/admin";
import { updateUser } from "../services/user";
import { getHubSpotUTK, submitToHubSpot } from "../utils/tracking/hubspot";
import { sendEmail } from "../verification/send-verification-email";
import { getPublicIpWithFallback } from "../wss/utils";
import {
	createAvailableUsername,
	loginIdentifierSchema,
	normalizeUsername,
	usernameSchema,
} from "./username";

const { handler, api } = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		schema: schema,
	}),
	appName: "Vulseek",
	socialProviders: {
		github: {
			clientId: process.env.GITHUB_CLIENT_ID as string,
			clientSecret: process.env.GITHUB_CLIENT_SECRET as string,
		},
		google: {
			clientId: process.env.GOOGLE_CLIENT_ID as string,
			clientSecret: process.env.GOOGLE_CLIENT_SECRET as string,
		},
	},
	logger: {
		disabled: process.env.NODE_ENV === "production",
	},
	...(!IS_CLOUD && {
		async trustedOrigins() {
			const admin = await db.query.member.findFirst({
				where: eq(schema.member.role, "owner"),
				with: {
					user: true,
				},
			});

			if (admin) {
				return [
					...(admin.user.serverIp
						? [`http://${admin.user.serverIp}:3000`]
						: []),
					...(admin.user.serverIp && process.env.NODE_ENV !== "production"
						? [`http://${admin.user.serverIp}:23000`]
						: []),
					...(admin.user.host ? [`https://${admin.user.host}`] : []),
				];
			}
			return [];
		},
	}),
	emailVerification: {
		sendOnSignUp: true,
		autoSignInAfterVerification: true,
		sendVerificationEmail: async ({ user, url }) => {
			if (IS_CLOUD) {
				await sendEmail({
					email: user.email,
					subject: "Verify your email",
					text: `
				<p>Click the link to verify your email: <a href="${url}">Verify Email</a></p>
				`,
				});
			}
		},
	},
	emailAndPassword: {
		enabled: true,
		autoSignIn: !IS_CLOUD,
		requireEmailVerification: IS_CLOUD,
		password: {
			async hash(password) {
				return bcrypt.hashSync(password, 10);
			},
			async verify({ hash, password }) {
				return bcrypt.compareSync(password, hash);
			},
		},
		sendResetPassword: async ({ user, url }) => {
			await sendEmail({
				email: user.email,
				subject: "Reset your password",
				text: `
				<p>Click the link to reset your password: <a href="${url}">Reset Password</a></p>
				`,
			});
		},
	},
	databaseHooks: {
		user: {
			create: {
				before: async (_user, context) => {
					if (!IS_CLOUD) {
						const xVulseekToken =
							context?.request?.headers?.get("x-vulseek-token");
						if (xVulseekToken) {
							const user = await getUserByToken(xVulseekToken);
							if (!user) {
								throw new APIError("BAD_REQUEST", {
									message: "User not found",
								});
							}
						} else {
							const isAdminPresent = await db.query.member.findFirst({
								where: eq(schema.member.role, "owner"),
							});
							if (isAdminPresent) {
								throw new APIError("BAD_REQUEST", {
									message: "Admin is already created",
								});
							}
						}
					}

					const requestedUsername = (
						_user as typeof _user & { username?: unknown }
					).username;
					const username = requestedUsername
						? normalizeUsername(String(requestedUsername))
						: await createAvailableUsername(_user.email, async (candidate) => {
								const existingUser = await db.query.users_temp.findFirst({
									where: eq(schema.users_temp.username, candidate),
									columns: { id: true },
								});
								return Boolean(existingUser);
							});

					const parsedUsername = usernameSchema.safeParse(username);
					if (!parsedUsername.success) {
						throw new APIError("BAD_REQUEST", {
							message: parsedUsername.error.issues[0]?.message,
						});
					}
					if (requestedUsername) {
						const existingUser = await db.query.users_temp.findFirst({
							where: eq(
								schema.users_temp.username,
								parsedUsername.data.toLowerCase(),
							),
							columns: { id: true },
						});
						if (existingUser) {
							throw new APIError("BAD_REQUEST", {
								message: "Username is already taken",
							});
						}
					}

					return {
						data: {
							..._user,
							username: parsedUsername.data.toLowerCase(),
						},
					};
				},
				after: async (user, context) => {
					const isAdminPresent = await db.query.member.findFirst({
						where: eq(schema.member.role, "owner"),
					});

					if (!IS_CLOUD) {
						await updateUser(user.id, {
							serverIp: await getPublicIpWithFallback(),
						});
					}

					if (IS_CLOUD) {
						try {
							const hutk = getHubSpotUTK(
								context?.request?.headers?.get("cookie") || undefined,
							);
							const hubspotSuccess = await submitToHubSpot(
								{
									email: user.email,
									firstName: user.name,
									lastName: user.name,
								},
								hutk,
							);
							if (!hubspotSuccess) {
								console.error("Failed to submit to HubSpot");
							}
						} catch (error) {
							console.error("Error submitting to HubSpot", error);
						}
					}

					if (IS_CLOUD || !isAdminPresent) {
						await db.transaction(async (tx) => {
							const organization = await tx
								.insert(schema.organization)
								.values({
									name: "My Organization",
									ownerId: user.id,
									createdAt: new Date(),
								})
								.returning()
								.then((res) => res[0]);

							await tx.insert(schema.member).values({
								userId: user.id,
								organizationId: organization?.id || "",
								role: "owner",
								createdAt: new Date(),
								isDefault: true, // Mark first organization as default
							});
						});
					}
				},
			},
		},
		session: {
			create: {
				before: async (session) => {
					// Find the default organization for this user
					// Priority: 1) isDefault=true, 2) most recently created
					const member = await db.query.member.findFirst({
						where: eq(schema.member.userId, session.userId),
						orderBy: [
							desc(schema.member.isDefault),
							desc(schema.member.createdAt),
						],
						with: {
							organization: true,
						},
					});

					return {
						data: {
							...session,
							activeOrganizationId: member?.organization.id,
						},
					};
				},
			},
		},
	},
	session: {
		expiresIn: 60 * 60 * 24 * 3,
		updateAge: 60 * 60 * 24,
	},
	user: {
		modelName: "users_temp",
		additionalFields: {
			username: {
				type: "string",
				required: false,
			},
			role: {
				type: "string",
				// required: true,
				input: false,
			},
			ownerId: {
				type: "string",
				// required: true,
				input: false,
			},
			allowImpersonation: {
				fieldName: "allowImpersonation",
				type: "boolean",
				defaultValue: false,
			},
		},
	},
	plugins: [
		apiKey({
			enableMetadata: true,
		}),
		twoFactor(),
		organization({
			async sendInvitationEmail(data, _request) {
				if (IS_CLOUD) {
					const host =
						process.env.NODE_ENV === "development"
							? "http://localhost:3000"
							: "https://app.vulseek.com";
					const inviteLink = `${host}/invitation?token=${data.id}`;

					await sendEmail({
						email: data.email,
						subject: "Invitation to join organization",
						text: `
					<p>You are invited to join ${data.organization.name} on Vulseek. Click the link to accept the invitation: <a href="${inviteLink}">Accept Invitation</a></p>
					`,
					});
				}
			},
		}),
		...(IS_CLOUD
			? [
					admin({
						adminUserIds: [process.env.USER_ADMIN_ID as string],
					}),
				]
			: []),
	],
});

const signInWithIdentifier = async (request: Request) => {
	try {
		const input = loginIdentifierSchema.parse(await request.json());
		const identifier = input.identifier.toLowerCase();
		const user = await db.query.users_temp.findFirst({
			where: or(
				eq(sql`lower(${schema.users_temp.email})`, identifier),
				eq(schema.users_temp.username, identifier),
			),
			columns: { email: true },
		});

		if (!user) {
			return Response.json(
				{ message: "Invalid email, username, or password" },
				{ status: 401 },
			);
		}

		const response = await api.signInEmail({
			body: { email: user.email, password: input.password },
			headers: request.headers,
			asResponse: true,
		});
		if (response.status === 401) {
			return Response.json(
				{ message: "Invalid email, username, or password" },
				{ status: 401, headers: response.headers },
			);
		}
		return response;
	} catch (error) {
		if (error instanceof z.ZodError) {
			return Response.json(
				{ message: "Invalid login request" },
				{ status: 400 },
			);
		}
		throw error;
	}
};

export const auth = {
	handler,
	signInWithIdentifier,
	createApiKey: api.createApiKey,
};

export const validateRequest = async (request: IncomingMessage) => {
	if (
		process.env.NODE_ENV === "development" &&
		process.env.VULSEEK_DEV_AUTH_BYPASS === "1"
	) {
		const member = await db.query.member.findFirst({
			where: eq(schema.member.role, "owner"),
			orderBy: [desc(schema.member.isDefault), desc(schema.member.createdAt)],
			with: {
				user: true,
				organization: true,
			},
		});

		if (member?.user && member.organization) {
			return {
				session: {
					userId: member.user.id,
					activeOrganizationId: member.organization.id,
				},
				user: {
					id: member.user.id,
					name: member.user.name,
					email: member.user.email,
					emailVerified: member.user.emailVerified,
					image: member.user.image,
					createdAt: member.user.createdAt,
					updatedAt: member.user.updatedAt,
					twoFactorEnabled: member.user.twoFactorEnabled,
					role: member.role,
					ownerId: member.organization.ownerId,
				},
			};
		}
	}

	const apiKey = request.headers["x-api-key"] as string;
	if (apiKey) {
		try {
			const { valid, key, error } = await api.verifyApiKey({
				body: {
					key: apiKey,
				},
			});

			if (error) {
				throw new Error(error.message || "Error verifying API key");
			}
			if (!valid || !key) {
				return {
					session: null,
					user: null,
				};
			}

			const apiKeyRecord = await db.query.apikey.findFirst({
				where: eq(schema.apikey.id, key.id),
				with: {
					user: true,
				},
			});

			if (!apiKeyRecord) {
				return {
					session: null,
					user: null,
				};
			}

			const organizationId = JSON.parse(
				apiKeyRecord.metadata || "{}",
			).organizationId;

			if (!organizationId) {
				return {
					session: null,
					user: null,
				};
			}

			const member = await db.query.member.findFirst({
				where: and(
					eq(schema.member.userId, apiKeyRecord.user.id),
					eq(schema.member.organizationId, organizationId),
				),
				with: {
					organization: true,
				},
			});

			const {
				id,
				name,
				email,
				emailVerified,
				image,
				createdAt,
				updatedAt,
				twoFactorEnabled,
			} = apiKeyRecord.user;

			const mockSession = {
				session: {
					userId: apiKeyRecord.user.id,
					activeOrganizationId: organizationId || "",
				},
				user: {
					id,
					name,
					email,
					emailVerified,
					image,
					createdAt,
					updatedAt,
					twoFactorEnabled,
					role: member?.role || "member",
					ownerId: member?.organization.ownerId || apiKeyRecord.user.id,
				},
			};

			return mockSession;
		} catch (error) {
			console.error("Error verifying API key", error);
			return {
				session: null,
				user: null,
			};
		}
	}

	// If no API key, proceed with normal session validation
	const session = await api.getSession({
		headers: new Headers({
			cookie: request.headers.cookie || "",
		}),
	});

	if (!session?.session || !session.user) {
		return {
			session: null,
			user: null,
		};
	}

	if (session?.user) {
		const member = await db.query.member.findFirst({
			where: and(
				eq(schema.member.userId, session.user.id),
				eq(
					schema.member.organizationId,
					session.session.activeOrganizationId || "",
				),
			),
			with: {
				organization: true,
			},
		});

		session.user.role = member?.role || "member";
		if (member) {
			session.user.ownerId = member.organization.ownerId;
		} else {
			session.user.ownerId = session.user.id;
		}
	}

	return session;
};
