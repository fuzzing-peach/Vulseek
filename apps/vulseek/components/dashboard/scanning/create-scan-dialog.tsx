import { useTranslation } from "next-i18next";
import { useEffect, useMemo, useState } from "react";
import {
	FullScanStageGraphPreview,
	type ScanRuntimeSettingsDraft,
} from "@/components/dashboard/scanning/scan-stage-graph";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { scanT } from "./scan-i18n";

const deriveDefaultRef = (
	serviceData: Record<string, unknown> | null | undefined,
) => {
	if (!serviceData) {
		return "";
	}

	const refCandidates = [
		"branch",
		"customGitBranch",
		"gitlabBranch",
		"bitbucketBranch",
		"giteaBranch",
	];

	for (const key of refCandidates) {
		const value = serviceData[key];
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}

	return "";
};

interface Props {
	title: string;
	description: string;
	trigger: React.ReactNode;
	isLoading?: boolean;
	serviceData?: Record<string, unknown> | null;
	defaultCommitWindow?: number;
	showCommitWindow?: boolean;
	showFullScanPreview?: boolean;
	scanType?: "delta" | "full" | "research" | "tob-goal";
	onSubmit: (input: {
		targetRef?: string;
		targetTag?: string;
		commitWindow?: number;
		scanRuntimeSettings?: ScanRuntimeSettingsDraft;
		threatDirection?: {
			focus: string;
			attackerModel: string;
			nonGoals?: string[];
			notes?: string;
		};
	}) => Promise<void>;
}

