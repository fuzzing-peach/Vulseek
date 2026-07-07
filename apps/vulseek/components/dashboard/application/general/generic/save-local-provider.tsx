import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
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
import { api } from "@/utils/api";

const LocalProviderSchema = z.object({
	localPath: z
		.string()
		.min(1, "Path is required")
		.regex(/^\//, "Must be an absolute path (start with /)"),
});

type LocalProvider = z.infer<typeof LocalProviderSchema>;

interface Props {
	applicationId: string;
}

export const SaveLocalProvider = ({ applicationId }: Props) => {
	const { data, refetch } = api.application.one.useQuery({ applicationId });

	const { mutateAsync, isLoading } =
		api.application.saveLocalProvider.useMutation();

	const form = useForm<LocalProvider>({
		defaultValues: {
			localPath: "",
		},
		resolver: zodResolver(LocalProviderSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				localPath: data.localPath || "",
			});
		}
	}, [form.reset, data, form]);

	const onSubmit = async (values: LocalProvider) => {
		await mutateAsync({
			localPath: values.localPath,
			applicationId,
		})
			.then(async () => {
				toast.success("Local Provider Saved");
				await refetch();
			})
			.catch(() => {
				toast.error("Error saving the Local provider");
			});
	};

	return (
		<Form {...form}>
			<form
				onSubmit={form.handleSubmit(onSubmit)}
				className="flex flex-col gap-4"
			>
				<FormField
					control={form.control}
					name="localPath"
					render={({ field }) => (
						<FormItem>
							<FormLabel>Local Path</FormLabel>
							<FormControl>
								<Input placeholder="/path/to/your/repo" {...field} />
							</FormControl>
							<FormDescription>
								Absolute path to a directory on the host machine. The directory
								will be copied into the scan image instead of cloning a git
								repository.
							</FormDescription>
							<FormMessage />
						</FormItem>
					)}
				/>

				<div className="flex justify-end">
					<Button type="submit" className="w-full sm:w-fit" isLoading={isLoading}>
						Save
					</Button>
				</div>
			</form>
		</Form>
	);
};
