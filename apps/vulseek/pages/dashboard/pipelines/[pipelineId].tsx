import type {
	GetServerSidePropsContext,
	InferGetServerSidePropsType,
} from "next";
import { useRouter } from "next/router";
import * as React from "react";
import { createServerSideHelpers } from "@trpc/react-query/server";
import {
	Archive,
	ArrowLeft,
	Copy,
	Eye,
	FilePenLine,
	Save,
	Upload,
	Workflow,
} from "lucide-react";
import { toast } from "sonner";
import superjson from "superjson";
import { validateRequest } from "@vulseek/server/lib/auth";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { CanvasEditor } from "@/components/dashboard/pipelines/canvas-editor";
import { DiagnosticsBar } from "@/components/dashboard/pipelines/diagnostics-bar";
import { PipelineInspector } from "@/components/dashboard/pipelines/pipeline-inspector";
import { YamlEditor } from "@/components/dashboard/pipelines/yaml-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	initialEditorState,
	isDirty,
	pipelineEditorReducer,
	validDocument,
	type PipelineEditorState,
} from "@/lib/pipeline-editor/pipeline-editor-state";
import { api } from "@/utils/api";
import { appRouter } from "@/server/api/root";

export const getServerSideProps = async (context: GetServerSidePropsContext) => {
	const { user, session } = await validateRequest(context.req);
	if (!user || !session) {
		return { redirect: { destination: "/login", permanent: false } };
	}
	const pipelineId = String(context.query.pipelineId ?? "");
	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			session,
			user,
			req: context.req,
			res: context.res,
			db: undefined,
		} as never,
		transformer: superjson,
	});
	await helpers.pipeline.get.prefetch({ pipelineId }).catch(() => {});
	await helpers.pipeline.listVersions.prefetch({ pipelineId }).catch(() => {});
	return {
		props: { trpcState: helpers.dehydrate(), pipelineId },
	};
};

type Mode = "yaml" | "canvas";

