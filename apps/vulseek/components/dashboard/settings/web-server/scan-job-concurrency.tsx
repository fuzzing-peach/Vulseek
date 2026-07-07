"use client";

import { zodResolver } from "@hookform/resolvers/zod";
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
import { Input } from "@/components/ui/input";
import { api } from "@/utils/api";

const scanJobConcurrencySchema = z.object({
	scanJobConcurrency: z.coerce.number().int().min(1).max(16),
});

type ScanJobConcurrencySchema = z.infer<typeof scanJobConcurrencySchema>;

export const ScanJobConcurrency = () => {
	const utils = api.useUtils();
	const { data } = api.settings.getScanJobConcurrency.useQuery();
	const { mutateAsync, isLoading } =
		api.settings.updateScanJobConcurrency.useMutation();

	const form = useForm<ScanJobConcurrencySchema>({
		defaultValues: {
			scanJobConcurrency: data?.scanJobConcurrency ?? 1,
		},
		resolver: zodResolver(scanJobConcurrencySchema),
	});

	useEffect(() => {
		if (!data) {
			return;
		}

		form.reset({
			scanJobConcurrency: data.scanJobConcurrency ?? 1,
		});
	}, [data, form]);

	const onSubmit = async (values: ScanJobConcurrencySchema) => {
		await mutateAsync(values)
			.then(async () => {
				toast.success("Scan job concurrency updated successfully");
				await utils.settings.getScanJobConcurrency.invalidate();
			})
			.catch(() => {
				toast.error("Error updating scan job concurrency");
			});
	};

	return (
		<Card className="h-full">
			<CardHeader>
				<CardTitle>Scan Job Concurrency</CardTitle>
				<CardDescription>
					Maximum number of scan jobs allowed to run in parallel on this web
					server.
				</CardDescription>
			</CardHeader>
			<CardContent className="border-t pt-6">
				<Form {...form}>
					<form
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid gap-4"
					>
						<FormField
							control={form.control}
							name="scanJobConcurrency"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Parallel scan jobs</FormLabel>
									<FormControl>
										<Input
											type="number"
											min={1}
											max={16}
											step={1}
											{...field}
										/>
									</FormControl>
									<FormMessage />
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
			</CardContent>
		</Card>
	);
};
