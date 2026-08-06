import { relations } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { nanoid } from "nanoid";
import { z } from "zod";
import { organization } from "./account";
import { environments } from "./environment";

export const projects = pgTable("project", {
	projectId: text("projectId")
		.notNull()
		.primaryKey()
		.$defaultFn(() => nanoid()),
	name: text("name").notNull(),
	description: text("description"),
	createdAt: text("createdAt")
		.notNull()
		.$defaultFn(() => new Date().toISOString()),

	organizationId: text("organizationId")
		.notNull()
		.references(() => organization.id, { onDelete: "cascade" }),
	env: text("env").notNull().default(""),
	scanContextVolumeName: text("scanContextVolumeName").notNull().default(""),
});

export const projectRelations = relations(projects, ({ many, one }) => ({
	environments: many(environments),
	organization: one(organization, {
		fields: [projects.organizationId],
		references: [organization.id],
	}),
}));

const createSchema = createInsertSchema(projects, {
	projectId: z.string().min(1),
	name: z.string().min(1),
	description: z.string().optional(),
});

export const apiCreateProject = createSchema.pick({
	name: true,
	description: true,
	env: true,
});

export const apiFindOneProject = createSchema
	.pick({
		projectId: true,
	})
	.required();

export const apiRemoveProject = createSchema
	.pick({
		projectId: true,
	})
	.required();

// export const apiUpdateProject = createSchema
// 	.pick({
// 		name: true,
// 		description: true,
// 		projectId: true,
// 		env: true,
// 	})
// 	.required();

export const apiUpdateProject = createSchema.partial().extend({
	projectId: z.string().min(1),
});

/** Server-side paginated project listing (shared contract with CollectionView). */
export const apiListProjects = z.object({
	search: z.string().trim().max(200).optional(),
	sortKey: z.enum(["name", "createdAt", "services"]).default("createdAt"),
	sortDirection: z.enum(["asc", "desc"]).default("desc"),
	page: z.number().int().min(1).default(1),
	pageSize: z.number().int().min(1).max(100).default(12),
});
// .omit({ serverId: true });
