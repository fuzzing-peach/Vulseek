type DeployJob =
	| {
			applicationId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy";
			applicationType: "application";
			serverId?: string;
	  }
	| {
			composeId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy";
			applicationType: "compose";
			serverId?: string;
	  }
	| {
			applicationId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy";
			applicationType: "application-preview";
			previewDeploymentId: string;
			serverId?: string;
	  };

export type DeploymentJob = DeployJob;

export type ScanQueueJob = {
	scanJobId: string;
	mode?: "full" | "delta" | "research" | "tob-goal" | "retry-failed-tasks" | "rerun-task";
};

export type ScanEvaluationQueueJob = {
	evaluateResultId: string;
};

export type DatasetEvaluationQueueJob = {
	evaluationId: string;
};
