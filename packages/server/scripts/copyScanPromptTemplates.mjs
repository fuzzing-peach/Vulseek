import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, "..");
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
await mkdir(dockerfilesOutputRoot, { recursive: true });
await cp(dockerfilesSourceRoot, dockerfilesOutputRoot, { recursive: true });
