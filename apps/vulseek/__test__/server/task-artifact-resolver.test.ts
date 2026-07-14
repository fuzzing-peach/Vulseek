import { expect, it } from "vitest";
import { readCandidateIdFromTaskInputArtifact } from "@vulseek/server/services/scan/persistence/task-artifact-resolver";

it("prefers the persisted candidate relation over the input artifact", async () => {
	const candidateId = await readCandidateIdFromTaskInputArtifact({
		vulnerabilityCandidateId: "candidate-1",
		input: {
			candidatePath: "/task/inputs/missing-candidate.json",
		},
	} as Parameters<typeof readCandidateIdFromTaskInputArtifact>[0]);

	expect(candidateId).toBe("candidate-1");
});
