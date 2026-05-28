"use client";
import { zodResolver } from "@hookform/resolvers/zod";
import { PenBoxIcon, PlusIcon } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

const Schema = z.object({
	name: z.string().min(1, { message: "Name is required" }),
	provider: z.enum(["codex", "claude_code"]),
	codexAuthMode: z.enum(["api_key", "codex_home"]),
	codexHomePath: z.string(),
	baseUrl: z.string().url({ message: "Please enter a valid URL" }),
	apiKey: z.string(),
	model: z.string().min(1, { message: "Model is required" }),
	thinkingLevel: z.string().min(1, { message: "Thinking level is required" }),
	thinkingLevelEnabled: z.boolean(),
	envs: z.string(),
	isEnabled: z.boolean(),
});

type Schema = z.infer<typeof Schema>;

interface Props {
	agentProfileId?: string;
}

const renderEnvHighlight = (value: string) => {
	const lines = value.length > 0 ? value.split("\n") : [""];

	return lines.map((line, index) => {
		const separatorIndex = line.indexOf("=");
		const hasSeparator = separatorIndex >= 0;
		const key = hasSeparator ? line.slice(0, separatorIndex) : line;
		const envValue = hasSeparator ? line.slice(separatorIndex + 1) : "";

		return (
			<Fragment key={`${index}-${line}`}>
				<span className="font-semibold text-blue-700 dark:text-blue-300">
					{key || " "}
				</span>
				{hasSeparator ? (
					<span className="font-semibold text-foreground">=</span>
				) : null}
				{hasSeparator ? (
					<span className="font-semibold text-rose-700 dark:text-rose-300">
						{envValue || " "}
					</span>
				) : null}
				{index < lines.length - 1 ? "\n" : null}
			</Fragment>
		);
	});
};

