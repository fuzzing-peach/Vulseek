import { candidateSchema, type Candidate } from "../artifacts/contracts/domain-object.contract";
import {
	readTaskJsonArtifact,
	writeTaskJsonArtifact,
} from "../artifacts/task-artifact-paths";
import { createCandidateId } from "../candidate-id";

export const rewriteCandidateManifestIds = async <TManifest extends { candidates: string[] }>(input: {
	taskDir: string;
	manifest: TManifest;
}) => {
	const seenIds = new Set<string>();
	const rewrittenCandidates: string[] = [];
	const candidateIdMap = new Map<string, string>();

	const nextCandidateId = () => {
		let candidateId = createCandidateId();
		while (seenIds.has(candidateId)) {
			candidateId = createCandidateId();
		}
		seenIds.add(candidateId);
		return candidateId;
	};

	for (const candidatePath of input.manifest.candidates) {
		const candidate = candidateSchema.parse(
			await readTaskJsonArtifact<Candidate>({
				taskDir: input.taskDir,
				containerPath: candidatePath,
			}),
		);
		const nextId = nextCandidateId();
		candidateIdMap.set(candidate.id, nextId);
		const rewrittenPath = await writeTaskJsonArtifact({
			taskDir: input.taskDir,
			relativePath: `candidates/${nextId}.json`,
			value: {
				...candidate,
				id: nextId,
			},
		});
		rewrittenCandidates.push(rewrittenPath);
	}

	return {
		manifest: {
			...input.manifest,
			candidates: rewrittenCandidates,
		},
		candidateIdMap,
	};
};

