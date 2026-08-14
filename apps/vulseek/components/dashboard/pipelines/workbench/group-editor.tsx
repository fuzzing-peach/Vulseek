import * as React from "react";
import type {
	PipelineDiagnostic,
	PipelineDocumentV3,
	PipelineGroupV3,
} from "@vulseek/server/services/scan/pipeline/document-v3";
import { deleteBlockers, groupReferrers } from "@/lib/pipeline-editor/definition-helpers";
import type { PipelineEditorAction } from "@/lib/pipeline-editor/pipeline-editor-state";
import {
	CheckboxField,
	EntityDiagnostics,
	SectionHeading,
	SelectField,
	TextField,
} from "./workbench-fields";

/**
 * Group editor: name, leader, members, and group-specific metadata. Inline
 * diagnostics surface missing leaders, duplicate membership, and members
 * that are unreachable from the root. Group changes update Visual swimlanes
 * but never alter stage execution semantics.
 */

export type GroupEditorProps = {
	groupId: string;
	group: PipelineGroupV3;
	document: PipelineDocumentV3;
	diagnostics: PipelineDiagnostic[];
	dispatch: React.Dispatch<PipelineEditorAction>;
	readOnly: boolean;
};

export const GroupEditor = ({
	groupId,
	group,
	document,
	diagnostics,
	dispatch,
	readOnly,
}: GroupEditorProps) => {
	const patch = (next: PipelineGroupV3, key: string) =>
		dispatch({ type: "patch", ops: [{ op: "updateGroup", groupId, group: next }], key });

	const stageOptions = Object.keys(document.stages).map((id) => ({
		value: id,
		label: `${document.stages[id]?.name ?? id} (${id})`,
	}));
	const members = group.members;
	const duplicateMembers = members.filter(
		(member, index) => members.indexOf(member) !== index,
	);
	const leaderMember = members.includes(group.leader);

	// Reachability from root (for the "disconnected member" hint).
	const reachable = new Set<string>([document.root]);
	const queue = [document.root];
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const edge of document.edges) {
			if (edge.from === current && !reachable.has(edge.to)) {
				reachable.add(edge.to);
				queue.push(edge.to);
			}
		}
	}
	const disconnected = members.filter((member) => !reachable.has(member));
	const blockers = deleteBlockers(document, "group", groupId);

	return (
		<div className="flex h-full min-h-0 flex-col">
			<SectionHeading title={group.name} subtitle={`${groupId} · ${members.length} members`} />
			<EntityDiagnostics diagnostics={diagnostics} />
			<div className="min-h-0 flex-1 overflow-y-auto p-4 pb-12">
				<div className="space-y-4">
					<TextField
						label="ID (immutable)"
						value={groupId}
						readOnly
					/>
					<TextField
						label="Name"
						value={group.name}
						readOnly={readOnly}
						onChange={(name) => patch({ ...group, name }, `group:${groupId}:name`)}
					/>
					<SelectField
						label="Leader"
						value={group.leader}
						options={stageOptions}
						readOnly={readOnly}
						description="The leader stage anchors the group's swimlane."
						onChange={(leader) => patch({ ...group, leader }, `group:${groupId}:leader`)}
					/>
					<div className="space-y-2">
						<p className="text-xs font-medium text-foreground">Members</p>
						<div className="grid grid-cols-1 gap-1.5">
							{Object.entries(document.stages).map(([id, stage]) => (
								<CheckboxField
									key={id}
									label={`${stage.name} (${id})`}
									checked={members.includes(id)}
									readOnly={readOnly}
									onChange={(checked) =>
										patch(
											{
												...group,
												members: checked
													? [...members, id]
													: members.filter((member) => member !== id),
											},
											`group:${groupId}:members`,
										)
									}
								/>
							))}
						</div>
					</div>

					{!leaderMember ? (
						<p className="text-xs text-amber-600">
							The leader is not a member of this group.
						</p>
					) : null}
					{duplicateMembers.length > 0 ? (
						<p className="text-xs text-amber-600">
							Duplicate membership: {[...new Set(duplicateMembers)].join(", ")}
						</p>
					) : null}
					{disconnected.length > 0 ? (
						<p className="text-xs text-muted-foreground">
							Members not reachable from the root: {disconnected.join(", ")}
						</p>
					) : null}
					<p className="text-xs text-muted-foreground">
						{groupReferrers(document, groupId).length} stage(s) in this group.
					</p>

					{!readOnly ? (
						<div className="space-y-2">
							{blockers.length > 0 ? (
								<div className="space-y-1 rounded-md border border-red-500/30 bg-red-500/5 p-3">
									<p className="text-xs font-semibold text-red-600">Cannot delete — referenced:</p>
									{blockers.map((blocker, index) => (
										<p key={index} className="text-xs text-red-600">
											{blocker.message}
										</p>
									))}
								</div>
							) : (
								<button
									type="button"
									onClick={() => {
										if (window.confirm(`Delete group "${groupId}"?`)) {
											dispatch({ type: "patch", ops: [{ op: "deleteGroup", groupId }] });
										}
									}}
									className="rounded-md border border-red-500/30 px-3 py-1.5 text-xs text-red-600 hover:bg-red-500/10"
								>
									Delete group
								</button>
							)}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
};
