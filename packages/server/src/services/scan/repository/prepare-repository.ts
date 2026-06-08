import { execAsync } from "../../../utils/process/execAsync";

const escapeSingleQuotes = (value: string) => value.replace(/'/g, `'"'"'`);

export type PreparedRepositoryState = {
	effectiveTargetMode: string;
	targetRef: string | null;
	targetTag: string | null;
	requestedCommitSha: string | null;
	requestedBaseSha: string | null;
	commitWindow: number;
	resolvedTargetSha: string;
	resolvedTargetShort: string;
	resolvedBaseSha: string | null;
	targetSubject: string;
	currentBranch: string | null;
	currentExactTag: string | null;
};

export const prepareRepositoryForScanInContainer = async (input: {
	containerName: string;
	scanType: "delta" | "full";
	targetRef?: string | null;
	targetTag?: string | null;
	commitSha?: string | null;
	baseSha?: string | null;
	commitWindow: number;
	scanRootDir: string;
}): Promise<PreparedRepositoryState> => {
	const forceLatestRef = input.scanType === "delta";
	const preferLatestTag = input.scanType === "full";
	const targetRef = input.targetRef?.trim() || "";
	const targetTag = input.targetTag?.trim() || "";
	const requestedCommit = input.commitSha?.trim() || "";
	const requestedBase = input.baseSha?.trim() || "";
	const commitWindow = input.commitWindow;
	const isDeltaScan = input.scanType === "delta";

	const shellScript = [
		`SCAN_ROOT='${escapeSingleQuotes(input.scanRootDir)}'`,
		"mkdir -p \"$SCAN_ROOT\"",
		"TASK_STDOUT=\"$SCAN_ROOT/task-stdout.log\"",
		"PREPARE_STDOUT=\"$SCAN_ROOT/00_repository_prepare.stdout.log\"",
		"PREPARE_STDERR=\"$SCAN_ROOT/00_repository_prepare.stderr.log\"",
		": > \"$TASK_STDOUT\"",
		": > \"$PREPARE_STDOUT\"",
		": > \"$PREPARE_STDERR\"",
		"exec > >(tee -a \"$PREPARE_STDOUT\" \"$TASK_STDOUT\") 2> >(tee -a \"$PREPARE_STDERR\" >&2)",
		"set -Eeuo pipefail",
		"CURRENT_CMD=\"(initializing)\"",
		"trap 'rc=$?; echo \"[error] command failed (exit ${rc}): ${CURRENT_CMD}\" >&2' ERR",
		"run() {",
		"  CURRENT_CMD=\"$*\"",
		"  echo \"[cmd] $CURRENT_CMD\"",
		"  \"$@\"",
		"}",
		"cd /workspace/repo",
		"CURRENT_BRANCH=\"$(git symbolic-ref --quiet --short HEAD || true)\"",
		"echo \"[info] using repository state from checkout image; skipping remote fetch/pull\"",
		`TARGET_REF='${escapeSingleQuotes(targetRef)}'`,
		`TARGET_TAG='${escapeSingleQuotes(targetTag)}'`,
		`REQUESTED_COMMIT='${escapeSingleQuotes(requestedCommit)}'`,
		`REQUESTED_BASE='${escapeSingleQuotes(requestedBase)}'`,
		`COMMIT_WINDOW='${commitWindow}'`,
		`FORCE_LATEST_REF='${forceLatestRef ? "true" : "false"}'`,
		`PREFER_LATEST_TAG='${preferLatestTag ? "true" : "false"}'`,
		"RESOLVED_TARGET=\"\"",
		"EFFECTIVE_TARGET_MODE=\"explicit\"",
		"if [ \"$FORCE_LATEST_REF\" = \"true\" ]; then",
		"  EFFECTIVE_TARGET_MODE=\"latest-ref\"",
		"  if [ -n \"$CURRENT_BRANCH\" ]; then",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"    TARGET_REF=\"$CURRENT_BRANCH\"",
		"    TARGET_TAG=\"\"",
		"    REQUESTED_COMMIT=\"\"",
		"  else",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"    TARGET_REF=\"HEAD\"",
		"    TARGET_TAG=\"\"",
		"    REQUESTED_COMMIT=\"\"",
		"  fi",
		"elif [ \"$PREFER_LATEST_TAG\" = \"true\" ] && [ -z \"$TARGET_TAG\" ]; then",
		"  CURRENT_CMD=\"git for-each-ref --sort=-creatordate --count=1 --format=%(refname:short) refs/tags\"",
		"  LATEST_TAG=\"$(git for-each-ref --sort=-creatordate --count=1 --format='%(refname:short)' refs/tags)\"",
		"  if [ -n \"$LATEST_TAG\" ]; then",
		"    EFFECTIVE_TARGET_MODE=\"latest-tag\"",
		"    TARGET_TAG=\"$LATEST_TAG\"",
		"    TARGET_REF=\"\"",
		"    REQUESTED_COMMIT=\"\"",
		"    CURRENT_CMD=\"git rev-parse --verify refs/tags/$TARGET_TAG^{commit}\"",
		"    git rev-parse --verify \"refs/tags/$TARGET_TAG^{commit}\" >/dev/null",
		"    run git checkout -f \"refs/tags/$TARGET_TAG\"",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"  else",
		"    EFFECTIVE_TARGET_MODE=\"latest-head-no-tag\"",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"  fi",
		"elif [ -n \"$TARGET_TAG\" ]; then",
		"  CURRENT_CMD=\"git rev-parse --verify refs/tags/$TARGET_TAG^{commit}\"",
		"  git rev-parse --verify \"refs/tags/$TARGET_TAG^{commit}\" >/dev/null",
		"  run git checkout -f \"refs/tags/$TARGET_TAG\"",
		"  RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"elif [ -n \"$TARGET_REF\" ]; then",
		"  CURRENT_CMD=\"git rev-parse --verify $TARGET_REF^{commit}\"",
		"  if git rev-parse --verify \"$TARGET_REF^{commit}\" >/dev/null 2>&1; then",
		"    run git checkout -f \"$TARGET_REF\"",
		"  else",
		"    CURRENT_CMD=\"git rev-parse --verify origin/$TARGET_REF^{commit}\"",
		"    if git rev-parse --verify \"origin/$TARGET_REF^{commit}\" >/dev/null 2>&1; then",
		"      run git checkout -f \"origin/$TARGET_REF\"",
		"    else",
		"      echo \"Unable to resolve targetRef: $TARGET_REF\" >&2",
		"      exit 1",
		"    fi",
		"  fi",
		"  RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"elif [ -n \"$REQUESTED_COMMIT\" ]; then",
		"  CURRENT_CMD=\"git rev-parse --verify $REQUESTED_COMMIT^{commit}\"",
		"  if git rev-parse --verify \"$REQUESTED_COMMIT^{commit}\" >/dev/null 2>&1; then",
		"    run git checkout -f \"$REQUESTED_COMMIT\"",
		"    RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"  else",
		"    echo \"Unable to resolve commitSha: $REQUESTED_COMMIT\" >&2",
		"    exit 1",
		"  fi",
		"else",
		"  RESOLVED_TARGET=\"$(git rev-parse HEAD)\"",
		"fi",
		"TARGET_SUBJECT=\"$(git log -1 --format=%s \"$RESOLVED_TARGET\")\"",
		"TARGET_SHORT=\"$(git rev-parse --short \"$RESOLVED_TARGET\")\"",
		"CURRENT_EXACT_TAG=\"$(git describe --tags --exact-match HEAD 2>/dev/null || true)\"",
		...(isDeltaScan
			? [
					"if [ -n \"$REQUESTED_BASE\" ] && git rev-parse --verify \"$REQUESTED_BASE^{commit}\" >/dev/null 2>&1; then",
					"  RESOLVED_BASE=\"$REQUESTED_BASE\"",
					"else",
					"  RESOLVED_BASE=\"$(git rev-parse \"$RESOLVED_TARGET~$COMMIT_WINDOW\" 2>/dev/null || true)\"",
					"fi",
			  ]
			: ["RESOLVED_BASE=\"\""]),
		"jq -n \\",
		"  --arg effectiveTargetMode \"$EFFECTIVE_TARGET_MODE\" \\",
		"  --arg targetRef \"$TARGET_REF\" \\",
		"  --arg targetTag \"$TARGET_TAG\" \\",
		"  --arg requestedCommitSha \"$REQUESTED_COMMIT\" \\",
		"  --arg requestedBaseSha \"$REQUESTED_BASE\" \\",
		"  --arg resolvedTargetSha \"$RESOLVED_TARGET\" \\",
		"  --arg resolvedBaseSha \"$RESOLVED_BASE\" \\",
		"  --arg resolvedTargetShort \"$TARGET_SHORT\" \\",
		"  --arg targetSubject \"$TARGET_SUBJECT\" \\",
		"  --arg currentBranch \"$CURRENT_BRANCH\" \\",
		"  --arg currentExactTag \"$CURRENT_EXACT_TAG\" \\",
		"  --argjson commitWindow \"$COMMIT_WINDOW\" \\",
		"  '{",
		"    effectiveTargetMode: $effectiveTargetMode,",
		"    targetRef: (if $targetRef == \"\" then null else $targetRef end),",
		"    targetTag: (if $targetTag == \"\" then null else $targetTag end),",
		"    requestedCommitSha: (if $requestedCommitSha == \"\" then null else $requestedCommitSha end),",
		"    requestedBaseSha: (if $requestedBaseSha == \"\" then null else $requestedBaseSha end),",
		"    commitWindow: $commitWindow,",
		"    resolvedTargetSha: $resolvedTargetSha,",
		"    resolvedTargetShort: $resolvedTargetShort,",
		"    resolvedBaseSha: (if $resolvedBaseSha == \"\" then null else $resolvedBaseSha end),",
		"    targetSubject: $targetSubject,",
		"    currentBranch: (if $currentBranch == \"\" then null else $currentBranch end),",
		"    currentExactTag: (if $currentExactTag == \"\" then null else $currentExactTag end)",
		"  }' > \"$SCAN_ROOT/00_repository_state.json\"",
	].join("\n");
	const encoded = Buffer.from(shellScript, "utf-8").toString("base64");

	await execAsync(
		`docker exec ${input.containerName} bash -lc "echo '${encoded}' | base64 -d | bash"`,
	).catch(async (error: unknown) => {
		let prepareStdout = "";
		let prepareStderr = "";
		try {
			const stdoutRead = await execAsync(
				`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_prepare.stdout.log' 2>/dev/null || true"`,
			);
			prepareStdout = stdoutRead.stdout.trim();
		} catch {}
		try {
			const stderrRead = await execAsync(
				`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_prepare.stderr.log' 2>/dev/null || true"`,
			);
			prepareStderr = stderrRead.stdout.trim();
		} catch {}

		const message = error instanceof Error ? error.message : "Repository prepare failed";
		const tail = (value: string) =>
			value
				.split("\n")
				.slice(-40)
				.join("\n")
				.trim();
		throw new Error(
			[
				message,
				prepareStdout ? `prepare_stdout_tail:\n${tail(prepareStdout)}` : "",
				prepareStderr ? `prepare_stderr_tail:\n${tail(prepareStderr)}` : "",
			]
				.filter(Boolean)
				.join("\n\n"),
		);
	});

	const repositoryStateJson = await execAsync(
		`docker exec ${input.containerName} bash -lc "cat '${input.scanRootDir}/00_repository_state.json'"`,
	);

	return JSON.parse(repositoryStateJson.stdout) as PreparedRepositoryState;
};
