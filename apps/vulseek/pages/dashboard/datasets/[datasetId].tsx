import { ArrowLeft, CheckCircle2, Database, Loader2, Play, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BreadcrumbSidebar } from "@/components/shared/breadcrumb-sidebar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { api } from "@/utils/api";
import type { DatasetHook, DatasetSource } from "@vulseek/server/db/schema";
import { DatasetHookEditor } from "@/components/dashboard/datasets/dataset-hook-editor";

const DatasetDetailPage = () => {
	const router = useRouter();
	const datasetId = typeof router.query.datasetId === "string" ? router.query.datasetId : "";
	const dataset = api.dataset.one.useQuery({ datasetId }, { enabled: Boolean(datasetId) });
	const createProfile = api.dataset.profiles.create.useMutation();
	const checkout = api.dataset.profiles.checkout.useMutation();
	const removeProfile = api.dataset.profiles.remove.useMutation();
	const createEvaluation = api.dataset.evaluations.create.useMutation();
	const updateDataset = api.dataset.update.useMutation();
	const agentProfiles = api.ai.getAgentProfiles.useQuery();
	const sshKeys = api.sshKey.all.useQuery();
	const [profileId, setProfileId] = useState("");
	const selectedProfile = dataset.data?.profiles.find((profile) => profile.profileId === profileId) ?? dataset.data?.profiles[0];
	const [sampleSearch, setSampleSearch] = useState("");
	const [samplePage, setSamplePage] = useState(1);
	const samplePageSize = 20;
	const samples = api.dataset.samples.list.useQuery({ profileId: selectedProfile?.profileId ?? "", page: samplePage, pageSize: samplePageSize, search: sampleSearch || undefined }, { enabled: Boolean(selectedProfile?.profileId), refetchInterval: selectedProfile?.status === "preparing" ? 3000 : false });
	const [evaluationName, setEvaluationName] = useState("Evaluation");
	const [pipelineId, setPipelineId] = useState<"full" | "research" | "tob-goal">("research");
	const [repetitions, setRepetitions] = useState(1);
	const [configurationDatasetId, setConfigurationDatasetId] = useState<string | null>(null);
	const [configDescription, setConfigDescription] = useState("");
	const [configSourceType, setConfigSourceType] = useState<"git" | "local">("git");
	const [configSource, setConfigSource] = useState("");
	const [configRef, setConfigRef] = useState("");
	const [configSshKeyId, setConfigSshKeyId] = useState<string | null>(null);
	const [configSubmodules, setConfigSubmodules] = useState(false);
	const [postCheckoutHook, setPostCheckoutHook] = useState<DatasetHook>({ type: "none" });
	const [postScanHook, setPostScanHook] = useState<DatasetHook>({ type: "none" });
	const [postEvaluationHook, setPostEvaluationHook] = useState<DatasetHook>({ type: "none" });
	const [postCheckoutSchema, setPostCheckoutSchema] = useState("{}");
	const [postScanSchema, setPostScanSchema] = useState("{}");
	const [postEvaluationSchema, setPostEvaluationSchema] = useState("{}");

	useEffect(() => {
		if (!profileId && dataset.data?.profiles[0]?.profileId) setProfileId(dataset.data.profiles[0].profileId);
	}, [dataset.data?.profiles, profileId]);
	useEffect(() => {
		setSamplePage(1);
	}, [selectedProfile?.profileId, sampleSearch]);
	useEffect(() => {
		if (!dataset.data || configurationDatasetId === dataset.data.datasetId) return;
		const source = dataset.data.source as DatasetSource;
		setConfigurationDatasetId(dataset.data.datasetId);
		setConfigDescription(dataset.data.description);
		setConfigSourceType(source.type);
		setConfigSource(source.type === "git" ? source.url : source.path);
		setConfigRef(source.type === "git" ? source.ref ?? "" : "");
		setConfigSshKeyId(source.type === "git" ? source.sshKeyId ?? null : null);
		setConfigSubmodules(source.type === "git" ? source.submodules ?? false : false);
		setPostCheckoutHook(dataset.data.postCheckoutHook as DatasetHook);
		setPostScanHook(dataset.data.postScanHook as DatasetHook);
		setPostEvaluationHook(dataset.data.postEvaluationHook as DatasetHook);
		setPostCheckoutSchema(JSON.stringify(dataset.data.postCheckoutSchema ?? {}, null, 2));
		setPostScanSchema(JSON.stringify(dataset.data.postScanSchema ?? {}, null, 2));
		setPostEvaluationSchema(JSON.stringify(dataset.data.postEvaluationSchema ?? {}, null, 2));
	}, [dataset.data, configurationDatasetId]);

	const newProfile = async () => {
		try { const profile = await createProfile.mutateAsync({ datasetId }); if (profile?.profileId) { setProfileId(profile.profileId); await checkout.mutateAsync({ profileId: profile.profileId }); await dataset.refetch(); toast.success("Dataset profile prepared"); } } catch (error) { toast.error(error instanceof Error ? error.message : "Profile preparation failed"); }
	};
	const checkoutProfile = async () => {
		if (!selectedProfile) return;
		try { await checkout.mutateAsync({ profileId: selectedProfile.profileId }); await dataset.refetch(); await samples.refetch(); toast.success("Profile checkout completed"); } catch (error) { toast.error(error instanceof Error ? error.message : "Checkout failed"); }
	};
	const pruneProfile = async (id: string) => {
		try { await removeProfile.mutateAsync({ profileId: id }); if (profileId === id) setProfileId(""); await dataset.refetch(); toast.success("Profile pruned"); } catch (error) { toast.error(error instanceof Error ? error.message : "Profile cannot be pruned"); }
	};
	const submitEvaluation = async (event: React.FormEvent) => {
		event.preventDefault();
		if (!selectedProfile || samples.data?.items.length === 0) return;
		try { await createEvaluation.mutateAsync({ datasetId, profileId: selectedProfile.profileId, name: evaluationName, pipelineId, sampleKeys: samples.data?.items.map((sample) => sample.sampleKey) ?? [], repetitions, timeBudgetSeconds: null, scanRuntimeSettings: {} }); await dataset.refetch(); toast.success("Evaluation queued"); } catch (error) { toast.error(error instanceof Error ? error.message : "Unable to create evaluation"); }
	};
	const saveConfiguration = async (event: React.FormEvent) => {
		event.preventDefault();
		try {
			const parseSchema = (value: string, label: string) => {
				const parsed: unknown = JSON.parse(value || "{}");
				if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
				return parsed as Record<string, unknown>;
			};
			await updateDataset.mutateAsync({
				datasetId,
				description: configDescription,
				source: configSourceType === "git" ? { type: "git", url: configSource, ref: configRef || null, sshKeyId: configSshKeyId, submodules: configSubmodules } : { type: "local", path: configSource },
				postCheckoutHook,
				postScanHook,
				postEvaluationHook,
				postCheckoutSchema: parseSchema(postCheckoutSchema, "Post-checkout schema"),
				postScanSchema: parseSchema(postScanSchema, "Post-scan schema"),
				postEvaluationSchema: parseSchema(postEvaluationSchema, "Post-evaluation schema"),
			});
			await dataset.refetch();
			toast.success("Dataset configuration saved");
		} catch (error) { toast.error(error instanceof Error ? error.message : "Unable to save dataset configuration"); }
	};

	if (dataset.isLoading) return <div className="flex min-h-96 items-center justify-center"><Loader2 className="animate-spin" /></div>;
	if (!dataset.data) return <div className="p-8 text-center">Dataset not found.</div>;
	return (
		<>
			<BreadcrumbSidebar list={[{ name: "Datasets", href: "/dashboard/datasets" }, { name: dataset.data.name }]} />
			<div className="w-full space-y-5">
				<div className="flex items-center justify-between gap-3"><div><Button variant="ghost" size="sm" asChild><Link href="/dashboard/datasets"><ArrowLeft className="size-4" />Datasets</Link></Button><h1 className="mt-2 flex items-center gap-2 text-2xl font-semibold"><Database className="size-6 text-muted-foreground" />{dataset.data.name}</h1><p className="text-sm text-muted-foreground">{dataset.data.description || "No description"}</p></div>{dataset.data.canManage && <Button onClick={newProfile} disabled={createProfile.isLoading || checkout.isLoading}><RefreshCw className="size-4" />New Profile & Checkout</Button>}</div>
				{dataset.data.canManage && <Card><CardHeader><CardTitle>Configuration</CardTitle><CardDescription>Changes apply to future profiles. Existing profiles keep their checkout and hook snapshot.</CardDescription></CardHeader><CardContent><form onSubmit={saveConfiguration} className="grid gap-5">
					<label className="grid gap-2 text-sm font-medium">Description<Input value={configDescription} onChange={(event) => setConfigDescription(event.target.value)} /></label>
					<div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-2 text-sm font-medium">Source type<select className="h-10 rounded-md border bg-background px-3" value={configSourceType} onChange={(event) => setConfigSourceType(event.target.value as "git" | "local")}><option value="git">Git repository</option><option value="local">Local directory</option></select></label><label className="grid gap-2 text-sm font-medium">{configSourceType === "git" ? "Repository URL" : "Absolute local path"}<Input required value={configSource} onChange={(event) => setConfigSource(event.target.value)} /></label></div>
					{configSourceType === "git" && <div className="grid gap-3 sm:grid-cols-3"><label className="grid gap-2 text-sm font-medium">Git ref<Input value={configRef} onChange={(event) => setConfigRef(event.target.value)} placeholder="main" /></label><label className="grid gap-2 text-sm font-medium">SSH key<select className="h-10 rounded-md border bg-background px-3" value={configSshKeyId ?? ""} onChange={(event) => setConfigSshKeyId(event.target.value || null)}><option value="">Default Git SSH</option>{sshKeys.data?.map((key) => <option key={key.sshKeyId} value={key.sshKeyId}>{key.name}</option>)}</select></label><label className="flex items-center gap-2 self-end pb-2 text-sm font-medium"><input type="checkbox" checked={configSubmodules} onChange={(event) => setConfigSubmodules(event.target.checked)} />Fetch submodules</label></div>}
					<div className="grid gap-4 lg:grid-cols-3"><DatasetHookEditor label="Post-checkout hook" value={postCheckoutHook} onChange={setPostCheckoutHook} agentProfiles={agentProfiles.data ?? []} /><DatasetHookEditor label="Post-scan hook" value={postScanHook} onChange={setPostScanHook} agentProfiles={agentProfiles.data ?? []} /><DatasetHookEditor label="Post-evaluation hook" value={postEvaluationHook} onChange={setPostEvaluationHook} agentProfiles={agentProfiles.data ?? []} /></div>
					<div className="grid gap-4 lg:grid-cols-3"><label className="grid gap-2 text-sm font-medium">Post-checkout JSON Schema<Textarea className="min-h-36 font-mono text-xs" value={postCheckoutSchema} onChange={(event) => setPostCheckoutSchema(event.target.value)} /></label><label className="grid gap-2 text-sm font-medium">Post-scan JSON Schema<Textarea className="min-h-36 font-mono text-xs" value={postScanSchema} onChange={(event) => setPostScanSchema(event.target.value)} /></label><label className="grid gap-2 text-sm font-medium">Post-evaluation JSON Schema<Textarea className="min-h-36 font-mono text-xs" value={postEvaluationSchema} onChange={(event) => setPostEvaluationSchema(event.target.value)} /></label></div>
					<div className="flex justify-end"><Button type="submit" disabled={updateDataset.isLoading}>{updateDataset.isLoading ? <Loader2 className="size-4 animate-spin" /> : null}Save Configuration</Button></div>
				</form></CardContent></Card>}
				<div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
					<Card><CardHeader><CardTitle>Profiles</CardTitle><CardDescription>Immutable prepared checkouts kept on the host.</CardDescription></CardHeader><CardContent className="space-y-3">{dataset.data.profiles.length === 0 && <p className="text-sm text-muted-foreground">No profiles. Create one to prepare samples.</p>}{dataset.data.profiles.map((profile) => <div key={profile.profileId} className={`flex items-start gap-2 rounded-lg border p-3 ${selectedProfile?.profileId === profile.profileId ? "border-primary bg-primary/5" : ""}`}><button type="button" onClick={() => setProfileId(profile.profileId)} className="min-w-0 flex-1 text-left"><div className="flex items-center justify-between"><span className="font-medium">{profile.profileKey}</span><span className="text-xs capitalize text-muted-foreground">{profile.status}</span></div><div className="mt-1 text-xs text-muted-foreground">{profile.sourceDigest || "Not checked out"}</div>{profile.errorMessage && <div className="mt-2 text-xs text-destructive">{profile.errorMessage}</div>}</button>{dataset.data.canManage && <Button variant="ghost" size="icon" title="Prune profile" disabled={removeProfile.isLoading} onClick={() => pruneProfile(profile.profileId)}><Trash2 className="size-4 text-destructive" /></Button>}</div>)}</CardContent></Card>
					<Card><CardHeader><CardTitle>Samples</CardTitle><CardDescription>{selectedProfile ? `Profile ${selectedProfile.profileKey}` : "Select a profile"}</CardDescription></CardHeader><CardContent>{selectedProfile?.status === "ready" && <div className="mb-3 flex justify-end"><Button variant="outline" size="sm" onClick={checkoutProfile} disabled={!dataset.data.canManage || checkout.isLoading}><RefreshCw className="size-4" />Re-checkout</Button></div>}{selectedProfile && <div className="mb-3 flex gap-2"><Input value={sampleSearch} onChange={(event) => setSampleSearch(event.target.value)} placeholder="Search samples" /><Button type="button" variant="outline" onClick={() => setSampleSearch("")} disabled={!sampleSearch}>Clear</Button></div>}{samples.isLoading ? <Loader2 className="animate-spin" /> : samples.data?.items.length ? <div className="space-y-2">{samples.data.items.map((sample) => <div key={sample.sampleId} className="rounded border p-3"><div className="font-medium">{sample.title || sample.sampleKey}</div><div className="font-mono text-xs text-muted-foreground">{sample.sampleKey} · {sample.repositoryPath}</div></div>)}<div className="flex items-center justify-between pt-2 text-xs text-muted-foreground"><span>{samples.data.total} samples</span><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={samplePage <= 1} onClick={() => setSamplePage((page) => page - 1)}>Previous</Button><span className="self-center">Page {samplePage} of {Math.max(1, Math.ceil(samples.data.total / samplePageSize))}</span><Button type="button" size="sm" variant="outline" disabled={samplePage >= Math.ceil(samples.data.total / samplePageSize)} onClick={() => setSamplePage((page) => page + 1)}>Next</Button></div></div></div> : <p className="text-sm text-muted-foreground">No prepared samples.</p>}</CardContent></Card>
				</div>
				<Card><CardHeader><CardTitle>New Evaluation</CardTitle><CardDescription>Run one selected pipeline sequentially over every prepared sample.</CardDescription></CardHeader><CardContent><form onSubmit={submitEvaluation} className="grid gap-4 md:grid-cols-4"><Input className="md:col-span-2" value={evaluationName} onChange={(event) => setEvaluationName(event.target.value)} placeholder="Evaluation name" required /><select className="h-10 rounded-md border bg-background px-3" value={pipelineId} onChange={(event) => setPipelineId(event.target.value as typeof pipelineId)}><option value="full">Full Scan</option><option value="research">Research</option><option value="tob-goal">Goal</option></select><Input type="number" min={1} max={100} value={repetitions} onChange={(event) => setRepetitions(Number(event.target.value))} /><Button type="submit" disabled={!selectedProfile || selectedProfile.status !== "ready" || !samples.data?.items.length || createEvaluation.isLoading}><Play className="size-4" />Run Evaluation</Button></form></CardContent></Card>
				<Card><CardHeader><CardTitle>Evaluations</CardTitle></CardHeader><CardContent className="space-y-2">{dataset.data.evaluations.length ? dataset.data.evaluations.map((evaluation) => <Link key={evaluation.evaluationId} href={`/dashboard/datasets/evaluations/${evaluation.evaluationId}`} className="flex items-center justify-between rounded border p-3 hover:border-primary"><span>{evaluation.name}</span><span className="flex items-center gap-2 text-xs capitalize text-muted-foreground">{evaluation.status}<CheckCircle2 className="size-4" /></span></Link>) : <p className="text-sm text-muted-foreground">No evaluations.</p>}</CardContent></Card>
			</div>
		</>
	);
};

DatasetDetailPage.getLayout = (page: ReactElement) => <DashboardLayout>{page}</DashboardLayout>;
export default DatasetDetailPage;
