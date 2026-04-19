"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { BotIcon } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
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
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

const Schema = z.object({
	scanAgentProfileId: z.string(),
	analysisAgentProfileId: z.string(),
	verifierAgentProfileId: z.string(),
});

type Schema = z.infer<typeof Schema>;

interface Props {
	composeId: string;
}

export const ShowComposeAgentProfile = ({ composeId }: Props) => {
	const { data } = api.compose.one.useQuery(
		{
			composeId,
		},
		{ enabled: !!composeId },
	);
	const { data: agentProfiles } = api.ai.getAgentProfiles.useQuery();
	const utils = api.useUtils();
	const { mutateAsync, isLoading } = api.compose.update.useMutation();

	const enabledProfiles =
		agentProfiles?.filter((profile) => profile.isEnabled) ?? [];

	const form = useForm<Schema>({
		defaultValues: {
			scanAgentProfileId: "none",
			analysisAgentProfileId: "none",
			verifierAgentProfileId: "none",
		},
		resolver: zodResolver(Schema),
	});

	useEffect(() => {
		form.reset({
			scanAgentProfileId: data?.scanAgentProfileId || "none",
			analysisAgentProfileId: data?.analysisAgentProfileId || "none",
			verifierAgentProfileId: data?.verifierAgentProfileId || "none",
		});
	}, [
		data?.scanAgentProfileId,
		data?.analysisAgentProfileId,
		data?.verifierAgentProfileId,
		form,
	]);

	const onSubmit = async (values: Schema) => {
		await mutateAsync({
			composeId,
			scanAgentProfileId:
				values.scanAgentProfileId === "none"
					? null
					: values.scanAgentProfileId,
			analysisAgentProfileId:
				values.analysisAgentProfileId === "none"
					? null
					: values.analysisAgentProfileId,
			verifierAgentProfileId:
				values.verifierAgentProfileId === "none"
					? null
					: values.verifierAgentProfileId,
		})
			.then(async () => {
				toast.success("Agent profiles updated");
				await utils.compose.one.invalidate({ composeId });
			})
			.catch(() => {
				toast.error("Failed to update agent profiles");
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl flex items-center gap-2">
					<BotIcon className="size-5 text-muted-foreground" />
					Agent Profiles
				</CardTitle>
				<CardDescription>
					Select reusable agent profiles for scan generation, candidate
					analysis, and verification.
				</CardDescription>
			</CardHeader>
			<CardContent className="flex flex-col gap-4">
				{enabledProfiles.length === 0 ? (
					<div className="text-sm text-muted-foreground">
						No enabled agent profile found. Create one in{" "}
						<Link href="/dashboard/settings/ai" className="text-primary">
							AI Settings
						</Link>
						.
					</div>
				) : (
					<Form {...form}>
						<form
							onSubmit={form.handleSubmit(onSubmit)}
							className="grid w-full gap-4"
						>
							<FormField
								control={form.control}
								name="scanAgentProfileId"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Scan Agent Profile</FormLabel>
										<Select onValueChange={field.onChange} value={field.value}>
											<FormControl>
												<SelectTrigger>
													<SelectValue placeholder="Select an agent profile" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectItem value="none">None</SelectItem>
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
								name="analysisAgentProfileId"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Analysis Agent Profile</FormLabel>
										<Select onValueChange={field.onChange} value={field.value}>
											<FormControl>
												<SelectTrigger>
													<SelectValue placeholder="Select an agent profile" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectItem value="none">None</SelectItem>
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
								name="verifierAgentProfileId"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Verifier Agent Profile</FormLabel>
										<Select onValueChange={field.onChange} value={field.value}>
											<FormControl>
												<SelectTrigger>
													<SelectValue placeholder="Select an agent profile" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectItem value="none">None</SelectItem>
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
							<div className="flex justify-end">
								<Button isLoading={isLoading} type="submit" className="w-fit">
									Save
								</Button>
							</div>
						</form>
					</Form>
				)}
			</CardContent>
		</Card>
	);
};
