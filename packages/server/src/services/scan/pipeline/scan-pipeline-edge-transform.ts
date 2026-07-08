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
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const readPath = (root: unknown, path: string) => {
	if (!path) {
		return root;
	}
	let current = root;
	for (const part of path.split(".")) {
		if (!part) {
			continue;
		}
		if (!isRecord(current)) {
			throw new Error(`Cannot read path ${path}`);
		}
		current = current[part];
	}
	return current;
};

const evaluateExpression = (
	expression: string,
	context: PipelineEdgeTransformContext,
) => {
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

const renderTemplate = (
	template: unknown,
	context: PipelineEdgeTransformContext,
): unknown => {
	if (typeof template === "string" && template.startsWith("$")) {
		return evaluateExpression(template, context);
	}
	if (Array.isArray(template)) {
		return template.map((item) => renderTemplate(item, context));
	}
	if (isRecord(template)) {
		return Object.fromEntries(
			Object.entries(template).map(([key, value]) => [
				key,
				renderTemplate(value, context),
			]),
		);
	}
	return template;
};

const evaluateForEach = (
	foreach: string | null | undefined,
	context: PipelineEdgeTransformContext,
) => {
	if (!foreach?.startsWith("$.") || !foreach.endsWith("[*]")) {
		throw new Error(`Unsupported foreach expression: ${foreach ?? ""}`);
	}
	const value = readPath(context.stageOutput, foreach.slice(2, -3));
	if (!Array.isArray(value)) {
		throw new Error(`foreach expression did not resolve to an array: ${foreach}`);
	}
	return value;
};

export const transformPipelineEdgeInput = (
	config: PipelineEdgeTransformConfig,
	context: PipelineEdgeTransformContext,
) => {
	const mode = config.mode ?? "map";
	if (mode === "map") {
		return [renderTemplate(config.input ?? {}, context)];
	}
	if (mode === "fanOut") {
		return evaluateForEach(config.foreach, context).map((item) =>
			renderTemplate(config.input ?? {}, {
				...context,
				item,
			}),
		);
	}
	throw new Error(`Unsupported edge transform mode: ${mode}`);
};
