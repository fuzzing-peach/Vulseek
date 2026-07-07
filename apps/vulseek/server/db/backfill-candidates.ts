import {
	backfillVulnerabilityCandidates,
	closeDbConnection,
} from "@vulseek/server";

const readScanJobId = () => {
	const args = process.argv.slice(2);
	const flagIndex = args.findIndex((arg) => arg === "--scan-job-id");
	if (flagIndex >= 0) {
		return args[flagIndex + 1];
	}
	const inlineFlag = args.find((arg) => arg.startsWith("--scan-job-id="));
	return inlineFlag?.slice("--scan-job-id=".length) || process.env.SCAN_JOB_ID;
};

const scanJobId = readScanJobId();
try {
	const result = await backfillVulnerabilityCandidates({
		...(scanJobId ? { scanJobId } : {}),
	});

	console.log(
		JSON.stringify(
			{
				...result,
				scanJobId: scanJobId || null,
			},
			null,
			2,
		),
	);

	if (result.warnings.length > 0) {
		process.exitCode = 1;
	}
} finally {
	await closeDbConnection();
}