const EditorPage = ({
	pipelineId,
}: InferGetServerSidePropsType<typeof getServerSideProps>) => {
	const router = useRouter();
	const pipeline = api.pipeline.get.useQuery({ pipelineId });
	const versions = api.pipeline.listVersions.useQuery({ pipelineId });
	const saveDraft = api.pipeline.saveDraft.useMutation();
	const publish = api.pipeline.publish.useMutation();
	const copyVersionToDraft = api.pipeline.copyVersionToDraft.useMutation();
	const setCurrentVersion = api.pipeline.setCurrentVersion.useMutation();
	const archive = api.pipeline.archive.useMutation();

	const canManage = pipeline.data?.draftYaml !== undefined; // manager-only field presence
	const [mode, setMode] = React.useState<Mode>("yaml");
	const [selectedVersionId, setSelectedVersionId] = React.useState<string | null>(null);
	const [viewingVersion, setViewingVersion] = React.useState(false);

	const draftYaml = pipeline.data?.draftYaml ?? null;
	const initialYaml = React.useMemo(
		() => draftYaml ?? "",
		[draftYaml],
	);
	const [state, dispatch] = React.useReducer(
		pipelineEditorReducer,
		{ yaml: initialYaml, revision: pipeline.data?.draftRevision ?? 0 },
		({ yaml, revision }) => initialEditorState(yaml, revision),
	);

	// When the server draft arrives (or changes), adopt it if the local
	// buffer is untouched.
	React.useEffect(() => {
		if (!draftYaml) return;
		dispatch({
			type: "setSavedYaml",
			yaml: draftYaml,
			draftRevision: pipeline.data?.draftRevision ?? 0,
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draftYaml, pipeline.data?.draftRevision]);

	const document = validDocument(state);
	const dirty = isDirty(state);
	const canPublish =
		state.status.kind === "valid" &&
		!state.status.stale &&
		!state.diagnostics.some((d) => d.severity === "error");

	const handleSave = async () => {
		if (!canManage) return;
		try {
			await saveDraft.mutateAsync({
				pipelineId,
				expectedRevision: state.draftRevision,
				yaml: state.rawYamlBuffer,
			});
			dispatch({
				type: "setSavedYaml",
				yaml: state.rawYamlBuffer,
				draftRevision: state.draftRevision + 1,
			});
			toast.success("Draft saved");
		} catch (error) {
			const cause = (error as { cause?: { draftRevision?: number } }).cause;
			if (cause?.draftRevision != null) {
				toast.error(
					`Draft changed on the server (revision ${cause.draftRevision}). Reload to see the latest, or copy your local YAML before retrying.`,
				);
			} else {
				toast.error(
					error instanceof Error ? error.message : "Unable to save draft",
				);
			}
		}
	};

	const handlePublish = async () => {
		if (!canManage || !canPublish) return;
		try {
			const result = await publish.mutateAsync({
				pipelineId,
				expectedRevision: state.draftRevision,
				yaml: state.rawYamlBuffer,
			});
			dispatch({ type: "setSavedYaml", yaml: state.rawYamlBuffer, draftRevision: state.draftRevision + 1 });
			toast.success(`Published as v${result.versionNumber}`);
			setViewingVersion(true);
			await pipeline.refetch();
			await versions.refetch();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Publish failed");
		}
	};

	const handleCopyVersion = async (versionId: string) => {
		if (!canManage) return;
		try {
			await copyVersionToDraft.mutateAsync({ pipelineId, pipelineVersionId: versionId });
			toast.success("Version copied to draft");
			setViewingVersion(false);
			await pipeline.refetch();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Copy failed");
		}
	};

	// Ctrl/Cmd+S saves the draft.
	React.useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
				event.preventDefault();
				if (dirty && canManage) void handleSave();
			}
		};
		window.addEventListener("keydown", handler);
		return () => window.removeEventListener("keydown", handler);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dirty, canManage, state.rawYamlBuffer, state.draftRevision]);

	// Dirty-leave guard.
	React.useEffect(() => {
		const handler = (event: BeforeUnloadEvent) => {
			if (dirty) {
				event.preventDefault();
				event.returnValue = "";
			}
		};
		window.addEventListener("beforeunload", handler);
		return () => window.removeEventListener("beforeunload", handler);
	}, [dirty]);

	if (pipeline.isLoading || !pipeline.data) {
		return (
			<DashboardLayout>
				<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
					Loading pipeline…
				</div>
			</DashboardLayout>
		);
	}

	const data = pipeline.data;
	const selectedVersion = versions.data?.find(
		(version) => version.pipelineVersionId === selectedVersionId,
	);
	const isManagerView = canManage && !viewingVersion;
	const editorYaml = state.rawYamlBuffer;
	const editorDocument = isManagerView ? document : undefined;

	return (
		<DashboardLayout>
			<div className="flex h-full min-h-0 flex-col">
				{/* Header */}
				<header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
					<button
						type="button"
						onClick={() => void router.push("/dashboard/pipelines")}
						className="text-muted-foreground hover:text-foreground"
						aria-label="Back to pipelines"
					>
						<ArrowLeft className="size-4" />
					</button>
					<Workflow className="size-4 text-muted-foreground" />
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h1 className="truncate text-sm font-semibold">{data.name}</h1>
							{data.systemKey ? (
								<Badge variant="outline" className="border-sky-500/40 text-sky-600">
									System
								</Badge>
							) : null}
							{data.archivedAt ? (
								<Badge variant="secondary">Archived</Badge>
							) : null}
							{isManagerView ? (
								<Badge
									variant="outline"
									className={
										dirty
											? "border-amber-500/40 text-amber-600"
											: "border-emerald-500/40 text-emerald-600"
									}
								>
									{dirty ? "Draft (unsaved)" : "Draft"}
								</Badge>
							) : (
								<Badge variant="outline" className="border-emerald-500/40 text-emerald-600">
									Published
								</Badge>
							)}
						</div>
						<p className="truncate text-xs text-muted-foreground">
							{data.slug}
							{data.currentVersion ? ` · v${data.currentVersion.versionNumber} current` : " · no published version"}
						</p>
					</div>

					<div className="ml-auto flex items-center gap-2">
						{isManagerView ? (
							<>
								<Select
									value={selectedVersionId ?? ""}
									onValueChange={(value) => setSelectedVersionId(value || null)}
								>
									<SelectTrigger className="h-8 w-40">
										<SelectValue placeholder="View a version…" />
									</SelectTrigger>
									<SelectContent>
										{versions.data?.map((version) => (
											<SelectItem
												key={version.pipelineVersionId}
												value={version.pipelineVersionId}
											>
												v{version.versionNumber} · {version.source}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{selectedVersion ? (
									<>
										<Button
											variant="outline"
											size="sm"
											onClick={() => void handleCopyVersion(selectedVersion.pipelineVersionId)}
										>
											<Copy className="size-3.5" />
											Copy to draft
										</Button>
										<Button
											variant="outline"
											size="sm"
											onClick={() => {
												void setCurrentVersion
													.mutateAsync({
														pipelineId,
														pipelineVersionId: selectedVersion.pipelineVersionId,
													})
													.then(() => {
														toast.success(`v${selectedVersion.versionNumber} is now current`);
														void pipeline.refetch();
													})
													.catch((error: unknown) =>
														toast.error(
															error instanceof Error ? error.message : "Switch failed",
														),
													);
											}}
										>
											<Upload className="size-3.5" />
											Set current
										</Button>
									</>
								) : null}
								<Button variant="outline" size="sm" onClick={() => void handleSave()} disabled={!dirty || saveDraft.isLoading}>
									<Save className="size-3.5" />
									{dirty ? "Save draft" : "Saved"}
								</Button>
								<Button size="sm" onClick={() => void handlePublish()} disabled={!canPublish || publish.isLoading}>
									Publish
								</Button>
								{!data.systemKey && !data.archivedAt ? (
									<Button
										variant="ghost"
										size="icon"
										className="size-8 text-muted-foreground hover:text-red-600"
										onClick={() => {
											if (window.confirm("Archive this pipeline? Runs keep their frozen snapshots.")) {
												void archive
													.mutateAsync({ pipelineId })
													.then(() => toast.success("Pipeline archived"))
													.then(() => void router.push("/dashboard/pipelines"));
											}
										}}
										aria-label="Archive pipeline"
									>
										<Archive className="size-4" />
									</Button>
								) : null}
							</>
						) : (
							<>
								{data.currentVersion ? (
									<Button
										variant="outline"
										size="sm"
										onClick={() => {
											// Phase 6 wires the Run dialog here.
											toast.info("Run dialog lands with the profile integration phase");
										}}
									>
										Run
									</Button>
								) : null}
								{canManage && (
									<Button
										variant="outline"
										size="sm"
										onClick={() => setViewingVersion(false)}
									>
										<FilePenLine className="size-3.5" />
										{data.draftYaml !== null ? "Edit draft" : "Edit pipeline"}
									</Button>
								)}
							</>
						)}
						{!canManage && (
							<Button
								variant="ghost"
								size="icon"
								className="size-8 text-muted-foreground"
								onClick={() => setViewingVersion(false)}
								aria-label="View published version"
							>
								<Eye className="size-4" />
							</Button>
						)}
					</div>
				</header>

				{/* Mode tabs + body */}
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex shrink-0 items-center gap-1 border-b px-4 pt-2">
						{(["yaml", "canvas"] as const).map((item) => (
							<button
								key={item}
								type="button"
								onClick={() => setMode(item)}
								className={
									"rounded-t-md px-3 py-1.5 text-sm font-medium transition-colors " +
									(mode === item
										? "border-b-2 border-primary text-foreground"
										: "text-muted-foreground hover:text-foreground")
								}
							>
								{item === "yaml" ? "YAML" : "Visual"}
							</button>
						))}
						{state.canvasTouched && mode === "yaml" ? (
							<span className="ml-2 text-xs text-muted-foreground">
								Canvas edits use stable serialization — original comments may be rewritten.
							</span>
						) : null}
					</div>

					<div className="flex min-h-0 flex-1">
						<div className="min-w-0 flex-1">
							{mode === "yaml" ? (
								<YamlEditor
									value={editorYaml}
									onChange={(yaml) => dispatch({ type: "setBuffer", yaml })}
									diagnostics={state.diagnostics}
									readOnly={!isManagerView}
								/>
							) : editorDocument ? (
								<CanvasEditor
									document={editorDocument}
									readOnly={!isManagerView}
									onChange={(next) => dispatch({ type: "canvasModified", document: next })}
									onSelect={(entity) =>
										dispatch({ type: "select", entity: entity as never })
									}
									onAddStage={() => {
										const base = "stage";
										let id = base;
										let index = 1;
										while (editorDocument.stages[id]) {
											id = `${base}-${index}`;
											index += 1;
										}
										dispatch({
											type: "canvasModified",
											document: {
												...editorDocument,
												stages: {
													...editorDocument.stages,
													[id]: {
														name: "New Stage",
														role: "scan",
														group: "custom",
														mode: "serial",
														concurrency: 1,
														disableable: true,
														inputArtifacts: [],
														outputArtifacts: [],
														effects: [],
														containerNameParts: [],
														allowAgentExit: false,
														promptValues: {},
														runtime: {
															kind: "agent",
															prompt: "Analyze this target.",
															prepareRepository: "none",
															includePolicy: false,
															plugins: [],
														},
													},
												},
											},
										});
									}}
								/>
							) : (
								<div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
									{state.status.kind === "invalid" || state.status.kind === "empty"
										? "The YAML does not parse yet — the canvas shows the last valid document in YAML mode only."
										: "Nothing to render yet."}
								</div>
							)}
						</div>

						{isManagerView && document ? (
							<aside className="w-[360px] shrink-0 border-l bg-background">
								<PipelineInspector
									document={document}
									selection={state.selectedEntity as never}
									onChange={(next) => dispatch({ type: "canvasModified", document: next })}
								/>
							</aside>
						) : null}
					</div>

					{isManagerView ? (
						<DiagnosticsBar
							diagnostics={state.diagnostics}
							onSelect={(entity) =>
								dispatch({ type: "select", entity: entity as never })
							}
						/>
					) : (
						<div className="flex h-8 shrink-0 items-center border-t px-3 text-xs text-muted-foreground">
							Read-only view of the published version
							{selectedVersion ? ` v${selectedVersion.versionNumber}` : ""}.
						</div>
					)}
				</div>
			</div>
		</DashboardLayout>
	);
};

export default EditorPage;
