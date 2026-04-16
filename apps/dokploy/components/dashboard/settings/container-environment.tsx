import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
import { CodeEditor } from "@/components/shared/code-editor";
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
import { api } from "@/utils/api";

const updateContainerEnvironmentSchema = z.object({
	containerEnvironment: z.string().optional(),
});

type UpdateContainerEnvironment = z.infer<
	typeof updateContainerEnvironmentSchema
>;

export const ContainerEnvironment = () => {
	const utils = api.useUtils();
	const { data } = api.settings.getContainerEnvironment.useQuery();
	const { mutateAsync, isLoading } =
		api.settings.updateContainerEnvironment.useMutation();

	const form = useForm<UpdateContainerEnvironment>({
		defaultValues: {
			containerEnvironment: data?.containerEnvironment ?? "",
		},
		resolver: zodResolver(updateContainerEnvironmentSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				containerEnvironment: data.containerEnvironment ?? "",
			});
		}
	}, [data, form, form.reset]);

	const onSubmit = async (formData: UpdateContainerEnvironment) => {
		await mutateAsync({
			containerEnvironment: formData.containerEnvironment || "",
		})
			.then(async () => {
				toast.success("Container environment updated successfully");
				await utils.settings.getContainerEnvironment.invalidate();
			})
			.catch(() => {
				toast.error("Error updating container environment");
			});
	};

	return (
		<Card className="h-full bg-sidebar  p-2.5 rounded-xl  max-w-5xl mx-auto w-full">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader>
					<CardTitle className="text-xl">Container Environment</CardTitle>
					<CardDescription>
						Variables here are injected into every started container and every
						Docker build as environment variables or build args.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4 py-6 border-t">
					<AlertBlock type="info">
						Use dotenv format, one variable per line. Example:{" "}
						<code>HTTP_PROXY=http://172.17.0.1:7890</code>
					</AlertBlock>
					<Form {...form}>
						<form
							onSubmit={form.handleSubmit(onSubmit)}
							className="grid w-full gap-4"
						>
							<FormField
								control={form.control}
								name="containerEnvironment"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Environment variables</FormLabel>
										<FormControl>
											<CodeEditor
												lineWrapping
												language="properties"
												wrapperClassName="h-[20rem] font-mono"
												placeholder={`HTTP_PROXY=http://172.17.0.1:7890
HTTPS_PROXY=http://172.17.0.1:7890
NO_PROXY=localhost,127.0.0.1`}
												{...field}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<div className="flex justify-end">
								<Button isLoading={isLoading} type="submit">
									Update
								</Button>
							</div>
						</form>
					</Form>
				</CardContent>
			</div>
		</Card>
	);
};
