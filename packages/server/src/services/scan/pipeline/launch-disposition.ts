export type LaunchDisposition = "continue" | "cancel" | "defer";

export const resolveLaunchDisposition = (input: {
	scanJobStatus: string | null | undefined;
	taskStatus: string | null | undefined;
}): LaunchDisposition => {
	if (input.scanJobStatus === "canceled" || input.taskStatus === "canceled") {
		return "cancel";
	}
	if (input.scanJobStatus === "paused") {
		return "defer";
	}
	return "continue";
};
