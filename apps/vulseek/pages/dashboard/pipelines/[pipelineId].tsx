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
	ChevronLeft,
	ChevronRight,
	Copy,
	FilePenLine,
	PanelRightClose,
	PanelRightOpen,
	Redo2,
	Save,
	Undo2,
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
import { StageCreateDialog } from "@/components/dashboard/pipelines/stage-create-dialog";
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
	const [inspectorOpen, setInspectorOpen] = React.useState(true);
	const [diagnosticsOpen, setDiagnosticsOpen] = React.useState(false);

	const draftYaml = pipeline.data?.draftYaml ?? null;
	// No draft yet → seed the editor with the current published version's YAML
	// as a local starting point. Saving writes the draft; publishing still
	// produces a new immutable version.
	const currentVersionYaml = api.pipeline.getVersion.useQuery(
		{
			pipelineId,
			pipelineVersionId: pipeline.data?.currentVersion
				? (pipeline.data.currentPublishedVersionId ?? "")
				: "__none__",
		},
		{
			enabled: Boolean(
				pipeline.data &&
					!pipeline.data.draftYaml &&
					pipeline.data.currentVersion,
			),
		},
	).data?.yaml;
	const initialYaml = draftYaml ?? currentVersionYaml ?? "";

	// Selecting a version loads its YAML into the read-only Published View.
	const selectedVersionYaml = api.pipeline.getVersion.useQuery(
		{
			pipelineId,
			pipelineVersionId: selectedVersionId ?? "__none__",
		},
		{ enabled: Boolean(selectedVersionId && viewingVersion) },
	).data?.yaml;

	const yamlEditorRef = React.useRef<import("@/components/dashboard/pipelines/yaml-editor").YamlEditorHandle>(null);
	const [state, dispatch] = React.useReducer(
		pipelineEditorReducer,
		{ yaml: initialYaml, revision: pipeline.data?.draftRevision ?? 0 },
		({ yaml, revision }) => initialEditorState(yaml, revision),
	);

	// When the server draft arrives (or changes): adopt it wholesale when the
	// local buffer has no unsaved edits (e.g. after copy-version-to-draft);
	// otherwise only refresh the saved-YAML baseline so the dirty state
	// compares against the server draft.
	const stateRef = React.useRef(state);
	stateRef.current = state;
	React.useEffect(() => {
		const serverYaml = draftYaml ?? currentVersionYaml;
		if (!serverYaml) return;
		const revision = draftYaml ? (pipeline.data?.draftRevision ?? 0) : 0;
		const untouched = stateRef.current.rawYamlBuffer === stateRef.current.savedYaml;
		if (untouched || !draftYaml) {
			// Adopt wholesale: fresh draft, or the current version as the
			// starting point when no draft exists yet.
			dispatch({ type: "reset", yaml: serverYaml, draftRevision: revision });
		} else {
			dispatch({ type: "setSavedYaml", yaml: serverYaml, draftRevision: revision });
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [draftYaml, currentVersionYaml, pipeline.data?.draftRevision]);

	const document = validDocument(state);
	const dirty = isDirty(state);
	const canPublish =
		state.status.kind === "valid" &&
		!state.status.stale &&
		!state.diagnostics.some((d) => d.severity === "error");

	const handleSave = async () => {
		if (!canManage) return;
		// Flush the YAML editor's parse debounce so the saved buffer matches
		// what the user actually sees.
		const editorText = yamlEditorRef.current?.getValue();
		const yamlToSave = editorText !== undefined ? editorText : state.rawYamlBuffer;
		if (editorText !== undefined && editorText !== state.rawYamlBuffer) {
			dispatch({ type: "setBuffer", yaml: editorText });
		}
		try {
			await saveDraft.mutateAsync({
				pipelineId,
				expectedRevision: state.draftRevision,
				yaml: yamlToSave,
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
				toast.error(error instanceof Error ? error.message : "Unable to save draft");
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
			dispatch({
				type: "setSavedYaml",
				yaml: state.rawYamlBuffer,
				draftRevision: state.draftRevision + 1,
			});
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

	const isManagerViewRef = React.useRef(false);
	isManagerViewRef.current = canManage && !viewingVersion;

	// Ctrl/Cmd+S saves the draft; Ctrl/Cmd+Z / Shift undo/redo.
	React.useEffect(() => {
		const handler = (event: KeyboardEvent) => {
			const modifier = event.metaKey || event.ctrlKey;
			if (!modifier) return;
			const key = event.key.toLowerCase();
			if (key === "s") {
				event.preventDefault();
				if (dirty && canManage) void handleSave();
				return;
			}
			if (!isManagerViewRef.current) return;
			if (key === "z" && !event.shiftKey) {
				event.preventDefault();
				dispatch({ type: "undo" });
				return;
			}
			if (key === "z" && event.shiftKey) {
				event.preventDefault();
				dispatch({ type: "redo" });
				return;
			}
			if (key === "y") {
				event.preventDefault();
				dispatch({ type: "redo" });
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
	const isManagerView = canManage && !viewingVersion;
	const editorYaml = isManagerView
		? state.rawYamlBuffer
		: (selectedVersionYaml ?? state.rawYamlBuffer);
	const editorDocument = isManagerView ? document : undefined;
	const selectedVersion = versions.data?.find(
		(version) => version.pipelineVersionId === selectedVersionId,
	);

	return (
		<DashboardLayout fullHeight>
			<div className="flex min-h-0 flex-1 flex-col">
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
							{data.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}
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
									Published{selectedVersion ? ` v${selectedVersion.versionNumber}` : ""}
								</Badge>
							)}
						</div>
						<p className="truncate text-xs text-muted-foreground">
							{data.slug}
							{data.currentVersion
								? ` · v${data.currentVersion.versionNumber} current`
								: " · no published version"}
						</p>
					</div>

					<div className="ml-auto flex items-center gap-2">
						{isManagerView ? (
							<>
								<Select
									value={selectedVersionId ?? ""}
									onValueChange={(value) => {
										setSelectedVersionId(value || null);
										if (value) {
											setViewingVersion(true);
										}
									}}
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
								<Button
									variant="ghost"
									size="icon"
									className="size-8 text-muted-foreground"
									onClick={() => dispatch({ type: "undo" })}
									aria-label="Undo"
								>
									<Undo2 className="size-4" />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									className="size-8 text-muted-foreground"
									onClick={() => dispatch({ type: "redo" })}
									aria-label="Redo"
								>
									<Redo2 className="size-4" />
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => void handleSave()}
									disabled={!dirty || saveDraft.isLoading}
								>
									<Save className="size-3.5" />
									{dirty ? "Save draft" : "Saved"}
								</Button>
								<Button
									size="sm"
									onClick={() => void handlePublish()}
									disabled={!canPublish || publish.isLoading}
								>
									Publish
								</Button>
								{!data.systemKey && !data.archivedAt ? (
									<Button
										variant="ghost"
										size="icon"
										className="size-8 text-muted-foreground hover:text-red-600"
										onClick={() => {
											if (
												window.confirm(
													"Archive this pipeline? Runs keep their frozen snapshots.",
												)
											) {
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
								{selectedVersion ? (
									<Button
										variant="outline"
										size="sm"
										onClick={() => void handleCopyVersion(selectedVersion.pipelineVersionId)}
									>
										<Copy className="size-3.5" />
										Copy to draft
									</Button>
								) : null}
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
						{isManagerView && (
							<div className="ml-auto flex items-center gap-2 pb-1.5">
								<StageCreateDialog
									existingIds={Object.keys(document?.stages ?? {})}
									onCreate={(id, stage) => {
										if (!document) return;
										dispatch({
											type: "canvasModified",
											document: {
												...document,
												stages: { ...document.stages, [id]: stage },
											},
										});
										dispatch({
											type: "select",
											entity: { type: "stage", id },
										});
									}}
								/>
								<button
									type="button"
									onClick={() => setInspectorOpen((open) => !open)}
									className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
									aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
								>
									{inspectorOpen ? (
										<PanelRightClose className="size-4" />
									) : (
										<PanelRightOpen className="size-4" />
									)}
								</button>
							</div>
						)}
					</div>

					<div className="flex min-h-0 flex-1">
						<div className="min-w-0 flex-1">
							{mode === "yaml" ? (
								<YamlEditor
									ref={yamlEditorRef}
									value={editorYaml}
									onChange={(yaml) => dispatch({ type: "setBuffer", yaml })}
									diagnostics={state.diagnostics}
									readOnly={!isManagerView}
								/>
							) : editorDocument ? (
								<CanvasEditor
									document={editorDocument}
									readOnly={!isManagerView}
									onChange={(next) =>
										dispatch({ type: "canvasModified", document: next })
									}
									onSelect={(entity) =>
										dispatch({ type: "select", entity: entity as never })
									}
								/>
							) : (
								<div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
									{state.status.kind === "invalid" || state.status.kind === "empty"
										? "The YAML does not parse yet — the canvas shows the last valid document in YAML mode only."
										: "Nothing to render yet."}
								</div>
							)}
						</div>

						{isManagerView && document && inspectorOpen ? (
							<aside className="w-[380px] shrink-0 border-l bg-background">
								<div className="flex h-9 items-center justify-between border-b px-3">
									<span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
										Inspector
									</span>
									<button
										type="button"
										onClick={() => setInspectorOpen(false)}
										className="text-muted-foreground hover:text-foreground"
										aria-label="Collapse inspector"
									>
										<ChevronRight className="size-4" />
									</button>
								</div>
								<div className="h-[calc(100%-2.25rem)]">
									<PipelineInspector
										document={document}
										selection={state.selectedEntity as never}
										onChange={(next) =>
											dispatch({ type: "canvasModified", document: next })
										}
									/>
								</div>
							</aside>
						) : null}
					</div>

					{isManagerView ? (
						<div className="shrink-0 border-t">
							<button
								type="button"
								onClick={() => setDiagnosticsOpen((open) => !open)}
								className="flex h-8 w-full items-center justify-between px-3 text-xs text-muted-foreground hover:bg-muted/40"
							>
								<span>
									{state.diagnostics.filter((d) => d.severity === "error").length} errors ·{" "}
									{state.diagnostics.filter((d) => d.severity === "warning").length} warnings
								</span>
								{diagnosticsOpen ? (
									<ChevronLeft className="size-3.5" />
								) : (
									<ChevronRight className="size-3.5" />
								)}
							</button>
							{diagnosticsOpen ? (
								<div className="max-h-40 overflow-y-auto border-t">
									<DiagnosticsBar
										diagnostics={state.diagnostics}
										onSelect={(entity) =>
											dispatch({ type: "select", entity: entity as never })
										}
									/>
								</div>
							) : null}
						</div>
					) : (
						<div className="flex h-8 shrink-0 items-center border-t px-3 text-xs text-muted-foreground">
							Read-only view of{" "}
							{selectedVersion ? `v${selectedVersion.versionNumber}` : "the published version"}
							{selectedVersionYaml ? " — select Copy to draft to edit." : ""}
						</div>
					)}
				</div>
			</div>
		</DashboardLayout>
	);
};

export default EditorPage;
