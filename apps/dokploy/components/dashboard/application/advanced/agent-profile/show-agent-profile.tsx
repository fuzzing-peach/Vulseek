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
	agentProfileId: z.string(),
});

type Schema = z.infer<typeof Schema>;

interface Props {
	applicationId: string;
}

export const ShowAgentProfile = ({ applicationId }: Props) => {
	const { data } = api.application.one.useQuery(
		{
			applicationId,
		},
		{ enabled: !!applicationId },
	);
	const { data: agentProfiles } = api.ai.getAgentProfiles.useQuery();
	const utils = api.useUtils();
	const { mutateAsync, isLoading } = api.application.update.useMutation();

	const enabledProfiles =
		agentProfiles?.filter((profile) => profile.isEnabled) ?? [];

	const form = useForm<Schema>({
		defaultValues: {
			agentProfileId: "none",
		},
		resolver: zodResolver(Schema),
	});

	useEffect(() => {
		form.reset({
			agentProfileId: data?.agentProfileId || "none",
		});
	}, [data?.agentProfileId, form]);

	const onSubmit = async (values: Schema) => {
		await mutateAsync({
			applicationId,
			agentProfileId:
				values.agentProfileId === "none" ? null : values.agentProfileId,
		})
			.then(async () => {
				toast.success("Agent profile updated");
				await utils.application.one.invalidate({ applicationId });
			})
			.catch(() => {
				toast.error("Failed to update agent profile");
			});
	};

	return (
		<Card className="bg-background">
			<CardHeader>
				<CardTitle className="text-xl flex items-center gap-2">
					<BotIcon className="size-5 text-muted-foreground" />
					Agent Profile
				</CardTitle>
				<CardDescription>
					Select the reusable agent profile used by this profile's scanning
					runtime.
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
								name="agentProfileId"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Agent Profile</FormLabel>
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
