import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
	buildScanJobSecurityPolicyArtifactPaths,
	buildSecurityPolicyPromptInstruction,
	writeScanJobSecurityPolicyArtifact,
} from "./security-policy-artifact";

test("writeScanJobSecurityPolicyArtifact skips empty policies", async () => {
	let mkdirCalled = false;
	let writeCalled = false;
	const result = await writeScanJobSecurityPolicyArtifact(
		{
			securityPolicy: "  \n ",
			profileHostPath: "/tmp/profile",
			profileContainerPath: "/scan-context/projects/demo/profiles/app",
			scanJobId: "scan-1",
		},
		{
			mkdir: async () => {
				mkdirCalled = true;
				return undefined;
			},
			writeFile: async () => {
				writeCalled = true;
			},
		},
	);

	assert.equal(result, null);
	assert.equal(mkdirCalled, false);
	assert.equal(writeCalled, false);
});

test("writeScanJobSecurityPolicyArtifact writes job policy and prompt instruction", async () => {
	const paths = buildScanJobSecurityPolicyArtifactPaths({
		profileHostPath: "/tmp/profile",
		profileContainerPath: "/scan-context/projects/demo/profiles/app",
		scanJobId: "scan-1",
	});
	let observedMkdirPath = "";
	let observedWritePath = "";
	let observedContent = "";

	const result = await writeScanJobSecurityPolicyArtifact(
		{
			securityPolicy: "In scope: auth\n",
			profileHostPath: "/tmp/profile",
			profileContainerPath: "/scan-context/projects/demo/profiles/app",
			scanJobId: "scan-1",
		},
		{
			mkdir: async (mkdirPath) => {
				observedMkdirPath = String(mkdirPath);
				return undefined;
			},
			writeFile: async (filePath, content) => {
				observedWritePath = String(filePath);
				observedContent = String(content);
			},
		},
	);

	assert.deepEqual(result, {
		...paths,
		instruction: buildSecurityPolicyPromptInstruction(paths.containerPath),
	});
	assert.equal(observedMkdirPath, path.dirname(paths.hostPath));
	assert.equal(observedWritePath, paths.hostPath);
	assert.equal(observedContent, "In scope: auth\n");
	assert.match(result?.instruction || "", /Do not report findings outside this policy/);
});
