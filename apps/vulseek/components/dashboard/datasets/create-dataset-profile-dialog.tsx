import { Database, Loader2 } from "lucide-react";
import { useRouter } from "next/router";
import type { FormEvent } from "react";
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
import { Input } from "@/components/ui/input";
import { api } from "@/utils/api";

type Props = {
	datasetId: string;
};

export const CreateDatasetProfileDialog = ({ datasetId }: Props) => {
	const router = useRouter();
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const createProfile = api.dataset.profiles.create.useMutation();
	const isLoading = createProfile.isLoading;

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const profileName = name.trim();
		if (!profileName) return;
		let createdProfileId: string | undefined;
		try {
			const profile = await createProfile.mutateAsync({
				datasetId,
				profileKey: profileName,
			});
			if (!profile) throw new Error("Dataset profile was not created");
			createdProfileId = profile.profileId;
			await utils.dataset.one.invalidate({ datasetId });
			setName("");
			setOpen(false);
			await router.push(
				`/dashboard/datasets/${datasetId}/profiles/${profile.profileId}`,
			);
			toast.success("Dataset profile created");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Profile creation failed",
			);
			if (createdProfileId) {
				setOpen(false);
				await router.push(
					`/dashboard/datasets/${datasetId}/profiles/${createdProfileId}`,
				);
			}
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button>
					<Database className="size-4" />
					Create Profile
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Create Dataset Profile</DialogTitle>
					<DialogDescription>
						Give this dataset profile a name. Run checkout from the profile
						detail page when you are ready.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={submit} className="grid gap-4">
					<label
						className="grid gap-2 text-sm font-medium"
						htmlFor="dataset-profile-name"
					>
						Name
						<Input
							id="dataset-profile-name"
							autoFocus
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="cybergym-baseline"
							maxLength={160}
							required
						/>
					</label>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => setOpen(false)}
							disabled={isLoading}
						>
							Cancel
						</Button>
						<Button type="submit" disabled={isLoading || !name.trim()}>
							{isLoading && <Loader2 className="size-4 animate-spin" />}Create
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
};
