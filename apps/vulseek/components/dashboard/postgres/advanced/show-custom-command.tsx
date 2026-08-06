import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	FormActions,
	FormSection,
	useFormSaveStatus,
} from "@/components/dashboard/ui-system";
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
import type { ServiceType } from "../../application/advanced/show-resources";

const addDockerImage = z.object({
	dockerImage: z.string().min(1, "Docker image is required"),
	command: z.string(),
});

interface Props {
	id: string;
	type: Exclude<ServiceType, "application">;
}

type AddDockerImage = z.infer<typeof addDockerImage>;
export const ShowCustomCommand = ({ id, type }: Props) => {
	const queryMap = {
		postgres: () =>
			api.postgres.one.useQuery({ postgresId: id }, { enabled: !!id }),
		redis: () => api.redis.one.useQuery({ redisId: id }, { enabled: !!id }),
		mysql: () => api.mysql.one.useQuery({ mysqlId: id }, { enabled: !!id }),
		mariadb: () =>
			api.mariadb.one.useQuery({ mariadbId: id }, { enabled: !!id }),
		application: () =>
			api.application.one.useQuery({ applicationId: id }, { enabled: !!id }),
		mongo: () => api.mongo.one.useQuery({ mongoId: id }, { enabled: !!id }),
	};
	const { data, refetch } = queryMap[type]
		? queryMap[type]()
		: api.mongo.one.useQuery({ mongoId: id }, { enabled: !!id });

	const mutationMap = {
		postgres: () => api.postgres.update.useMutation(),
		redis: () => api.redis.update.useMutation(),
		mysql: () => api.mysql.update.useMutation(),
		mariadb: () => api.mariadb.update.useMutation(),
		application: () => api.application.update.useMutation(),
		mongo: () => api.mongo.update.useMutation(),
	};

	const { mutateAsync } = mutationMap[type]
		? mutationMap[type]()
		: api.mongo.update.useMutation();

	const form = useForm<AddDockerImage>({
		defaultValues: {
			dockerImage: "",
			command: "",
		},
		resolver: zodResolver(addDockerImage),
	});

	useEffect(() => {
		if (data) {
			form.reset({
				dockerImage: data.dockerImage,
				command: data.command || "",
			});
		}
	}, [data, form, form.reset]);

	const [status, setStatus] = useFormSaveStatus(form.formState.isDirty);

	const onSubmit = async (formData: AddDockerImage) => {
		setStatus("saving");
		try {
			await mutateAsync({
				mongoId: id || "",
				postgresId: id || "",
				redisId: id || "",
				mysqlId: id || "",
				mariadbId: id || "",
				dockerImage: formData?.dockerImage,
				command: formData?.command,
			});
			setStatus("saved");
			toast.success("Custom Command Updated");
			await refetch();
		} catch {
			setStatus("error");
			toast.error("Error updating the custom command");
		}
	};

	const handleSave = () => {
		void form.handleSubmit(onSubmit, () => setStatus("error"))();
	};

	return (
		<FormSection
			title="Custom Command"
			description="Override the docker image and the startup command used to run this service."
		>
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit, () => setStatus("error"))}
					className="grid w-full gap-4"
				>
					<div className="grid w-full gap-4">
						<FormField
							control={form.control}
							name="dockerImage"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Docker Image</FormLabel>
									<FormControl>
										<Input placeholder="postgres:15" {...field} />
									</FormControl>

									<FormMessage />
								</FormItem>
							)}
						/>
					</div>
					<FormField
						control={form.control}
						name="command"
						render={({ field }) => (
							<FormItem>
								<FormLabel>Command</FormLabel>
								<FormControl>
									<Input placeholder="Custom command" {...field} />
								</FormControl>

								<FormMessage />
							</FormItem>
						)}
					/>
					<FormActions
						status={status}
						onSave={handleSave}
						onReset={() => form.reset()}
					/>
				</form>
			</Form>
		</FormSection>
	);
};