export const CreateScanDialog = ({
	title,
	description,
	trigger,
	isLoading = false,
	serviceData,
	defaultCommitWindow = 3,
	showCommitWindow = true,
	showFullScanPreview = false,
	scanType = "full",
	onSubmit,
}: Props) => {
	const { t } = useTranslation("scan");
	const [open, setOpen] = useState(false);
	const defaultRef = useMemo(
		() => deriveDefaultRef(serviceData),
		[serviceData],
	);
	const [targetRef, setTargetRef] = useState(defaultRef);
	const [targetTag, setTargetTag] = useState("");
	const [commitWindow, setCommitWindow] = useState(String(defaultCommitWindow));
	const [scanRuntimeSettings, setScanRuntimeSettings] =
		useState<ScanRuntimeSettingsDraft>({});
	const [threatFocus, setThreatFocus] = useState(
		"Find one high-impact vulnerability reachable under the stated attacker model",
	);
	const [threatAttackerModel, setThreatAttackerModel] = useState(
		"Remote network attacker without local credentials, admin access, or prior code execution",
	);
	const [threatNonGoals, setThreatNonGoals] = useState("");
	const [threatNotes, setThreatNotes] = useState("");
	const previewDescription =
		scanType === "delta"
			? scanT(
					t,
					"scan.dialog.deltaPreview",
					"Delta Scan scopes targets impacted by the target/base diff, then runs target scanning, finding analysis, verification, and triage.",
				)
			: scanType === "research"
				? scanT(
						t,
						"scan.dialog.researchPreview",
						"Research Scan builds a trust-boundary model, maintains independent research tracks, validates findings, and reviews candidate chains.",
					)
				: scanType === "tob-goal"
					? scanT(
							t,
							"scan.dialog.goalPreview",
							"Goal Scan crafts a red-teamed goal, dispatches hunt goals from attack surfaces, judges candidates, and stores novel findings.",
						)
					: scanT(
							t,
							"scan.dialog.fullPreview",
							"Full Scan checks out the selected source, profiles the repository, models attack surfaces, identifies targets, scans candidate findings, and sends verified or likely findings to triage.",
						);

	useEffect(() => {
		if (!open) {
			setTargetRef(defaultRef);
			setTargetTag("");
			setCommitWindow(String(defaultCommitWindow));
			setScanRuntimeSettings({});
			setThreatFocus(
				"Find one high-impact vulnerability reachable under the stated attacker model",
			);
			setThreatAttackerModel(
				"Remote network attacker without local credentials, admin access, or prior code execution",
			);
			setThreatNonGoals("");
			setThreatNotes("");
		}
	}, [defaultCommitWindow, defaultRef, open]);

	const handleSubmit = async () => {
		const parsedWindow = Number.parseInt(commitWindow, 10);
		const normalizedWindow =
			Number.isNaN(parsedWindow) || parsedWindow < 1
				? defaultCommitWindow
				: parsedWindow;
		const nonGoals = threatNonGoals
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean);

		await onSubmit({
			targetRef: targetRef.trim() || undefined,
			targetTag: targetTag.trim() || undefined,
			commitWindow: showCommitWindow ? normalizedWindow : undefined,
			scanRuntimeSettings,
			threatDirection:
				scanType === "tob-goal"
					? {
							focus: threatFocus.trim(),
							attackerModel: threatAttackerModel.trim(),
							...(nonGoals.length > 0 ? { nonGoals } : {}),
							...(threatNotes.trim() ? { notes: threatNotes.trim() } : {}),
						}
					: undefined,
		});
		setOpen(false);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent
				className={
					scanType === "research" || scanType === "tob-goal"
						? "max-h-[92vh] overflow-y-auto sm:max-w-4xl"
						: "sm:max-w-3xl"
				}
			>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4">
					{showFullScanPreview ? (
						<div className="rounded-lg border bg-background p-4">
							<div className="text-sm font-semibold">
								{scanT(t, "scan.dialog.whatWillRun", "What will run")}
							</div>
							<p className="mt-1 text-sm text-muted-foreground">
								{previewDescription}
							</p>
						</div>
					) : null}
					{showFullScanPreview ? (
						<FullScanStageGraphPreview
							serviceData={serviceData}
							scanRuntimeSettings={scanRuntimeSettings}
							scanType={scanType}
							onScanRuntimeSettingsChange={setScanRuntimeSettings}
						/>
					) : null}
					<div className="grid gap-2">
						<Label htmlFor={`${title}-target-ref`}>
							{scanT(t, "scan.dialog.ref", "Ref")}
						</Label>
						<Input
							id={`${title}-target-ref`}
							placeholder="main"
							value={targetRef}
							onChange={(event) => setTargetRef(event.target.value)}
						/>
					</div>
					<div className="grid gap-2">
						<Label htmlFor={`${title}-target-tag`}>
							{scanT(t, "scan.dialog.tag", "Tag")}
						</Label>
						<Input
							id={`${title}-target-tag`}
							placeholder={
								// Matches prepare-repository preferLatestTag for full/research/tob-goal
								scanType === "full" ||
								scanType === "research" ||
								scanType === "tob-goal"
									? scanT(
											t,
											"scan.dialog.tagLatestPlaceholder",
											"Leave empty to use latest tag",
										)
									: "v1.2.3"
							}
							value={targetTag}
							onChange={(event) => setTargetTag(event.target.value)}
						/>
					</div>
					{showCommitWindow ? (
						<div className="grid gap-2">
							<Label htmlFor={`${title}-commit-window`}>k</Label>
							<Input
								id={`${title}-commit-window`}
								inputMode="numeric"
								placeholder={String(defaultCommitWindow)}
								value={commitWindow}
								onChange={(event) => setCommitWindow(event.target.value)}
							/>
						</div>
					) : null}
					{scanType === "tob-goal" ? (
						<div className="grid gap-3 rounded-lg border p-4">
							<div className="text-sm font-semibold">
								{scanT(t, "scan.goal.threatDirection", "Threat direction")}
							</div>
							<div className="grid gap-2">
								<Label htmlFor={`${title}-threat-focus`}>
									{scanT(t, "scan.goal.focus", "Focus / success intent")}
								</Label>
								<Input
									id={`${title}-threat-focus`}
									value={threatFocus}
									onChange={(event) => setThreatFocus(event.target.value)}
								/>
							</div>
							<div className="grid gap-2">
								<Label htmlFor={`${title}-threat-attacker`}>
									{scanT(t, "scan.goal.attackerModel", "Attacker model")}
								</Label>
								<Input
									id={`${title}-threat-attacker`}
									value={threatAttackerModel}
									onChange={(event) =>
										setThreatAttackerModel(event.target.value)
									}
								/>
							</div>
							<div className="grid gap-2">
								<Label htmlFor={`${title}-threat-nongoals`}>
									{scanT(
										t,
										"scan.goal.nonGoals",
										"Non-goals (one per line, optional)",
									)}
								</Label>
								<textarea
									id={`${title}-threat-nongoals`}
									className="min-h-20 rounded-md border bg-background px-3 py-2 text-sm"
									value={threatNonGoals}
									onChange={(event) => setThreatNonGoals(event.target.value)}
								/>
							</div>
							<div className="grid gap-2">
								<Label htmlFor={`${title}-threat-notes`}>
									{scanT(t, "scan.goal.notes", "Notes (optional)")}
								</Label>
								<Input
									id={`${title}-threat-notes`}
									value={threatNotes}
									onChange={(event) => setThreatNotes(event.target.value)}
								/>
							</div>
						</div>
					) : null}
				</div>
				<DialogFooter>
					<Button variant="secondary" onClick={() => setOpen(false)}>
						{scanT(t, "scan.dialog.cancel", "Cancel")}
					</Button>
					<Button
						isLoading={isLoading}
						onClick={handleSubmit}
						disabled={
							scanType === "tob-goal" &&
							(!threatFocus.trim() || !threatAttackerModel.trim())
						}
					>
						{scanT(t, "scan.dialog.confirm", "Confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
