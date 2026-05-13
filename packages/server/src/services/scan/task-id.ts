import { randomUUID } from "node:crypto";

export const createShortTaskId = () =>
	randomUUID().replace(/-/g, "").slice(0, 8);
