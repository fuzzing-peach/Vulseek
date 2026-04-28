import {
	candidateAnalysisTasks,
	candidateVerificationTasks,
	scanRepositoryTasks,
	scanFunctionTasks,
	scanJobs,
	scanModuleTasks,
	vulnerabilityCandidates,
} from "@dokploy/server/db/schema";
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
	repositoryTaskStatus: typeof scanRepositoryTasks.$inferSelect.status;
};
export type ScanRepositoryTask = typeof scanRepositoryTasks.$inferSelect;
export type ScanModuleTask = typeof scanModuleTasks.$inferSelect;
export type ScanFunctionTask = typeof scanFunctionTasks.$inferSelect;
export type CandidateAnalysisTask = typeof candidateAnalysisTasks.$inferSelect;
export type CandidateVerificationTask =
	typeof candidateVerificationTasks.$inferSelect;
export type VulnerabilityCandidate = typeof vulnerabilityCandidates.$inferSelect;
export type AnalysisResult = {
	analysisResultId: string;
	scanJobId: string;
	vulnerabilityCandidateId: string;
	result: string;
	confidence: number | null;
	score: number | null;
	reportPath: string | null;
	runtimeSeconds: number | null;
	threadId: string | null;
	summary: string | null;
	createdAt: string;
	updatedAt: string;
	candidateAnalysisTaskId?: string;
	status?: typeof candidateAnalysisTasks.$inferSelect.status;
};
export type VerificationResult = {
	verificationResultId: string;
	scanJobId: string;
	vulnerabilityCandidateId: string;
	result: string;
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
	candidateVerificationTaskId?: string;
	status?: typeof candidateVerificationTasks.$inferSelect.status;
};

export type VulnerabilityCandidateStage =
	| "analyzing"
	| "fuzzing"
	| "verifying";

export type ScanModuleQueueJob = {
	scanJobId: string;
	scanModuleTaskId: string;
};

export type ScanFunctionQueueJob = {
	scanJobId: string;
	scanFunctionTaskId: string;
};

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
	isEnabled: boolean;
};
