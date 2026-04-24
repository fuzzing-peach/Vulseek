"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { PenBoxIcon, PlusIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
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
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

const Schema = z.object({
	name: z.string().min(1, { message: "Name is required" }),
	provider: z.enum(["codex", "claude_code"]),
	baseUrl: z.string().url({ message: "Please enter a valid URL" }),
	apiKey: z.string(),
	model: z.string().min(1, { message: "Model is required" }),
	thinkingLevel: z.string().min(1, { message: "Thinking level is required" }),
	isEnabled: z.boolean(),
});

type Schema = z.infer<typeof Schema>;

interface Props {
	agentProfileId?: string;
}

export const HandleAgentProfile = ({ agentProfileId }: Props) => {
	const utils = api.useUtils();
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const { data, refetch } = api.ai.agentProfileOne.useQuery(
		{
			agentProfileId: agentProfileId || "",
		},
		{
			enabled: !!agentProfileId,
		},
	);

	const { mutateAsync, isLoading } = agentProfileId
		? api.ai.updateAgentProfile.useMutation()
		: api.ai.createAgentProfile.useMutation();

	const form = useForm<Schema>({
		resolver: zodResolver(Schema),
		defaultValues: {
			name: "",
			provider: "codex",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "",
			model: "gpt-5.4",
			thinkingLevel: "medium",
			isEnabled: true,
		},
	});

	const provider = useWatch({
		control: form.control,
		name: "provider",
	});

	useEffect(() => {
		form.reset({
			name: data?.name ?? "",
			provider: data?.provider ?? "codex",
			baseUrl: data?.baseUrl ?? "https://api.openai.com/v1",
			apiKey: data?.apiKey ?? "",
			model: data?.model ?? "gpt-5.4",
			thinkingLevel: data?.thinkingLevel ?? "medium",
			isEnabled: data?.isEnabled ?? true,
		});
	}, [data, form]);

	useEffect(() => {
		if (provider === "claude_code" && !agentProfileId && !data?.baseUrl) {
			form.setValue("baseUrl", "https://api.anthropic.com");
			form.setValue("model", "claude-sonnet-4-5");
		}
		if (provider === "codex" && !agentProfileId && !data?.baseUrl) {
			form.setValue("baseUrl", "https://api.openai.com/v1");
			form.setValue("model", "gpt-5.4");
		}
	}, [agentProfileId, data?.baseUrl, form, provider]);

	const onSubmit = async (values: Schema) => {
		try {
			await mutateAsync({
				...values,
				agentProfileId: agentProfileId || "",
			});
			await utils.ai.getAgentProfiles.invalidate();
			toast.success("Agent profile saved successfully");
			refetch();
			setOpen(false);
		} catch (error) {
			setError(error instanceof Error ? error.message : "Unknown error");
			toast.error("Failed to save agent profile", {
				description: error instanceof Error ? error.message : "Unknown error",
			});
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{agentProfileId ? (
					<Button
						variant="ghost"
						size="icon"
						className="group hover:bg-blue-500/10"
					>
						<PenBoxIcon className="size-3.5 text-primary group-hover:text-blue-500" />
					</Button>
				) : (
					<Button className="cursor-pointer space-x-3">
						<PlusIcon className="h-4 w-4" />
						Add Agent Profile
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{agentProfileId ? "Edit Agent Profile" : "Add Agent Profile"}
					</DialogTitle>
					<DialogDescription>
						Configure a reusable agent runtime profile
					</DialogDescription>
				</DialogHeader>
				<Form {...form}>
					{error && <AlertBlock type="error">{error}</AlertBlock>}
					<form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
						<FormField
							control={form.control}
							name="name"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Name</FormLabel>
									<FormControl>
										<Input placeholder="Codex Default" {...field} />
									</FormControl>
									<FormDescription>
										A reusable profile name shown in project settings
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="provider"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Agent</FormLabel>
									<Select onValueChange={field.onChange} value={field.value}>
										<FormControl>
											<SelectTrigger>
												<SelectValue placeholder="Select an agent" />
											</SelectTrigger>
										</FormControl>
										<SelectContent>
											<SelectItem value="codex">Codex</SelectItem>
											<SelectItem value="claude_code">Claude Code</SelectItem>
										</SelectContent>
									</Select>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="baseUrl"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Base URL</FormLabel>
									<FormControl>
										<Input placeholder="https://api.openai.com/v1" {...field} />
									</FormControl>
									<FormDescription>
										Used when Dokploy prepares the agent runtime config
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="apiKey"
							render={({ field }) => (
								<FormItem>
									<FormLabel>API Key</FormLabel>
									<FormControl>
										<Input
											type="password"
											placeholder="sk-..."
											autoComplete="one-time-code"
											{...field}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="model"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Model</FormLabel>
									<FormControl>
										<Input placeholder="gpt-5.4" {...field} />
									</FormControl>
									<FormDescription>
										The model name used by the selected agent runtime
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="thinkingLevel"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Thinking Level</FormLabel>
									<FormControl>
										<Input placeholder="medium" {...field} />
									</FormControl>
									<FormDescription>
										Examples: low, medium, high
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="isEnabled"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
									<div className="space-y-0.5">
										<FormLabel>Enabled</FormLabel>
										<FormDescription>
											Disabled profiles stay saved but cannot be selected
										</FormDescription>
									</div>
									<FormControl>
										<Switch
											checked={field.value}
											onCheckedChange={field.onChange}
										/>
									</FormControl>
								</FormItem>
							)}
						/>

						<div className="flex justify-end">
							<Button isLoading={isLoading} type="submit">
								Save
							</Button>
						</div>
					</form>
				</Form>
			</DialogContent>
		</Dialog>
	);
};
