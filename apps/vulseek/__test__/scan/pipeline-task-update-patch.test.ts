import { buildPipelineTaskUpdatePatch } from "@vulseek/server/services/scan/pipeline/task-update-patch";
import { expect, it } from "vitest";

it("forwards the candidate relation to task persistence", () => {
	expect(
		buildPipelineTaskUpdatePatch({
			output: { result: "real_vulnerability" },
			vulnerabilityCandidateId: "candidate-1",
		}),
	).toMatchObject({
		output: { result: "real_vulnerability" },
		vulnerabilityCandidateId: "candidate-1",
	});
});
