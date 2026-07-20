import { useState } from "react";
import { useTranslation } from "next-i18next";
import { AgentStream } from "./agent-stream";
import { SseAgentStreamTransport } from "./agent-stream-transport";

export const buildTaskAgentStreamUrl = (taskId: string) =>
	`/api/scan/tasks/${encodeURIComponent(taskId)}/agent-stream`;

export const TaskSessionStream = ({ taskId }: { taskId: string }) => {
	const { t } = useTranslation("scan");
	const [transport] = useState(
		() => new SseAgentStreamTransport(buildTaskAgentStreamUrl(taskId)),
	);

	return (
		<AgentStream
			transport={transport}
			labels={{
				running: t("scan.status.running", "Running"),
				waiting: t(
					"scan.task.session.waiting",
					"Waiting for the native agent session...",
				),
				unavailable: t(
					"scan.task.session.unavailable",
					"The native agent session is unavailable.",
				),
				connectionError: t(
					"scan.task.session.connectionError",
					"Unable to connect to the agent session.",
				),
				jumpToLatest: t("scan.agentStream.jumpToLatest", "Jump to latest"),
			}}
		/>
	);
};