export const HandleAgentProfile = ({ agentProfileId }: Props) => {
	const utils = api.useUtils();
	const [error, setError] = useState<string | null>(null);
	const [open, setOpen] = useState(false);
	const envTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const envHighlightRef = useRef<HTMLPreElement | null>(null);
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
			codexAuthMode: "api_key",
			codexHomePath: "",
			baseUrl: "https://api.openai.com/v1",
			apiKey: "",
			model: "gpt-5.4",
			thinkingLevel: "medium",
			thinkingLevelEnabled: true,
			envs: "",
			isEnabled: true,
		},
	});

	const provider = useWatch({
		control: form.control,
		name: "provider",
	});
	const codexAuthMode = useWatch({
		control: form.control,
		name: "codexAuthMode",
	});
	const envsValue = useWatch({
		control: form.control,
		name: "envs",
	});
	const thinkingLevelEnabled = useWatch({
		control: form.control,
		name: "thinkingLevelEnabled",
	});
	const envHighlight = useMemo(
		() => renderEnvHighlight(envsValue || ""),
		[envsValue],
	);
	const showEnvPlaceholder = !envsValue;

	useEffect(() => {
		form.reset({
			name: data?.name ?? "",
			provider: data?.provider ?? "codex",
			codexAuthMode: data?.codexAuthMode ?? "api_key",
			codexHomePath: data?.codexHomePath ?? "",
			baseUrl: data?.baseUrl ?? "https://api.openai.com/v1",
			apiKey: data?.apiKey ?? "",
			model: data?.model ?? "gpt-5.4",
			thinkingLevel: data?.thinkingLevel ?? "medium",
			thinkingLevelEnabled: data?.thinkingLevelEnabled ?? true,
			envs: data?.envs ?? "",
			isEnabled: data?.isEnabled ?? true,
		});
	}, [data, form]);

	useEffect(() => {
		if (provider === "claude_code" && !agentProfileId && !data?.baseUrl) {
			form.setValue("codexAuthMode", "api_key");
			form.setValue("baseUrl", "https://api.anthropic.com");
			form.setValue("model", "claude-sonnet-4-5");
		}
		if (provider === "codex" && !agentProfileId && !data?.baseUrl) {
			form.setValue("baseUrl", "https://api.openai.com/v1");
			form.setValue("model", "gpt-5.4");
		}
	}, [agentProfileId, data?.baseUrl, form, provider]);

	useEffect(() => {
		const textarea = envTextareaRef.current;
		const highlight = envHighlightRef.current;
		if (!textarea || !highlight) return;

		const syncScroll = () => {
			highlight.scrollTop = textarea.scrollTop;
			highlight.scrollLeft = textarea.scrollLeft;
		};

		syncScroll();
		textarea.addEventListener("scroll", syncScroll);
		return () => textarea.removeEventListener("scroll", syncScroll);
	}, [open]);

	const onSubmit = async (values: Schema) => {
		try {
			await mutateAsync({
				...values,
				codexAuthMode:
					values.provider === "codex" ? values.codexAuthMode : "api_key",
				codexHomePath:
					values.provider === "codex" ? values.codexHomePath.trim() : "",
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

						{provider === "codex" && (
							<FormField
								control={form.control}
								name="codexAuthMode"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Codex Auth</FormLabel>
										<Select onValueChange={field.onChange} value={field.value}>
											<FormControl>
												<SelectTrigger>
													<SelectValue placeholder="Select Codex auth" />
												</SelectTrigger>
											</FormControl>
											<SelectContent>
												<SelectItem value="api_key">API Key</SelectItem>
												<SelectItem value="codex_home">
													Copy Codex Home
												</SelectItem>
											</SelectContent>
										</Select>
										<FormDescription>
											Copy Codex Home bind-mounts the host path below into each
											task container.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						)}

						{provider === "codex" && codexAuthMode === "codex_home" ? (
							<FormField
								control={form.control}
								name="codexHomePath"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Codex Home Path</FormLabel>
										<FormControl>
											<Input placeholder="/home/user/.codex" {...field} />
										</FormControl>
										<FormDescription>
											Absolute path on the Docker host that contains Codex
											auth.json and config.toml.
										</FormDescription>
										<FormMessage />
									</FormItem>
								)}
							/>
						) : null}

						{provider !== "codex" || codexAuthMode === "api_key" ? (
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
						) : null}

						{provider !== "codex" || codexAuthMode === "api_key" ? (
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
						) : (
							<AlertBlock type="info">
								Dokploy will copy this Codex home into each task container
								instead of writing an API key.
							</AlertBlock>
						)}

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
							name="thinkingLevelEnabled"
							render={({ field }) => (
								<FormItem className="flex flex-row items-center justify-between rounded-lg border p-3">
									<div className="space-y-0.5">
										<FormLabel>Send Thinking Level</FormLabel>
										<FormDescription>
											Pass this value to the agent runtime when the selected
											agent supports it
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

						<FormField
							control={form.control}
							name="thinkingLevel"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Thinking Level</FormLabel>
									<FormControl>
										<Input
											placeholder="medium"
											disabled={!thinkingLevelEnabled}
											{...field}
										/>
									</FormControl>
									<FormDescription>
										Examples: low, medium, high. Saved with the profile even
										when disabled.
									</FormDescription>
									<FormMessage />
								</FormItem>
							)}
						/>

						<FormField
							control={form.control}
							name="envs"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Environment Variables</FormLabel>
									<FormControl>
										<div className="relative">
											<pre
												ref={envHighlightRef}
												aria-hidden="true"
												className="pointer-events-none min-h-[120px] overflow-auto whitespace-pre-wrap break-all rounded-md border border-input bg-input px-3 py-2 font-mono text-xs leading-5"
											>
												{showEnvPlaceholder ? (
													<span className="text-muted-foreground">
														{"FOO=bar\nHTTP_PROXY=http://host:port"}
													</span>
												) : (
													envHighlight
												)}
											</pre>
											<Textarea
												placeholder={"FOO=bar\nHTTP_PROXY=http://host:port"}
												className="absolute inset-0 min-h-[120px] resize-y overflow-auto border-transparent bg-transparent font-mono text-xs leading-5 text-transparent caret-foreground selection:bg-primary/30 focus-visible:ring-2 focus-visible:ring-border"
												{...field}
												ref={(element) => {
													field.ref(element);
													envTextareaRef.current = element;
												}}
												spellCheck={false}
											/>
										</div>
									</FormControl>
									<FormDescription>
										One <code>KEY=VALUE</code> per line. These env vars are injected into the agent runtime container.
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
