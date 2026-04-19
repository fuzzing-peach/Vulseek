import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { AlertBlock } from "@/components/shared/alert-block";
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
import { Input } from "@/components/ui/input";
import { api } from "@/utils/api";

const updateScanContextHostPathSchema = z.object({
	scanContextHostPath: z.string().optional(),
});

type UpdateScanContextHostPath = z.infer<
	typeof updateScanContextHostPathSchema
>;

export const ScanContextHostPath = () => {
	const utils = api.useUtils();
	const { data } = api.settings.getScanContextHostPath.useQuery();
	const { mutateAsync, isLoading } =
		api.settings.updateScanContextHostPath.useMutation();

	const form = useForm<UpdateScanContextHostPath>({
		defaultValues: {
			scanContextHostPath: data?.scanContextHostPath ?? "",
		},
		resolver: zodResolver(updateScanContextHostPathSchema),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				scanContextHostPath: data.scanContextHostPath ?? "",
			});
		}
	}, [data, form, form.reset]);

	const onSubmit = async (formData: UpdateScanContextHostPath) => {
		await mutateAsync({
			scanContextHostPath: formData.scanContextHostPath || "",
		})
			.then(async () => {
				toast.success("Scan context host path updated successfully");
				await utils.settings.getScanContextHostPath.invalidate();
			})
			.catch((error) => {
				toast.error(error.message || "Error updating scan context host path");
			});
	};

	return (
		<Card className="h-full bg-sidebar p-2.5 rounded-xl max-w-5xl mx-auto w-full">
			<div className="rounded-xl bg-background shadow-md">
				<CardHeader>
					<CardTitle className="text-xl">Scan Context Host Path</CardTitle>
					<CardDescription>
						When set, scan, analysis, and verify containers use a host bind mount
						root instead of the shared Docker volume. Each container only mounts the
						current project/profile subdirectory.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4 py-6 border-t">
					<AlertBlock type="info">
						Example: <code>/data/vulseek-context</code>. Runtime data will be
						stored under <code>projects/&lt;project&gt;/profiles/&lt;profile&gt;/</code>
						 below this root.
					</AlertBlock>
					<Form {...form}>
						<form
							onSubmit={form.handleSubmit(onSubmit)}
							className="grid w-full gap-4"
						>
							<FormField
								control={form.control}
								name="scanContextHostPath"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Host path</FormLabel>
										<FormControl>
											<Input
												placeholder="/data/vulseek-context"
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
