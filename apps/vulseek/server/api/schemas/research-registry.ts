import { z } from "zod";

export const apiFindResearchRegistryPageByScanJob = z
	.object({
		scanJobId: z.string().min(1),
		page: z.number().int().min(1).default(1),
		pageSize: z.number().int().min(1).max(100).default(20),
		query: z.string().max(200).default(""),
		status: z.string().max(64).default(""),
		statuses: z.array(z.string().min(1).max(64)).max(20).default([]),
		trustLevels: z.array(z.string().min(1).max(64)).max(20).default([]),
		sortKey: z.string().max(64).default("updatedAt"),
		sortDirection: z.enum(["asc", "desc"]).default("desc"),
	})
	.required();
