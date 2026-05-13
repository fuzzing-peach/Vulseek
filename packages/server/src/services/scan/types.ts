import {
	scanJobs,
	tasks,
} from "@dokploy/server/db/schema";
import type {
	Analysis,
	Candidate,
	Function,
	Module,
	Repository,
	Verification,
} from "./artifacts/contracts/domain-object.contract";
export type {
	Analysis,
	Candidate,
	Function,
	Module,
	Repository,
	Verification,
} from "./artifacts/contracts/domain-object.contract";

export type ScanJob = typeof scanJobs.$inferSelect & {
	repositoryTaskId: string | null;
	repositoryTaskStatus: typeof tasks.$inferSelect.status;
};
export type Task = typeof tasks.$inferSelect;
export type VulnerabilityCandidate = {
	vulnerabilityCandidateId: string;
	scanJobId: string;
	scanFunctionTaskId: string | null;
	title: string;
	description: string | null;
	filePath: string | null;
	line: number | null;
	vulnerabilityType: string | null;
	status: "pending" | "launching" | "running" | "completed" | "failed";
	currentStage: "analyzing" | "fuzzing" | "verifying";
	confidence: number | null;
	score: number | null;
	createdAt: string;
	updatedAt: string;
};
export type AnalysisResult = {
	taskId: string;
	scanJobId: string;
	vulnerabilityCandidateId: string;
	result: Analysis["result"];
	confidence: number | null;
	score: number | null;
	reportPath: string | null;
	runtimeSeconds: number | null;
	threadId: string | null;
	summary: string | null;
	createdAt: string;
	updatedAt: string;
	status?: typeof tasks.$inferSelect.status;
};
export type VerificationResult = {
	taskId: string;
	scanJobId: string;
	vulnerabilityCandidateId: string;
	result: Verification["result"];
	isBug: boolean | null;
	isSecurity: boolean | null;
	confidence: number | null;
	score: number | null;
	reportPath: string | null;
	issueDraftPath: string | null;
	pocPath: string | null;
	dockerfilePath: string | null;
	runScriptPath: string | null;
	runtimeSeconds: number | null;
	threadId: string | null;
	summary: string | null;
	createdAt: string;
	updatedAt: string;
	status?: typeof tasks.$inferSelect.status;
};

export type VulnerabilityCandidateStage =
	| "analyzing"
	| "fuzzing"
	| "verifying";

export type ScanCandidateQueueJob = {
	scanJobId: string;
	vulnerabilityCandidateId: string;
};

export type AgentProfileLike = {
	agentProfileId: string;
	name: string;
	provider: "codex" | "claude_code";
	baseUrl: string;
	apiKey: string;
	model: string;
	thinkingLevel: string;
	envs: string;
	isEnabled: boolean;
};
