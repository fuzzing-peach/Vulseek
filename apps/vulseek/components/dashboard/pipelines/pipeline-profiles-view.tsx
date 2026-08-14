import * as React from "react";
import { Plus, Save } from "lucide-react";
import { toast } from "sonner";
import {
	ScanStageGraphPanel,
	type ScanRuntimeSettingsDraft,
	type StageGraph,
} from "@/components/dashboard/scanning/scan-stage-graph";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

type PipelineProfilesViewProps = {
	pipelineId: string;
	pipelineVersionId: string | null;
	profileId?: string;
	onProfileChange: (profileId?: string) => void;
};

export const PipelineProfilesView = ({
	pipelineId,
	pipelineVersionId,
	profileId,
	onProfileChange,
}: PipelineProfilesViewProps) => {
	const utils = api.useUtils();
	const profiles = api.pipeline.profilesList.useQuery({ pipelineId });
	const isEditor = Boolean(profileId);
	const isNew = profileId === "new";
	const profile = api.pipeline.profilesGet.useQuery(
		{ pipelineProfileId: profileId ?? "__none__" },
		{ enabled: isEditor && !isNew },
	);
	const versionId = profile.data?.pipelineVersionId ?? pipelineVersionId ?? "";
	const graph = api.pipeline.profilesStageGraph.useQuery(
		{ pipelineId, pipelineVersionId: versionId },
		{ enabled: isEditor && Boolean(versionId) },
	);
	const { data: agentProfiles } = api.ai.getAgentProfiles.useQuery(undefined, {
		enabled: isEditor,
	});
	const create = api.pipeline.profilesCreate.useMutation();
	const update = api.pipeline.profilesUpdate.useMutation();
	const [name, setName] = React.useState("");
	const [description, setDescription] = React.useState("");
	const [settings, setSettings] = React.useState<ScanRuntimeSettingsDraft>({
		stages: {},
	});

	React.useEffect(() => {
		if (profile.data) {
			setName(profile.data.name);
			setDescription(profile.data.description ?? "");
			setSettings(profile.data.settings);
			return;
		}
		if (isNew) {
			setName("");
			setDescription("");
			setSettings({ stages: {} });
		}
	}, [isNew, profile.data]);

	const save = async () => {
		if (!profileId || !name.trim() || !versionId) return;
		try {
			if (isNew) {
				await create.mutateAsync({
					pipelineId,
					pipelineVersionId: versionId,
					name: name.trim(),
					description: description || null,
					settings,
				});
			} else {
				await update.mutateAsync({
					pipelineProfileId: profileId,
					name: name.trim(),
					description: description || null,
					settings,
				});
			}
			await utils.pipeline.profilesList.invalidate({ pipelineId });
			toast.success("Profile saved");
			onProfileChange();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Unable to save profile");
		}
	};

	if (!isEditor) {
		return (
			<div className="w-full min-w-0 p-5">
				<div className="mb-5 flex items-start justify-between gap-4">
					<div className="min-w-0">
						<h2 className="text-lg font-semibold">Runtime profiles</h2>
						<p className="text-sm text-muted-foreground">
							Reusable model and concurrency combinations for this pipeline.
						</p>
					</div>
					<Button onClick={() => onProfileChange("new")}>
						<Plus className="mr-2 size-4" />
						New profile
					</Button>
				</div>
				{profiles.isLoading ? (
					<div className="text-sm text-muted-foreground">Loading profiles…</div>
				) : profiles.data?.length ? (
					<div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
						{profiles.data.map((item) => (
							<button
								key={item.pipelineProfileId}
								type="button"
								className="min-w-0 rounded-lg border p-4 text-left transition hover:border-primary hover:shadow-sm"
								onClick={() => onProfileChange(item.pipelineProfileId)}
							>
								<div className="flex items-start justify-between gap-3">
									<div className="font-medium">{item.name}</div>
									<Badge variant="outline">Profile</Badge>
								</div>
								<p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
									{item.description || "No description"}
								</p>
								<div className="mt-4 text-xs text-muted-foreground">
									{Object.keys(item.settings.stages ?? {}).length} stage overrides
								</div>
							</button>
						))}
					</div>
				) : (
					<div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
						No profiles yet. Create one to configure the stage graph.
					</div>
				)}
			</div>
		);
	}

	return (
		<div className="w-full min-w-0 p-5">
			<div className="mb-5 flex items-start justify-between gap-4">
				<div className="min-w-0">
					<h2 className="text-lg font-semibold">
						{isNew ? "New runtime profile" : "Edit runtime profile"}
					</h2>
					<p className="text-sm text-muted-foreground">
						Configure model and concurrency per stage.
					</p>
				</div>
				<Button
					onClick={() => void save()}
					disabled={!name.trim() || create.isLoading || update.isLoading}
				>
					<Save className="mr-2 size-4" />
					Save profile
				</Button>
			</div>
			<div className="mb-4 grid min-w-0 gap-2">
				<Label htmlFor="profile-name">Name</Label>
				<Input id="profile-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Balanced research" />
			</div>
			<ScanStageGraphPanel
				graph={graph.data as unknown as StageGraph}
				isLoading={graph.isLoading}
				error={graph.error}
				title="Stage runtime profile"
				description="Click a stage to choose its model, concurrency, or disabled state."
				heightClassName="h-[680px]"
				scanRuntimeSettings={settings}
				agentProfiles={agentProfiles}
				onStageSettingSave={(stageName, setting) => {
					setSettings((current) => ({
						...current,
						stages: { ...(current.stages ?? {}), [stageName]: setting },
					}));
				}}
			/>
			<div className="mt-4 grid min-w-0 gap-2">
				<Label htmlFor="profile-description">Description</Label>
				<Textarea id="profile-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Optional description" rows={3} />
			</div>
		</div>
	);
};
