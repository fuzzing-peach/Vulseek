import type { taskStatusEnum } from "@vulseek/server/db/schema";
import { SCAN_STAGE_IDS } from "./stage-metadata";
import type { Task } from "./types";

const STAGE_TO_STAGE_NAME: Record<string, Task["stageName"]> = {
	"delta-scope": SCAN_STAGE_IDS.deltaScope,
	"repository-profile": SCAN_STAGE_IDS.repositoryProfile,
	"attack-surface-model": SCAN_STAGE_IDS.attackSurfaceModel,
	"identify-target": SCAN_STAGE_IDS.identifyTarget,
	"scan-target": SCAN_STAGE_IDS.scanTarget,
	"analyze-finding": SCAN_STAGE_IDS.analyzeFinding,
	"critique-finding": SCAN_STAGE_IDS.critiqueFinding,
	"verify-finding": SCAN_STAGE_IDS.verifyFinding,
	"triage-finding": SCAN_STAGE_IDS.triageFinding,
};

type TerminalTaskStatus = Extract<
	(typeof taskStatusEnum.enumValues)[number],
	"completed" | "failed" | "exited" | "canceled"
>;

const terminalTaskStatuses = new Set<string>([
	"completed",
	"failed",
	"exited",
	"canceled",
]);

export const normalizeTerminalTaskFilters = (input: {
	stage?: string;
	status?: string;
}) => ({
	stageName:
		input.stage && input.stage !== "all"
			? STAGE_TO_STAGE_NAME[input.stage]
			: undefined,
	status: terminalTaskStatuses.has(input.status ?? "")
		? (input.status as TerminalTaskStatus)
		: undefined,
});
