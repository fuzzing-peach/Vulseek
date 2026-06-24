import { pgEnum } from "drizzle-orm/pg-core";
import { z } from "zod";

export const applicationStatus = pgEnum("applicationStatus", [
	"idle",
	"running",
	"done",
	"error",
]);

export const certificateType = pgEnum("certificateType", [
	"letsencrypt",
	"none",
	"custom",
]);

export const triggerType = pgEnum("triggerType", ["push", "tag"]);

export interface HealthCheckSwarm {
	Test?: string[] | undefined;
	Interval?: number | undefined;
	Timeout?: number | undefined;
	StartPeriod?: number | undefined;
	Retries?: number | undefined;
}

export interface RestartPolicySwarm {
	Condition?: string | undefined;
	Delay?: number | undefined;
	MaxAttempts?: number | undefined;
	Window?: number | undefined;
}

export interface PlacementSwarm {
	Constraints?: string[] | undefined;
	Preferences?: Array<{ Spread: { SpreadDescriptor: string } }> | undefined;
	MaxReplicas?: number | undefined;
	Platforms?:
		| Array<{
				Architecture: string;
				OS: string;
		  }>
		| undefined;
}

export interface UpdateConfigSwarm {
	Parallelism: number;
	Delay?: number | undefined;
	FailureAction?: string | undefined;
	Monitor?: number | undefined;
	MaxFailureRatio?: number | undefined;
	Order: string;
}

export interface ServiceModeSwarm {
	Replicated?: { Replicas?: number | undefined } | undefined;
	Global?: {} | undefined;
	ReplicatedJob?:
		| {
				MaxConcurrent?: number | undefined;
				TotalCompletions?: number | undefined;
		  }
		| undefined;
	GlobalJob?: {} | undefined;
}

export interface NetworkSwarm {
	Target?: string | undefined;
	Aliases?: string[] | undefined;
	DriverOpts?: { [key: string]: string } | undefined;
}

export interface LabelsSwarm {
	[name: string]: string;
}

export const ScanStageSettingSchema = z.object({
	agentProfileId: z.string().nullable().optional(),
	concurrency: z.number().int().min(1).max(128).nullable().optional(),
});

export const ScanStageSettingsSchema = z.record(ScanStageSettingSchema);

export type ScanStageSetting = z.infer<typeof ScanStageSettingSchema>;
export type ScanStageSettings = z.infer<typeof ScanStageSettingsSchema>;

export const EvaluateConfigSchema = z.object({
	agentProfileId: z.string().default(""),
	groundTruthPath: z.string().default(""),
});

export type EvaluateConfig = z.infer<typeof EvaluateConfigSchema>;

export const buildDefaultEvaluateConfig = (): EvaluateConfig => ({
	agentProfileId: "",
	groundTruthPath: "",
});

export const ScanRuntimeStageSettingSchema = z.object({
	disabled: z.boolean().optional(),
	agentProfileId: z.string().nullable().optional(),
	concurrency: z.number().int().min(1).max(128).nullable().optional(),
});

export const ScanRuntimeSettingsSchema = z
	.object({
		stages: z.record(ScanRuntimeStageSettingSchema).optional(),
	})
	.default({});

export type ScanRuntimeStageSetting = z.infer<
	typeof ScanRuntimeStageSettingSchema
>;
export type ScanRuntimeSettings = z.infer<typeof ScanRuntimeSettingsSchema>;

export const buildDefaultScanStageSettings = (
	agentProfileId?: string | null,
): ScanStageSettings => ({
	"delta-scope": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 1,
	},
	"repository-scan": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 1,
	},
	"repository-profile": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 1,
	},
	"attack-surface-model": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 4,
	},
	"identify-target": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 4,
	},
	"scan-target": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 4,
	},
	"analyze-finding": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 2,
	},
	"critique-finding": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 2,
	},
	"verify-finding": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 1,
	},
	"triage-finding": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 1,
	},
	"module-scan": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 4,
	},
	"module-threat-model": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 4,
	},
	"design-rule": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 4,
	},
	"scan-rule": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 4,
	},
	"scan-pattern": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 4,
	},
	"sink-pre-analyze": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 4,
	},
	"function-scan": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 4,
	},
	analyze: {
		agentProfileId: agentProfileId ?? null,
		concurrency: 2,
	},
	"build-fuzzer": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 2,
	},
	"run-fuzzer": {
		agentProfileId: agentProfileId ?? null,
		concurrency: 2,
	},
	criticize: {
		agentProfileId: agentProfileId ?? null,
		concurrency: 2,
	},
	verify: {
		agentProfileId: agentProfileId ?? null,
		concurrency: 1,
	},
	triage: {
		agentProfileId: agentProfileId ?? null,
		concurrency: 1,
	},
});

export const HealthCheckSwarmSchema = z
	.object({
		Test: z.array(z.string()).optional(),
		Interval: z.number().optional(),
		Timeout: z.number().optional(),
		StartPeriod: z.number().optional(),
		Retries: z.number().optional(),
	})
	.strict();

export const RestartPolicySwarmSchema = z
	.object({
		Condition: z.string().optional(),
		Delay: z.number().optional(),
		MaxAttempts: z.number().optional(),
		Window: z.number().optional(),
	})
	.strict();

export const PreferenceSchema = z
	.object({
		Spread: z.object({
			SpreadDescriptor: z.string(),
		}),
	})
	.strict();

export const PlatformSchema = z
	.object({
		Architecture: z.string(),
		OS: z.string(),
	})
	.strict();

export const PlacementSwarmSchema = z
	.object({
		Constraints: z.array(z.string()).optional(),
		Preferences: z.array(PreferenceSchema).optional(),
		MaxReplicas: z.number().optional(),
		Platforms: z.array(PlatformSchema).optional(),
	})
	.strict();

export const UpdateConfigSwarmSchema = z
	.object({
		Parallelism: z.number(),
		Delay: z.number().optional(),
		FailureAction: z.string().optional(),
		Monitor: z.number().optional(),
		MaxFailureRatio: z.number().optional(),
		Order: z.string(),
	})
	.strict();

export const ReplicatedSchema = z
	.object({
		Replicas: z.number().optional(),
	})
	.strict();

export const ReplicatedJobSchema = z
	.object({
		MaxConcurrent: z.number().optional(),
		TotalCompletions: z.number().optional(),
	})
	.strict();

export const ServiceModeSwarmSchema = z
	.object({
		Replicated: ReplicatedSchema.optional(),
		Global: z.object({}).optional(),
		ReplicatedJob: ReplicatedJobSchema.optional(),
		GlobalJob: z.object({}).optional(),
	})
	.strict();

export const NetworkSwarmSchema = z.array(
	z
		.object({
			Target: z.string().optional(),
			Aliases: z.array(z.string()).optional(),
			DriverOpts: z.object({}).optional(),
		})
		.strict(),
);

export const LabelsSwarmSchema = z.record(z.string());
