"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { BotIcon, Pencil } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
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
import { api } from "@/utils/api";

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
	group: string;
	defaultConcurrency: number;
	maxConcurrency: number;
	disableable: boolean;
	description: string;
};

const titleCase = (value: string) =>
	value
		.replace(/[-_]/g, " ")
		.replace(/\b\w/g, (char) => char.toUpperCase());

const StageSettingsFormSchema = z.object({
	agentProfileId: z.string().min(1),
	concurrency: z.coerce.number().int().min(1).max(128),
});

type StageSettingsForm = z.infer<typeof StageSettingsFormSchema>;

const BatchEditFormSchema = z.object({
	agentProfileId: z.string().min(1),
});

type BatchEditForm = z.infer<typeof BatchEditFormSchema>;

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
	const [checkedStageNames, setCheckedStageNames] = useState<Set<string>>(
		new Set(),
	);
	const [isBatchEditOpen, setIsBatchEditOpen] = useState(false);
	const [isSaving, setIsSaving] = useState(false);
	const { data: pipelineCatalog, isLoading: isLoadingPipelineCatalog } =
		api.scan.pipelineCatalog.useQuery();
	const stages = useMemo<StageDefinition[]>(
		() =>
			pipelineCatalog?.stages.map((stage) => ({
				stageName: stage.id,
				label: stage.name,
				role: stage.role,
				group: stage.group,
				defaultConcurrency: stage.defaultConcurrency,
				maxConcurrency: stage.maxConcurrency ?? 128,
				disableable: stage.disableable,
				description: stage.description ?? stage.name,
			})) ?? [],
		[pipelineCatalog],
	);
	const stageGroups = useMemo(
		() =>
			Array.from(new Set(stages.map((stage) => stage.group))).map((group) => ({
				id: group,
				title: titleCase(group),
				description: `Stages in the ${titleCase(group)} group from scan-pipelines.yaml.`,
			})),
		[stages],
	);
	const enabledProfiles = useMemo(
		() => agentProfiles?.filter((profile) => profile.isEnabled) ?? [],
		[agentProfiles],
	);
	const selectedStage =
		stages.find((stage) => stage.stageName === selectedStageName) ?? null;
	const form = useForm<StageSettingsForm>({
		defaultValues: {
			agentProfileId: "",
			concurrency: 1,
		},
		resolver: zodResolver(StageSettingsFormSchema),
	});

	const batchForm = useForm<BatchEditForm>({
		defaultValues: { agentProfileId: "" },
		resolver: zodResolver(BatchEditFormSchema),
	});

	const allChecked =
		checkedStageNames.size === stages.length && stages.length > 0;
	const someChecked =
		checkedStageNames.size > 0 && checkedStageNames.size < stages.length;

	const toggleAll = (checked: boolean) => {
		setCheckedStageNames(
			checked ? new Set(stages.map((s) => s.stageName)) : new Set(),
		);
	};

	const toggleStage = (stageName: string, checked: boolean) => {
		setCheckedStageNames((prev) => {
			const next = new Set(prev);
			if (checked) next.add(stageName);
			else next.delete(stageName);
			return next;
		});
	};

	const toggleStageGroup = (
		group: StageDefinition["group"],
		checked: boolean,
	) => {
		const groupStageNames = stages.filter((stage) => stage.group === group).map(
			(stage) => stage.stageName,
		);
		setCheckedStageNames((prev) => {
			const next = new Set(prev);
			for (const stageName of groupStageNames) {
				if (checked) next.add(stageName);
				else next.delete(stageName);
			}
			return next;
		});
	};

	const rows = useMemo(
		() =>
			stages.map((stage) => {
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
		[target, enabledProfiles, stages],
	);

	const groupedRows = useMemo(
		() =>
			stageGroups.map((group) => {
				const groupRows = rows.filter((stage) => stage.group === group.id);
				const checkedCount = groupRows.filter((stage) =>
					checkedStageNames.has(stage.stageName),
				).length;
				return {
					...group,
					rows: groupRows,
					checkedCount,
					allChecked: checkedCount === groupRows.length && groupRows.length > 0,
					someChecked: checkedCount > 0 && checkedCount < groupRows.length,
				};
			}),
		[checkedStageNames, rows, stageGroups],
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

	if (isLoadingPipelineCatalog) {
		return (
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl flex items-center gap-2">
						<BotIcon className="size-5 text-muted-foreground" />
						Stage Agent Settings
					</CardTitle>
					<CardDescription>
						Loading scan stage catalog from scan-pipelines.yaml.
					</CardDescription>
				</CardHeader>
			</Card>
		);
	}

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
					Configure agent profile and concurrency per scan stage.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{checkedStageNames.size > 0 && (
					<div className="mb-5 flex flex-col gap-3 rounded-xl border bg-muted/30 p-3 sm:flex-row sm:items-center sm:justify-between">
						<div>
							<div className="text-sm font-medium">
								{checkedStageNames.size} stage
								{checkedStageNames.size > 1 ? "s" : ""} selected
							</div>
							<div className="text-xs text-muted-foreground">
								Apply one agent profile across selected stages; concurrency stays
								unchanged.
							</div>
						</div>
						<Button
							type="button"
							size="sm"
							onClick={() => {
								batchForm.reset({
									agentProfileId: enabledProfiles[0]?.agentProfileId ?? "",
								});
								setIsBatchEditOpen(true);
							}}
						>
							Edit Selected ({checkedStageNames.size})
						</Button>
					</div>
				)}
				<div className="mb-4 flex items-center justify-between rounded-lg border px-3 py-2">
					<div className="flex items-center gap-3">
						<Checkbox
							checked={allChecked || (someChecked ? "indeterminate" : false)}
							onCheckedChange={(v) => toggleAll(Boolean(v))}
							aria-label="Select all stages"
						/>
						<div>
							<div className="text-sm font-medium">All stages</div>
							<div className="text-xs text-muted-foreground">
								Select every visible stage for batch profile edits.
							</div>
						</div>
					</div>
					<Badge variant="secondary">{stages.length}</Badge>
				</div>

				<div className="grid gap-5">
					{groupedRows.map((group) => (
						<section key={group.id} className="rounded-2xl border bg-card p-4">
							<div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
								<div className="flex items-start gap-3">
									<Checkbox
										className="mt-1"
										checked={
											group.allChecked ||
											(group.someChecked ? "indeterminate" : false)
										}
										onCheckedChange={(v) =>
											toggleStageGroup(group.id, Boolean(v))
										}
										aria-label={`Select ${group.title}`}
									/>
									<div>
										<div className="flex flex-wrap items-center gap-2">
											<h3 className="font-semibold">{group.title}</h3>
											<Badge variant="outline">
												{group.rows.length} stages
											</Badge>
											{group.checkedCount > 0 ? (
												<Badge variant="secondary">
													{group.checkedCount} selected
												</Badge>
											) : null}
										</div>
										<p className="mt-1 text-sm text-muted-foreground">
											{group.description}
										</p>
									</div>
								</div>
							</div>

							<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
								{group.rows.map((stage) => (
									<div
										key={stage.stageName}
										className="rounded-xl border bg-background p-3 transition-colors hover:border-primary/40"
									>
										<div className="flex items-start justify-between gap-3">
											<div className="flex min-w-0 items-start gap-3">
												<Checkbox
													className="mt-1"
													checked={checkedStageNames.has(stage.stageName)}
													onCheckedChange={(v) =>
														toggleStage(stage.stageName, Boolean(v))
													}
													aria-label={`Select ${stage.label}`}
												/>
												<div className="min-w-0">
													<div className="truncate text-sm font-semibold">
														{stage.label}
													</div>
													{!stage.disableable ? (
														<Badge variant="secondary" className="mt-1">
															Required
														</Badge>
													) : null}
													<div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
														{stage.description}
													</div>
												</div>
											</div>
											<Button
												type="button"
												variant="secondary"
												size="sm"
												className="shrink-0"
												onClick={() => setSelectedStageName(stage.stageName)}
											>
												<Pencil className="size-4" />
											</Button>
										</div>
										<div className="mt-4 grid grid-cols-2 gap-2 text-xs">
											<div className="rounded-lg bg-muted/40 px-2 py-2">
												<div className="text-muted-foreground">Profile</div>
												<div className="mt-1 truncate font-medium">
													{stage.agentProfileName}
												</div>
											</div>
											<div className="rounded-lg bg-muted/40 px-2 py-2">
												<div className="text-muted-foreground">
													Concurrency
												</div>
												<div className="mt-1 font-medium">
													{stage.concurrency} / {stage.maxConcurrency}
												</div>
											</div>
										</div>
									</div>
								))}
							</div>
						</section>
					))}
				</div>

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

				<Dialog
					open={isBatchEditOpen}
					onOpenChange={(open) => {
						if (!open) setIsBatchEditOpen(false);
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>
								Edit {checkedStageNames.size} Stage
								{checkedStageNames.size > 1 ? "s" : ""}
							</DialogTitle>
							<DialogDescription>
								The selected agent profile will be applied to all selected
								stages. Each stage keeps its existing concurrency setting.
							</DialogDescription>
						</DialogHeader>
						<Form {...batchForm}>
							<form
								id="batch-stage-settings-form"
								onSubmit={batchForm.handleSubmit(async (values) => {
									if (!target) return;
									setIsSaving(true);
									try {
										const nextScanStageSettings = {
											...(target.scanStageSettings ?? {}),
										};
										for (const stageName of checkedStageNames) {
											nextScanStageSettings[stageName] = {
												...nextScanStageSettings[stageName],
												agentProfileId: values.agentProfileId,
											};
										}
										await onSave({ scanStageSettings: nextScanStageSettings });
										toast.success(
											`Agent profile applied to ${checkedStageNames.size} stage${checkedStageNames.size > 1 ? "s" : ""}`,
										);
										setIsBatchEditOpen(false);
										setCheckedStageNames(new Set());
									} catch {
										toast.error("Failed to update stage settings");
									} finally {
										setIsSaving(false);
									}
								})}
							>
								<FormField
									control={batchForm.control}
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
							</form>
						</Form>
						<DialogFooter>
							<Button
								type="button"
								variant="secondary"
								onClick={() => setIsBatchEditOpen(false)}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								form="batch-stage-settings-form"
								isLoading={isSaving}
							>
								Apply to {checkedStageNames.size} Stage
								{checkedStageNames.size > 1 ? "s" : ""}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</CardContent>
		</Card>
	);
};
