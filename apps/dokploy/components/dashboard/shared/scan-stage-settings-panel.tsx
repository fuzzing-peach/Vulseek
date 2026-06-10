"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { BotIcon, Pencil } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";

type AgentProfileOption = {
	agentProfileId: string;
	name: string;
	provider?: "codex" | "claude_code" | string;
	isEnabled: boolean;
};

export type ScanStageSettings = Record<
	string,
	{
		agentProfileId?: string | null;
		concurrency?: number | null;
	}
>;

export type ScanStageSettingsTarget = {
	scanStageSettings?: ScanStageSettings | null;
};

type StageDefinition = {
	stageName: string;
	label: string;
	role: "scan" | "analysis" | "verification";
	defaultConcurrency: number;
	maxConcurrency: number;
	description: string;
};

const STAGES: StageDefinition[] = [
	{
		stageName: "repository-scan",
		label: "Scan Repository",
		role: "scan",
		defaultConcurrency: 1,
		maxConcurrency: 8,
		description: "Repository-wide planner and module partitioning.",
	},
	{
		stageName: "module-scan",
		label: "Scan Module",
		role: "scan",
		defaultConcurrency: 4,
		maxConcurrency: 32,
		description: "Module-level source review and function discovery.",
	},
	{
		stageName: "function-scan",
		label: "Scan Function",
		role: "scan",
		defaultConcurrency: 4,
		maxConcurrency: 64,
		description: "Function-level candidate discovery.",
	},
	{
		stageName: "analyze",
		label: "Analyze",
		role: "analysis",
		defaultConcurrency: 2,
		maxConcurrency: 16,
		description: "Candidate analysis and routing decisions.",
	},
	{
		stageName: "build-fuzzer",
		label: "Build Fuzzer",
		role: "analysis",
		defaultConcurrency: 2,
		maxConcurrency: 16,
		description: "Builds per-candidate LibAFL fuzzers.",
	},
	{
		stageName: "run-fuzzer",
		label: "Run Fuzzer",
		role: "analysis",
		defaultConcurrency: 2,
		maxConcurrency: 16,
		description: "Runs fuzzing campaigns and reports evidence.",
	},
	{
		stageName: "criticize",
		label: "Criticize",
		role: "analysis",
		defaultConcurrency: 2,
		maxConcurrency: 16,
		description: "Challenges analysis results before verification.",
	},
	{
		stageName: "verify",
		label: "Verify",
		role: "verification",
		defaultConcurrency: 1,
		maxConcurrency: 16,
		description: "Sanity-checks final analysis facts.",
	},
	{
		stageName: "triage",
		label: "Triage",
		role: "verification",
		defaultConcurrency: 1,
		maxConcurrency: 16,
		description: "Classifies security impact after verification.",
	},
];

const FORK_STAGE_EDGES = [
	["repository-scan", "module-scan"],
	["module-scan", "function-scan"],
	["function-scan", "analyze"],
	["analyze", "build-fuzzer"],
	["build-fuzzer", "run-fuzzer"],
] as const;

const StageSettingsFormSchema = z.object({
	agentProfileId: z.string().min(1),
	concurrency: z.coerce.number().int().min(1).max(128),
});

type StageSettingsForm = z.infer<typeof StageSettingsFormSchema>;

const getStageAgentProfileId = (
	target: ScanStageSettingsTarget,
	stage: StageDefinition,
	enabledProfiles: AgentProfileOption[],
) =>
	target.scanStageSettings?.[stage.stageName]?.agentProfileId ||
	enabledProfiles[0]?.agentProfileId ||
	"";

const getStageConcurrency = (
	target: ScanStageSettingsTarget,
	stage: StageDefinition,
) =>
	target.scanStageSettings?.[stage.stageName]?.concurrency ||
	stage.defaultConcurrency;

const formatProvider = (provider: string | undefined) => {
	if (provider === "claude_code") {
		return "Claude Code";
	}
	if (provider === "codex") {
		return "Codex";
	}
	return provider || "Unknown";
};

