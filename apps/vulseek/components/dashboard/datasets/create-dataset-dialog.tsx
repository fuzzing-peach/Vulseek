import { Database, Loader2 } from "lucide-react";
import { useRouter } from "next/router";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

type CreateDatasetDialogProps = { trigger?: "menu" | "button" };

export const CreateDatasetDialog = ({
	trigger = "button",
}: CreateDatasetDialogProps) => {
	const router = useRouter();
	const create = api.dataset.create.useMutation();
	const [isOpen, setIsOpen] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const reset = () => {
		setName("");
		setDescription("");
	};

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		try {
			const dataset = await create.mutateAsync({
				name,
				description,
			});
			toast.success("Dataset created");
			setIsOpen(false);
			reset();
			if (dataset?.datasetId)
				await router.push(`/dashboard/datasets/${dataset.datasetId}`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Unable to create dataset",
			);
		}
	};

	return (
		<Dialog open={isOpen} onOpenChange={setIsOpen}>
			<DialogTrigger asChild>
				{trigger === "menu" ? (
					<DropdownMenuItem
						className="w-full cursor-pointer space-x-3"
						onSelect={(event) => event.preventDefault()}
					>
						<Database className="size-4" />
						<span>Create Dataset</span>
					</DropdownMenuItem>
				) : (
					<Button>
						<Database className="size-4" />
						Create Dataset
					</Button>
				)}
			</DialogTrigger>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<Database className="size-5" />
						Create Dataset
					</DialogTitle>
					<DialogDescription>
						A prepared collection of samples, independent from a Project.
					</DialogDescription>
				</DialogHeader>
				<form id="create-dataset-form" onSubmit={submit} className="grid gap-5">
					<label
						htmlFor="dataset-name"
						className="grid gap-2 text-sm font-medium"
					>
						Name
						<Input
							id="dataset-name"
							required
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="CyberGym subset"
						/>
					</label>
					<label
						htmlFor="dataset-description"
						className="grid gap-2 text-sm font-medium"
					>
						Description
						<Textarea
							id="dataset-description"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							placeholder="What this dataset measures"
						/>
					</label>
				</form>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						onClick={() => setIsOpen(false)}
						disabled={create.isLoading}
					>
						Cancel
					</Button>
					<Button
						form="create-dataset-form"
						type="submit"
						disabled={create.isLoading}
					>
						{create.isLoading ? (
							<Loader2 className="size-4 animate-spin" />
						) : null}
						Create Dataset
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
