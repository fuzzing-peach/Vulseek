import { randomUUID } from "node:crypto";
import {
	readTaskJsonArtifact,
	replaceTaskJsonArtifact,
} from "../artifacts/task-artifact-paths";
import type {
	JsonSchemaArtifactAnnotation,
	JsonSchemaContract,
	JsonSchemaValueAnnotation,
} from "./scan-pipeline-schema-contracts";

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

const annotationPath = (value: string) =>
	value.replace(/^output(?:\.|$)/, "").replace(/^\./, "");

const getPath = (value: unknown, path: string) => {
	const parts = annotationPath(path).split(".").filter(Boolean);
	let current = value;
	for (const part of parts) {
		if (!isObject(current)) {
			throw new Error(`Annotation path parent is not an object: ${path}`);
		}
		const isArray = part.endsWith("[]");
		const key = isArray ? part.slice(0, -2) : part;
		current = current[key];
		if (isArray) {
			if (!Array.isArray(current)) {
				throw new Error(`Annotation path must reference an array: ${path}`);
			}
			return current;
		}
	}
	return current;
};

const setPath = (value: unknown, path: string, next: unknown) => {
	const parts = annotationPath(path).split(".").filter(Boolean);
	if (parts.length === 0 || parts.some((part) => part.includes("[]"))) {
		throw new Error(`Unsupported annotation path: ${path}`);
	}
	if (!isObject(value)) {
		throw new Error(`Annotation root must be an object: ${path}`);
	}
	let current = value;
	for (const part of parts.slice(0, -1)) {
		if (!isObject(current)) {
			throw new Error(`Annotation path parent is not an object: ${path}`);
		}
		const child = current[part];
		if (!isObject(child)) current[part] = {};
		current = current[part] as JsonObject;
	}
	if (!isObject(current)) {
		throw new Error(`Annotation path parent is not an object: ${path}`);
	}
	current[parts.at(-1)!] = next;
};

const normalizeArray = (
	value: unknown,
	steps: Array<"trim" | "remove-empty" | "unique">,
) => {
	if (!Array.isArray(value)) {
		throw new Error("normalize annotation requires an array");
	}
	let result = [...value];
	for (const step of steps) {
		if (step === "trim") {
			result = result.map((item) =>
				typeof item === "string" ? item.trim() : item,
			);
		}
		if (step === "remove-empty") {
			result = result.filter(
				(item) => item !== null && item !== undefined && item !== "",
			);
		}
		if (step === "unique") {
			const seen = new Set<string>();
			result = result.filter((item) => {
				const key = JSON.stringify(item);
				if (seen.has(key)) return false;
				seen.add(key);
				return true;
			});
		}
	}
	return result;
};

const applyValueAnnotations = (
	value: unknown,
	annotations: readonly JsonSchemaValueAnnotation[],
) => {
	const generated = new Set<string>();
	for (const annotation of annotations) {
		if (annotation.kind === "generate") {
			let generatedValue = "";
			do {
				generatedValue = `${annotation.prefix}${randomUUID()
					.replace(/-/g, "")
					.slice(0, annotation.length)}`;
			} while (generated.has(generatedValue));
			generated.add(generatedValue);
			setPath(value, annotation.path, generatedValue);
			continue;
		}
		setPath(
			value,
			annotation.path,
			normalizeArray(getPath(value, annotation.path), annotation.steps),
		);
	}
	return value;
};

const transformArtifact = async (input: {
	taskDir: string;
	annotation: JsonSchemaArtifactAnnotation;
	artifactPath: string;
}) => {
	const artifact = await readTaskJsonArtifact({
		taskDir: input.taskDir,
		containerPath: input.artifactPath,
	});
	applyValueAnnotations(artifact, input.annotation.valueAnnotations);
	await replaceTaskJsonArtifact({
		taskDir: input.taskDir,
		containerPath: input.artifactPath,
		value: artifact,
	});
};

export const applySchemaTransforms = async (input: {
	contract: JsonSchemaContract;
	taskDir: string;
	value: unknown;
}) => {
	applyValueAnnotations(input.value, input.contract.valueAnnotations);
	for (const annotation of input.contract.artifactAnnotations) {
		const outputPath = getPath(input.value, annotation.path);
		const paths = annotation.kind === "path_list" ? outputPath : [outputPath];
		if (!Array.isArray(paths)) {
			throw new Error(`${annotation.path} must contain artifact paths`);
		}
		for (const artifactPath of paths) {
			if (typeof artifactPath !== "string") {
				throw new Error(`${annotation.path} must contain artifact path strings`);
			}
			await transformArtifact({
				taskDir: input.taskDir,
				annotation,
				artifactPath,
			});
		}
	}
	return input.value;
};
