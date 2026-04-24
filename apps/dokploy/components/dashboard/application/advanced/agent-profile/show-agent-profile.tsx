"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { BotIcon } from "lucide-react";
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

const ScanSettingsSchema = z.object({
	scanAgentProfileId: z.string(),
	fullScanModuleConcurrency: z.coerce.number().int().min(1).max(32),
	fullScanFunctionConcurrency: z.coerce.number().int().min(1).max(64),
});

const AnalysisSettingsSchema = z.object({
	analysisAgentProfileId: z.string(),
	analysisConcurrency: z.coerce.number().int().min(1).max(16),
});

const VerificationSettingsSchema = z.object({
	verifierAgentProfileId: z.string(),
	verifyConcurrency: z.coerce.number().int().min(1).max(16),
});

type ScanSettingsSchema = z.infer<typeof ScanSettingsSchema>;
type AnalysisSettingsSchema = z.infer<typeof AnalysisSettingsSchema>;
type VerificationSettingsSchema = z.infer<typeof VerificationSettingsSchema>;

interface Props {
	applicationId: string;
}

export const ShowAgentProfile = ({ applicationId }: Props) => {
	const { data } = api.application.one.useQuery(
		{ applicationId },
		{ enabled: !!applicationId },
	);
	const { data: agentProfiles } = api.ai.getAgentProfiles.useQuery();
	const utils = api.useUtils();
	const { mutateAsync } = api.application.update.useMutation();
	const [savingSection, setSavingSection] = useState<
		"scan" | "analysis" | "verification" | null
	>(null);

	const enabledProfiles =
		agentProfiles?.filter((profile) => profile.isEnabled) ?? [];
	const defaultAgentProfile = useMemo(
		() =>
			enabledProfiles.find(
				(profile) => profile.agentProfileId === data?.agentProfileId,
			) ||
			enabledProfiles[0] ||
			null,
		[enabledProfiles, data?.agentProfileId],
	);
	const resolveAgentProfileFieldValue = (
		stageAgentProfileId?: string | null,
	) =>
		stageAgentProfileId || defaultAgentProfile?.agentProfileId || "";

	const scanForm = useForm<ScanSettingsSchema>({
		defaultValues: {
			scanAgentProfileId: "",
			fullScanModuleConcurrency: 4,
			fullScanFunctionConcurrency: 4,
		},
		resolver: zodResolver(ScanSettingsSchema),
	});

	const analysisForm = useForm<AnalysisSettingsSchema>({
		defaultValues: {
			analysisAgentProfileId: "",
			analysisConcurrency: 2,
		},
		resolver: zodResolver(AnalysisSettingsSchema),
	});

	const verificationForm = useForm<VerificationSettingsSchema>({
		defaultValues: {
			verifierAgentProfileId: "",
			verifyConcurrency: 1,
		},
		resolver: zodResolver(VerificationSettingsSchema),
	});

	useEffect(() => {
		scanForm.reset({
			scanAgentProfileId: resolveAgentProfileFieldValue(data?.scanAgentProfileId),
			fullScanModuleConcurrency: data?.fullScanModuleConcurrency ?? 4,
			fullScanFunctionConcurrency: data?.fullScanFunctionConcurrency ?? 4,
		});
		analysisForm.reset({
			analysisAgentProfileId: resolveAgentProfileFieldValue(
				data?.analysisAgentProfileId,
			),
			analysisConcurrency: data?.analysisConcurrency ?? 2,
		});
		verificationForm.reset({
			verifierAgentProfileId: resolveAgentProfileFieldValue(
				data?.verifierAgentProfileId,
			),
			verifyConcurrency: data?.verifyConcurrency ?? 1,
		});
	}, [
		data?.scanAgentProfileId,
		data?.analysisAgentProfileId,
		data?.verifierAgentProfileId,
		data?.agentProfileId,
		data?.verifyConcurrency,
		data?.analysisConcurrency,
		data?.fullScanModuleConcurrency,
		data?.fullScanFunctionConcurrency,
		scanForm,
		analysisForm,
		verificationForm,
		data?.agentProfileId,
	]);

	const saveSettings = async (
		section: "scan" | "analysis" | "verification",
		payload: Parameters<typeof mutateAsync>[0],
		successMessage: string,
		errorMessage: string,
	) => {
		setSavingSection(section);
		try {
			await mutateAsync(payload);
			toast.success(successMessage);
			await utils.application.one.invalidate({ applicationId });
		} catch {
			toast.error(errorMessage);
		} finally {
			setSavingSection(null);
		}
	};

	const renderAgentProfileField = ({
		control,
		name,
		label,
		description,
	}: {
		control: any;
		name: string;
		label: string;
		description?: string;
	}) => (
		<FormField
			control={control}
			name={name}
			render={({ field }) => (
				<FormItem>
					<FormLabel>{label}</FormLabel>
					<Select onValueChange={field.onChange} value={field.value}>
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
					{description ? <FormDescription>{description}</FormDescription> : null}
					<FormMessage />
				</FormItem>
			)}
		/>
	);

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
		<div className="grid gap-4 lg:grid-cols-3">
			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl flex items-center gap-2">
						<BotIcon className="size-5 text-muted-foreground" />
						Scan
					</CardTitle>
					<CardDescription>
						Configure repository scanning agent profile and full-scan worker concurrency.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Form {...scanForm}>
						<form
							onSubmit={scanForm.handleSubmit(async (values) => {
								await saveSettings(
									"scan",
									{
										applicationId,
										scanAgentProfileId: values.scanAgentProfileId,
										fullScanModuleConcurrency: values.fullScanModuleConcurrency,
										fullScanFunctionConcurrency: values.fullScanFunctionConcurrency,
									},
									"Scan settings updated",
									"Failed to update scan settings",
								);
							})}
							className="grid gap-4"
						>
							{renderAgentProfileField({
								control: scanForm.control,
								name: "scanAgentProfileId",
								label: "Scan Agent Profile",
							})}
							<FormField
								control={scanForm.control}
								name="fullScanModuleConcurrency"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Full Scan Module Concurrency</FormLabel>
										<FormControl>
											<Input type="number" min={1} max={32} step={1} {...field} />
										</FormControl>
										<FormDescription>
											Maximum number of module-scanner tasks running in parallel.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={scanForm.control}
								name="fullScanFunctionConcurrency"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Full Scan Function Concurrency</FormLabel>
										<FormControl>
											<Input type="number" min={1} max={64} step={1} {...field} />
										</FormControl>
										<FormDescription>
											Maximum number of function-scanner tasks running in parallel.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							<div className="flex justify-end">
								<Button
									isLoading={savingSection === "scan"}
									type="submit"
									className="w-fit"
								>
									Save
								</Button>
							</div>
						</form>
					</Form>
				</CardContent>
			</Card>

			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl flex items-center gap-2">
						<BotIcon className="size-5 text-muted-foreground" />
						Analysis
					</CardTitle>
					<CardDescription>
						Configure the candidate analysis agent profile.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Form {...analysisForm}>
						<form
							onSubmit={analysisForm.handleSubmit(async (values) => {
								await saveSettings(
									"analysis",
									{
										applicationId,
										analysisAgentProfileId: values.analysisAgentProfileId,
										analysisConcurrency: values.analysisConcurrency,
									},
									"Analysis settings updated",
									"Failed to update analysis settings",
								);
							})}
							className="grid gap-4"
						>
							{renderAgentProfileField({
								control: analysisForm.control,
								name: "analysisAgentProfileId",
								label: "Analysis Agent Profile",
							})}
							<FormField
								control={analysisForm.control}
								name="analysisConcurrency"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Analysis Concurrency</FormLabel>
										<FormControl>
											<Input type="number" min={1} max={16} step={1} {...field} />
										</FormControl>
										<FormDescription>
											Maximum number of analysis agents allowed to run in parallel for this target.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							<div className="flex justify-end">
								<Button
									isLoading={savingSection === "analysis"}
									type="submit"
									className="w-fit"
								>
									Save
								</Button>
							</div>
						</form>
					</Form>
				</CardContent>
			</Card>

			<Card className="bg-background">
				<CardHeader>
					<CardTitle className="text-xl flex items-center gap-2">
						<BotIcon className="size-5 text-muted-foreground" />
						Verification
					</CardTitle>
					<CardDescription>
						Configure verifier profile and verification concurrency.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Form {...verificationForm}>
						<form
							onSubmit={verificationForm.handleSubmit(async (values) => {
								await saveSettings(
									"verification",
									{
										applicationId,
										verifierAgentProfileId: values.verifierAgentProfileId,
										verifyConcurrency: values.verifyConcurrency,
									},
									"Verification settings updated",
									"Failed to update verification settings",
								);
							})}
							className="grid gap-4"
						>
							{renderAgentProfileField({
								control: verificationForm.control,
								name: "verifierAgentProfileId",
								label: "Verifier Agent Profile",
							})}
							<FormField
								control={verificationForm.control}
								name="verifyConcurrency"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Verify Concurrency</FormLabel>
										<FormControl>
											<Input type="number" min={1} max={16} step={1} {...field} />
										</FormControl>
										<FormDescription>
											Maximum number of verifier agents allowed to run in parallel for this target.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
							<div className="flex justify-end">
								<Button
									isLoading={savingSection === "verification"}
									type="submit"
									className="w-fit"
								>
									Save
								</Button>
							</div>
						</form>
					</Form>
				</CardContent>
			</Card>
		</div>
	);
};
