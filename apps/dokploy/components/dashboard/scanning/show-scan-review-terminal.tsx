import Head from "next/head";
import dynamic from "next/dynamic";
import { useTranslation } from "next-i18next";
import { useRouter } from "next/router";
import { scanT } from "./scan-i18n";

const DockerTerminal = dynamic(
	() =>
		import("@/components/dashboard/docker/terminal/docker-terminal").then(
			(module) => module.DockerTerminal,
		),
	{
		ssr: false,
	},
);

export const ShowScanReviewTerminal = () => {
	const router = useRouter();
	const { t } = useTranslation("scan");
	const containerId =
		typeof router.query.containerId === "string"
			? router.query.containerId
			: "";

	return (
		<>
			<Head>
				<title>
					{scanT(t, "scan.reviewTerminal.title", "Candidate Review Terminal")}
				</title>
			</Head>
			<div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-6">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold">
						{scanT(t, "scan.reviewTerminal.title", "Candidate Review Terminal")}
					</h1>
					<p className="text-sm text-muted-foreground">
						{scanT(
							t,
							"scan.reviewTerminal.description",
							"Codex starts directly in the mounted review workspace. Switch to bash or /bin/sh if you need to inspect files manually.",
						)}
					</p>
				</div>
				<div className="min-h-[70vh] rounded-lg border bg-background p-4">
					{containerId ? (
						<DockerTerminal
							id="scan-review-terminal"
							containerId={containerId}
							allowAttach
							defaultTerminalMode="codex"
						/>
					) : (
						<div className="text-sm text-muted-foreground">
							{scanT(
								t,
								"scan.reviewTerminal.missingContainer",
								"Container ID is missing.",
							)}
						</div>
					)}
				</div>
			</div>
		</>
	);
};