const validateForkAgentProviders = (
	target: ScanStageSettingsTarget,
	enabledProfiles: AgentProfileOption[],
) => {
	for (const [parentStageName, childStageName] of FORK_STAGE_EDGES) {
		const parentStage = STAGES.find(
			(stage) => stage.stageName === parentStageName,
		);
		const childStage = STAGES.find(
			(stage) => stage.stageName === childStageName,
		);
		if (!parentStage || !childStage) {
			continue;
		}
		const parentProfileId = getStageAgentProfileId(
			target,
			parentStage,
			enabledProfiles,
		);
		const childProfileId = getStageAgentProfileId(
			target,
			childStage,
			enabledProfiles,
		);
		const parentProfile = enabledProfiles.find(
			(profile) => profile.agentProfileId === parentProfileId,
		);
		const childProfile = enabledProfiles.find(
			(profile) => profile.agentProfileId === childProfileId,
		);
		if (!parentProfile || !childProfile) {
			return `Cannot verify fork compatibility for ${parentStage.label} -> ${childStage.label}. Select enabled agent profiles for both stages.`;
		}
		if (parentProfile.provider !== childProfile.provider) {
			return `${parentStage.label} forks ${childStage.label}, so both stages must use the same agent type. Current types: ${parentStage.label} uses ${formatProvider(parentProfile.provider)}, ${childStage.label} uses ${formatProvider(childProfile.provider)}.`;
		}
	}
	return null;
};

