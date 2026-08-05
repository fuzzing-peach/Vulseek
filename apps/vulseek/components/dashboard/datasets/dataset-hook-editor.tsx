import type { DatasetHook } from "@vulseek/server/db/schema";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type AgentProfileOption = { agentProfileId: string; name: string; isEnabled: boolean };

type Props = {
	label: string;
	value: DatasetHook;
	onChange: (value: DatasetHook) => void;
	agentProfiles: AgentProfileOption[];
};

export const DatasetHookEditor = ({ label, value, onChange, agentProfiles }: Props) => {
	const updateType = (type: DatasetHook["type"]) => {
		if (type === "none") return onChange({ type });
		if (type === "script") {
			return onChange({
				type,
				command: value.type === "script" ? value.command : "",
				timeoutSeconds: value.type === "script" || value.type === "prompt" ? value.timeoutSeconds : undefined,
			});
		}
		return onChange({
			type,
			prompt: value.type === "prompt" ? value.prompt : "",
			agentProfileId: value.type === "prompt" ? value.agentProfileId : "",
			timeoutSeconds: value.type === "script" || value.type === "prompt" ? value.timeoutSeconds : undefined,
		});
	};
	return (
		<div className="grid gap-3 rounded-lg border p-4">
			<div className="grid gap-2 text-sm font-medium">
				<span>{label}</span>
				<select className="h-10 rounded-md border bg-background px-3" value={value.type} onChange={(event) => updateType(event.target.value as DatasetHook["type"])}>
					<option value="none">None</option>
					<option value="script">Script</option>
					<option value="prompt">Agent prompt</option>
				</select>
			</div>
			{value.type === "script" && <label className="grid gap-2 text-sm font-medium">Command<Textarea required value={value.command} onChange={(event) => onChange({ ...value, command: event.target.value })} placeholder="python prepare.py" /></label>}
			{value.type === "prompt" && <>
				<label className="grid gap-2 text-sm font-medium">Prompt<Textarea required value={value.prompt} onChange={(event) => onChange({ ...value, prompt: event.target.value })} placeholder="Prepare or evaluate the current dataset workspace." /></label>
				<label className="grid gap-2 text-sm font-medium">Agent profile<select className="h-10 rounded-md border bg-background px-3" required value={value.agentProfileId} onChange={(event) => onChange({ ...value, agentProfileId: event.target.value })}><option value="">Select an agent profile</option>{agentProfiles.filter((profile) => profile.isEnabled).map((profile) => <option key={profile.agentProfileId} value={profile.agentProfileId}>{profile.name}</option>)}</select></label>
			</>}
			{value.type !== "none" && <label className="grid gap-2 text-sm font-medium">Timeout (seconds)<Input type="number" min={1} max={86400} value={value.timeoutSeconds ?? 3600} onChange={(event) => onChange({ ...value, timeoutSeconds: Math.max(1, Number(event.target.value) || 1) })} /></label>}
		</div>
	);
};
