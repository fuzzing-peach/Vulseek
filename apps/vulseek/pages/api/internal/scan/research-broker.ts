import { db } from "@vulseek/server/db";
import {
	exploitChainEvents,
	exploitChains,
	exploitPrimitives,
	researchTrackEvents,
	researchTracks,
	tasks,
	vulnerabilityCandidates,
} from "@vulseek/server/db/schema";
import { and, desc, eq } from "drizzle-orm";
import type { NextApiRequest, NextApiResponse } from "next";

const operations = new Set([
	"list-tracks",
	"get-track",
	"list-track-events",
	"list-findings",
	"list-primitives",
	"list-chains",
	"get-chain",
	"list-chain-events",
]);

const asString = (value: unknown) =>
	typeof value === "string" && value.trim() ? value.trim() : null;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
	if (req.method !== "POST") {
		res.status(405).json({ message: "Method not allowed" });
		return;
	}
	const configuredToken = process.env.VULSEEK_RESEARCH_BROKER_TOKEN?.trim();
	const authorization = req.headers.authorization || "";
	if (!configuredToken || authorization !== `Bearer ${configuredToken}`) {
		res.status(401).json({ message: "Unauthorized" });
		return;
	}
	const body = (req.body || {}) as Record<string, unknown>;
	const operation = asString(body.operation);
	const scanJobId = asString(body.scanJobId);
	const taskId = asString(body.taskId);
	if (!operation || !operations.has(operation) || !scanJobId || !taskId) {
		res.status(400).json({ message: "Invalid research broker request" });
		return;
	}
	const [task] = await db
		.select({ taskId: tasks.taskId })
		.from(tasks)
		.where(and(eq(tasks.taskId, taskId), eq(tasks.scanJobId, scanJobId)))
		.limit(1);
	if (!task) {
		res.status(403).json({ message: "Task does not belong to scan job" });
		return;
	}
	const entityId = asString(body.entityId);
	let data: unknown[] = [];
	switch (operation) {
		case "list-tracks":
			data = await db.select().from(researchTracks).where(eq(researchTracks.scanJobId, scanJobId)).orderBy(desc(researchTracks.updatedAt));
			break;
		case "get-track":
			data = entityId ? await db.select().from(researchTracks).where(and(eq(researchTracks.scanJobId, scanJobId), eq(researchTracks.trackId, entityId))).limit(1) : [];
			break;
		case "list-track-events":
			data = await db.select().from(researchTrackEvents).where(entityId ? and(eq(researchTrackEvents.scanJobId, scanJobId), eq(researchTrackEvents.trackId, entityId)) : eq(researchTrackEvents.scanJobId, scanJobId)).orderBy(desc(researchTrackEvents.createdAt));
			break;
		case "list-primitives":
			data = await db.select().from(exploitPrimitives).where(eq(exploitPrimitives.scanJobId, scanJobId)).orderBy(desc(exploitPrimitives.updatedAt));
			break;
		case "list-chains":
			data = await db.select().from(exploitChains).where(eq(exploitChains.scanJobId, scanJobId)).orderBy(desc(exploitChains.updatedAt));
			break;
		case "get-chain":
			data = entityId ? await db.select().from(exploitChains).where(and(eq(exploitChains.scanJobId, scanJobId), eq(exploitChains.chainId, entityId))).limit(1) : [];
			break;
		case "list-chain-events":
			data = await db.select().from(exploitChainEvents).where(entityId ? and(eq(exploitChainEvents.scanJobId, scanJobId), eq(exploitChainEvents.chainId, entityId)) : eq(exploitChainEvents.scanJobId, scanJobId)).orderBy(desc(exploitChainEvents.createdAt));
			break;
		case "list-findings":
			data = await db.select().from(vulnerabilityCandidates).where(eq(vulnerabilityCandidates.scanJobId, scanJobId));
			break;
	}
	res.status(200).json({ data: data.slice(0, 100) });
}
