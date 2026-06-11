import { scanJobs, tasks } from "@dokploy/server/db/schema";
import type {
	Analysis,
	BuildFuzzerRequest,
	Candidate,
	CriticResponse,
	Evidence,
	FinalAnalysis,
	Function,
	FunctionScanManifest,
	FuzzBuildResult,
	FuzzRunResult,
	Module,
	ModuleScanManifest,
	Repository,
	RepositoryModule,
	RepositoryScanManifest,
	Triage,
	Verification,
} from "./artifacts/contracts/domain-object.contract";
export type {
	Analysis,
	BuildFuzzerRequest,
	Candidate,
	CriticResponse,
	Evidence,
	FinalAnalysis,
	Function,
	FunctionScanManifest,
	FuzzBuildResult,
	FuzzRunResult,
	Module,
	ModuleScanManifest,
	Repository,
	RepositoryModule,
	RepositoryScanManifest,
	Triage,
	Verification,
} from "./artifacts/contracts/domain-object.contract";

export type ScanJob = typeof scanJobs.$inferSelect & {
	inputTokens: number;
	outputTokens: number;
	thoughtTokens: number;
	totalTokens: number;
	cachedReadTokens: number;
	cachedWriteTokens: number;
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
	status:
		| "pending"
		| "launching"
		| "launched"
		| "starting"
		| "running"
		| "completed"
		| "failed"
		| "exited"
		| "canceled";
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

export type TriageResult = {
	taskId: string;
	scanJobId: string;
	vulnerabilityCandidateId: string;
	result: Triage["result"];
	securityClassification: Triage["securityClassification"];
	isSecurityIssue: boolean;
	impactType: string;
	cvssVector: string | null;
	cvssScore: number | null;
	cvssSeverity: Triage["cvssSeverity"];
	exploitability: Triage["exploitability"];
	isExploitable: boolean | null;
	commonTriggerConditions: string[];
	hardeningOrRobustness: boolean;
	epssProbability30d: number | null;
	epssSource: string;
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

export type VulnerabilityCandidateStage = "analyzing" | "fuzzing" | "verifying";

export type ScanCandidateQueueJob = {
	scanJobId: string;
	vulnerabilityCandidateId: string;
};

export type AgentProfileLike = {
	agentProfileId: string;
	name: string;
	provider: "codex" | "claude_code";
	authMode: "api_key" | "host_home";
	homePath: string;
	baseUrl: string;
	apiKey: string;
	model: string;
	thinkingLevel: string;
	thinkingLevelEnabled: boolean;
	envs: string;
	isEnabled: boolean;
};
