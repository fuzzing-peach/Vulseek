import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
const sourceRoot = path.join(packageRoot, "src", "services", "scan");
const outputRoot = path.join(packageRoot, "dist", "services", "scan");
const dockerfilesSourceRoot = path.join(
	packageRoot,
	"src",
	"services",
	"dockerfiles",
);
const dockerfilesOutputRoot = path.join(
	packageRoot,
	"dist",
	"services",
	"dockerfiles",
);

const copyPromptTemplates = async (sourceDir) => {
	const entries = await readdir(sourceDir, { withFileTypes: true });
	for (const entry of entries) {
		const sourcePath = path.join(sourceDir, entry.name);
		if (entry.isDirectory()) {
			await copyPromptTemplates(sourcePath);
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".prompt.md")) {
			continue;
		}
		const relativePath = path.relative(sourceRoot, sourcePath);
		const outputPath = path.join(outputRoot, relativePath);
		await mkdir(path.dirname(outputPath), { recursive: true });
		await cp(sourcePath, outputPath);
	}
};

await copyPromptTemplates(sourceRoot);
await mkdir(path.join(outputRoot, "pipeline"), { recursive: true });
await cp(
	path.join(sourceRoot, "pipeline", "definitions"),
	path.join(outputRoot, "pipeline", "definitions"),
	{ recursive: true },
);
await mkdir(dockerfilesOutputRoot, { recursive: true });
await cp(dockerfilesSourceRoot, dockerfilesOutputRoot, { recursive: true });
