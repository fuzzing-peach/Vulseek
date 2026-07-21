import type { ScanJob } from "../types";

export type CandidateAnalysisTaskInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	functionPath: string;
	candidatePath: string;
	analysisReportTemplatePath?: string | null;
	feedbackPath?: string | null;
};

export type CandidateVerificationTaskInput = {
	scanJob: ScanJob;
	repositoryPath: string;
	modulePath: string;
	functionPath: string;
	candidatePath: string;
	analysisResultPath: string;
};
