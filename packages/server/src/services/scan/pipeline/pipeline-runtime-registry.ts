const PIPELINE_RUNTIME_REGISTRY_KEY = Symbol.for(
	"vulseek.scan.pipeline-runtime-registry",
);

type GlobalWithPipelineRuntimeRegistry = typeof globalThis & {
	[key: symbol]: unknown;
};

const globalState = globalThis as GlobalWithPipelineRuntimeRegistry;

export const getPipelineRuntimeRegistry = <TRuntime = unknown>() => {
	const existing = globalState[PIPELINE_RUNTIME_REGISTRY_KEY];
	if (existing instanceof Map) {
		return existing as Map<string, TRuntime>;
	}

	const registry = new Map<string, TRuntime>();
	globalState[PIPELINE_RUNTIME_REGISTRY_KEY] = registry;
	return registry;
};

export const setPipelineRuntime = <TRuntime>(key: string, runtime: TRuntime) => {
	getPipelineRuntimeRegistry<TRuntime>().set(key, runtime);
};

export const deletePipelineRuntime = <TRuntime>(
	key: string,
	runtime: TRuntime,
) => {
	const registry = getPipelineRuntimeRegistry<TRuntime>();
	if (registry.get(key) !== runtime) {
		return false;
	}
	return registry.delete(key);
};
