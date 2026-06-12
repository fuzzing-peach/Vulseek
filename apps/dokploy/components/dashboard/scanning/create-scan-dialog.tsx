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
	onSubmit: (input: {
		targetRef?: string;
		targetTag?: string;
		commitWindow?: number;
		scanRuntimeSettings?: ScanRuntimeSettingsDraft;
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
	onSubmit,
}: Props) => {
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

	useEffect(() => {
		if (!open) {
			setTargetRef(defaultRef);
			setTargetTag("");
			setCommitWindow(String(defaultCommitWindow));
			setScanRuntimeSettings({});
		}
	}, [defaultCommitWindow, defaultRef, open]);

	const handleSubmit = async () => {
		const parsedWindow = Number.parseInt(commitWindow, 10);
		const normalizedWindow =
			Number.isNaN(parsedWindow) || parsedWindow < 1
				? defaultCommitWindow
				: parsedWindow;

		await onSubmit({
			targetRef: targetRef.trim() || undefined,
			targetTag: targetTag.trim() || undefined,
			commitWindow: showCommitWindow ? normalizedWindow : undefined,
			scanRuntimeSettings,
		});
		setOpen(false);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4">
					{showFullScanPreview ? (
						<div className="rounded-lg border bg-background p-4">
							<div className="text-sm font-semibold">What will run</div>
							<p className="mt-1 text-sm text-muted-foreground">
								Full Scan checks out the selected source, scans repository
								structure, expands module and function tasks, analyzes candidate
								findings, and only sends verified or likely findings to triage.
							</p>
						</div>
					) : null}
					{showFullScanPreview ? (
						<FullScanStageGraphPreview
							serviceData={serviceData}
							scanRuntimeSettings={scanRuntimeSettings}
							onScanRuntimeSettingsChange={setScanRuntimeSettings}
						/>
					) : null}
					<div className="grid gap-2">
						<Label htmlFor={`${title}-target-ref`}>Ref</Label>
						<Input
							id={`${title}-target-ref`}
							placeholder="main"
							value={targetRef}
							onChange={(event) => setTargetRef(event.target.value)}
						/>
					</div>
					<div className="grid gap-2">
						<Label htmlFor={`${title}-target-tag`}>Tag</Label>
						<Input
							id={`${title}-target-tag`}
							placeholder="v1.2.3"
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
				</div>
				<DialogFooter>
					<Button variant="secondary" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button isLoading={isLoading} onClick={handleSubmit}>
						Confirm
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
