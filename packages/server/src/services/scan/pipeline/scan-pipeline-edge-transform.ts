import { promises as fs } from "node:fs";
import path from "node:path";

export type PipelineEdgeTransformConfig = {
	mode?: "map" | "fanOut" | null;
	foreach?: string | null;
	input?: unknown;
};

export type PipelineEdgeTransformContext = {
	ctx: unknown;
	stageInput: unknown;
	stageOutput: unknown;
	item?: unknown;
	/**
	 * Optional JSON file reader for `$file(...)` expressions.
	 * When omitted, `$file` falls back to reading absolute host paths via fs
	 * (still subject to `allowedRoots` when provided).
	 */
	readJsonFile?: (filePath: string) => Promise<unknown>;
	/** When set, `$file` paths must resolve under one of these directories. */
	allowedRoots?: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readPath = (root: unknown, pathExpr: string) => {
	if (!pathExpr) {
		return root;
	}
	let current = root;
	for (const part of pathExpr.split(".")) {
		if (!part) {
			continue;
		}
		if (!isRecord(current)) {
			throw new Error(`Cannot read path ${pathExpr}`);
		}
		current = current[part];
	}
	return current;
};

const FILE_EXPR_PATTERN =
	/^\$file\((.+?)\)((?:\.[A-Za-z0-9_-]+)*)(?:\[\*])?$/;

export const parseFileExpression = (expression: string) => {
	const match = expression.match(FILE_EXPR_PATTERN);
	if (!match) {
		return null;
	}
	return {
		pathExpr: match[1] ?? "",
		fieldPath: (match[2] ?? "").replace(/^\./, ""),
		isForEach: expression.endsWith("[*]"),
	};
};

const assertPathAllowed = (filePath: string, allowedRoots?: string[]) => {
	if (!allowedRoots?.length) {
		return;
	}
	const resolved = path.resolve(filePath);
	const allowed = allowedRoots.some((root) => {
		const resolvedRoot = path.resolve(root);
		return (
			resolved === resolvedRoot ||
			resolved.startsWith(`${resolvedRoot}${path.sep}`)
		);
	});
	if (!allowed) {
		throw new Error(
			`File path escapes allowed roots for $file expression: ${filePath}`,
		);
	}
};

const defaultReadJsonFile = async (
	filePath: string,
	allowedRoots?: string[],
) => {
	assertPathAllowed(filePath, allowedRoots);
	const content = await fs.readFile(filePath, "utf-8");
	return JSON.parse(content) as unknown;
};

const evaluatePathExpression = (
	expression: string,
	context: PipelineEdgeTransformContext,
): unknown => {
	if (expression === "$item") {
		return context.item;
	}
	if (expression.startsWith("$item.")) {
		return readPath(context.item, expression.slice("$item.".length));
	}
	if (expression.startsWith("$input.")) {
		return readPath(context.stageInput, expression.slice("$input.".length));
	}
	if (expression.startsWith("$ctx.")) {
		return readPath(context.ctx, expression.slice("$ctx.".length));
	}
	if (expression.startsWith("$computed.")) {
		return readPath(
			isRecord(context.ctx) ? context.ctx.computed : undefined,
			expression.slice("$computed.".length),
		);
	}
	if (expression.startsWith("$.")) {
		return readPath(context.stageOutput, expression.slice("$.".length));
	}
	throw new Error(`Unsupported transform expression: ${expression}`);
};

const evaluateFileExpression = async (
	expression: string,
	context: PipelineEdgeTransformContext,
	fileCache: Map<string, unknown>,
) => {
	const parsed = parseFileExpression(expression);
	if (!parsed) {
		throw new Error(`Unsupported $file expression: ${expression}`);
	}
	const filePath = evaluatePathExpression(parsed.pathExpr, context);
	if (typeof filePath !== "string" || !filePath.trim()) {
		throw new Error(
			`$file path expression did not resolve to a string: ${parsed.pathExpr}`,
		);
	}
	let json = fileCache.get(filePath);
	if (json === undefined) {
		json = context.readJsonFile
			? await context.readJsonFile(filePath)
			: await defaultReadJsonFile(filePath, context.allowedRoots);
		fileCache.set(filePath, json);
	}
	const value = parsed.fieldPath ? readPath(json, parsed.fieldPath) : json;
	if (parsed.isForEach) {
		if (!Array.isArray(value)) {
			throw new Error(
				`foreach expression did not resolve to an array: ${expression}`,
			);
		}
		return value;
	}
	return value;
};

const evaluateExpression = async (
	expression: string,
	context: PipelineEdgeTransformContext,
	fileCache: Map<string, unknown>,
): Promise<unknown> => {
	if (expression.startsWith("$file(")) {
		return await evaluateFileExpression(expression, context, fileCache);
	}
	return evaluatePathExpression(expression, context);
};

const renderTemplate = async (
	template: unknown,
	context: PipelineEdgeTransformContext,
	fileCache: Map<string, unknown>,
): Promise<unknown> => {
	if (typeof template === "string" && template.startsWith("$")) {
		return await evaluateExpression(template, context, fileCache);
	}
	if (Array.isArray(template)) {
		return await Promise.all(
			template.map((item) => renderTemplate(item, context, fileCache)),
		);
	}
	if (isRecord(template)) {
		const entries = await Promise.all(
			Object.entries(template).map(async ([key, value]) => [
				key,
				await renderTemplate(value, context, fileCache),
			]),
		);
		return Object.fromEntries(entries);
	}
	return template;
};

const evaluateForEach = async (
	foreach: string | null | undefined,
	context: PipelineEdgeTransformContext,
	fileCache: Map<string, unknown>,
) => {
	if (!foreach) {
		throw new Error("Unsupported foreach expression: ");
	}
	if (foreach.startsWith("$file(")) {
		const value = await evaluateFileExpression(foreach, context, fileCache);
		if (!Array.isArray(value)) {
			throw new Error(
				`foreach expression did not resolve to an array: ${foreach}`,
			);
		}
		return value;
	}
	if (!foreach.startsWith("$.") || !foreach.endsWith("[*]")) {
		throw new Error(`Unsupported foreach expression: ${foreach}`);
	}
	// Nullable stage outputs (e.g. scan-target with nullableOutput) mean "no
	// downstream work" — treat missing/null collections as an empty fan-out.
	if (context.stageOutput == null) {
		return [];
	}
	const value = readPath(context.stageOutput, foreach.slice(2, -3));
	if (value == null) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error(
			`foreach expression did not resolve to an array: ${foreach}`,
		);
	}
	return value;
};

export const transformPipelineEdgeInput = async (
	config: PipelineEdgeTransformConfig,
	context: PipelineEdgeTransformContext,
) => {
	const fileCache = new Map<string, unknown>();
	const mode = config.mode ?? "map";
	if (mode === "map") {
		return [await renderTemplate(config.input ?? {}, context, fileCache)];
	}
	if (mode === "fanOut") {
		const items = await evaluateForEach(config.foreach, context, fileCache);
		return await Promise.all(
			items.map((item) =>
				renderTemplate(
					config.input ?? {},
					{
						...context,
						item,
					},
					fileCache,
				),
			),
		);
	}
	throw new Error(`Unsupported edge transform mode: ${mode}`);
};