export const ScanStageSettingsPanel = ({
	target,
	agentProfiles,
	onSave,
}: {
	target?: ScanStageSettingsTarget | null;
	agentProfiles?: AgentProfileOption[];
	onSave: (payload: Record<string, unknown>) => Promise<void>;
}) => {
	const [selectedStageName, setSelectedStageName] = useState<string | null>(
		null,
	);
	const [isSaving, setIsSaving] = useState(false);
	const enabledProfiles = useMemo(
		() => agentProfiles?.filter((profile) => profile.isEnabled) ?? [],
		[agentProfiles],
	);
	const selectedStage =
		STAGES.find((stage) => stage.stageName === selectedStageName) ?? null;
	const form = useForm<StageSettingsForm>({
		defaultValues: {
			agentProfileId: "",
			concurrency: 1,
		},
		resolver: zodResolver(StageSettingsFormSchema),
	});

	const rows = useMemo(
		() =>
			STAGES.map((stage) => {
				const agentProfileId = target
					? getStageAgentProfileId(target, stage, enabledProfiles)
					: "";
				const agentProfile = enabledProfiles.find(
					(profile) => profile.agentProfileId === agentProfileId,
				);
				return {
					...stage,
					agentProfileId,
					agentProfileName: agentProfile?.name || "Default",
					concurrency: target
						? getStageConcurrency(target, stage)
						: stage.defaultConcurrency,
				};
			}),
		[target, enabledProfiles],
	);

	useEffect(() => {
		if (!selectedStage || !target) {
			return;
		}
		form.reset({
			agentProfileId: getStageAgentProfileId(
				target,
				selectedStage,
				enabledProfiles,
			),
			concurrency: getStageConcurrency(target, selectedStage),
		});
	}, [selectedStage, target, enabledProfiles, form]);

	if (enabledProfiles.length === 0) {
		return (
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl flex items-center gap-2">
						<BotIcon className="size-5 text-muted-foreground" />
						Agent Settings
					</CardTitle>
					<CardDescription>
						Configure dedicated agent profiles and concurrency per scan stage.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="text-sm text-muted-foreground">
						No enabled agent profile found. Create one in{" "}
						<Link href="/dashboard/settings/ai" className="text-primary">
							Agent Profiles
						</Link>
						.
					</div>
				</CardContent>
			</Card>
		);
	}

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl flex items-center gap-2">
					<BotIcon className="size-5 text-muted-foreground" />
					Stage Agent Settings
				</CardTitle>
				<CardDescription>
					Configure agent profile and concurrency per full scan stage.
				</CardDescription>
			</CardHeader>
			<CardContent>
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Stage</TableHead>
							<TableHead>Agent Profile</TableHead>
							<TableHead>Concurrency</TableHead>
							<TableHead className="w-16" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows.map((stage) => (
							<TableRow key={stage.stageName}>
								<TableCell>
									<div className="font-medium">{stage.label}</div>
									<div className="text-xs text-muted-foreground">
										{stage.description}
									</div>
								</TableCell>
								<TableCell>{stage.agentProfileName}</TableCell>
								<TableCell>{stage.concurrency}</TableCell>
								<TableCell className="text-right">
									<Button
										type="button"
										variant="secondary"
										size="sm"
										onClick={() => setSelectedStageName(stage.stageName)}
									>
										<Pencil className="size-4" />
									</Button>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>

				<Dialog
					open={Boolean(selectedStage)}
					onOpenChange={(open) => {
						if (!open) {
							setSelectedStageName(null);
						}
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								{selectedStage ? `Edit ${selectedStage.label}` : "Edit Stage"}
							</DialogTitle>
							<DialogDescription>
								Set the agent profile and concurrency for this stage.
							</DialogDescription>
						</DialogHeader>
						<Form {...form}>
							<form
								id="scan-stage-settings-form"
								className="grid gap-4"
								onSubmit={form.handleSubmit(async (values) => {
									if (!selectedStage || !target) {
										return;
									}
									setIsSaving(true);
									try {
										const nextScanStageSettings = {
											...(target.scanStageSettings ?? {}),
											[selectedStage.stageName]: {
												agentProfileId: values.agentProfileId,
												concurrency: values.concurrency,
											},
										};
										const validationError = validateForkAgentProviders(
											{
												...target,
												scanStageSettings: nextScanStageSettings,
											},
											enabledProfiles,
										);
										if (validationError) {
											toast.error(validationError);
											return;
										}
										await onSave({
											scanStageSettings: nextScanStageSettings,
										});
										toast.success("Stage settings updated");
										setSelectedStageName(null);
									} catch {
										toast.error("Failed to update stage settings");
									} finally {
										setIsSaving(false);
									}
								})}
							>
								<FormField
									control={form.control}
									name="agentProfileId"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Agent Profile</FormLabel>
											<Select
												onValueChange={field.onChange}
												value={field.value}
											>
												<FormControl>
													<SelectTrigger>
														<SelectValue placeholder="Select an agent profile" />
													</SelectTrigger>
												</FormControl>
												<SelectContent>
													{enabledProfiles.map((profile) => (
														<SelectItem
															key={profile.agentProfileId}
															value={profile.agentProfileId}
														>
															{profile.name}
														</SelectItem>
													))}
												</SelectContent>
											</Select>
											<FormMessage />
										</FormItem>
									)}
								/>
								<FormField
									control={form.control}
									name="concurrency"
									render={({ field }) => (
										<FormItem>
											<FormLabel>Concurrency</FormLabel>
											<FormControl>
												<Input
													type="number"
													min={1}
													max={selectedStage?.maxConcurrency ?? 128}
													step={1}
													name={field.name}
													ref={field.ref}
													value={field.value ?? ""}
													onBlur={field.onBlur}
													onChange={(event) =>
														field.onChange(event.target.value)
													}
												/>
											</FormControl>
											<FormDescription>
												Maximum number of tasks this stage may run in parallel.
											</FormDescription>
											<FormMessage />
										</FormItem>
									)}
								/>
							</form>
						</Form>
						<DialogFooter>
							<Button
								type="button"
								variant="secondary"
								onClick={() => setSelectedStageName(null)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								form="scan-stage-settings-form"
								isLoading={isSaving}
							>
								Save
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</CardContent>
		</Card>
	);
};
