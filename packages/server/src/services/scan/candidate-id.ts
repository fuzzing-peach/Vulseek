import { randomUUID } from "node:crypto";

const SHORT_CANDIDATE_ID_LENGTH = 6;

export const createCandidateId = () =>
	`candidate-${randomUUID().replace(/-/g, "").slice(0, SHORT_CANDIDATE_ID_LENGTH)}`;

