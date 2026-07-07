import { promises as fs } from "node:fs";
import path from "node:path";

export const SECURITY_POLICY_FILE_NAME = "security-policy.md";

export type SecurityPolicyArtifactPaths = {
	hostPath: string;
	containerPath: string;
};

export const buildScanJobSecurityPolicyArtifactPaths = (input: {
	profileHostPath: string;
	profileContainerPath: string;
	scanJobId: string;
}): SecurityPolicyArtifactPaths => ({
	hostPath: path.join(
		input.profileHostPath,
		"jobs",
		input.scanJobId,
		SECURITY_POLICY_FILE_NAME,
	),
	containerPath: path.posix.join(
		input.profileContainerPath,
		"jobs",
		input.scanJobId,
		SECURITY_POLICY_FILE_NAME,
	),
});

export const buildSecurityPolicyPromptInstruction = (
	containerPath: string,
) =>
	`Security Policy: read and follow ${containerPath}. Do not report findings outside this policy.`;

export const writeScanJobSecurityPolicyArtifact = async (
	input: {
		securityPolicy?: string | null;
		profileHostPath: string;
		profileContainerPath: string;
		scanJobId: string;
	},
	deps: {
		mkdir?: typeof fs.mkdir;
		writeFile?: typeof fs.writeFile;
	} = {},
) => {
	const securityPolicy = input.securityPolicy?.trim();
	if (!securityPolicy) {
		return null;
	}

	const paths = buildScanJobSecurityPolicyArtifactPaths(input);
	await (deps.mkdir ?? fs.mkdir)(path.dirname(paths.hostPath), {
		recursive: true,
	});
	await (deps.writeFile ?? fs.writeFile)(paths.hostPath, `${securityPolicy}\n`, "utf-8");
	return {
		...paths,
		instruction: buildSecurityPolicyPromptInstruction(paths.containerPath),
	};
};
