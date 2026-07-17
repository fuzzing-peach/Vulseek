export const runAfterCompletionClaim = async (
	claim: () => Promise<boolean>,
	effect: () => Promise<void>,
) => {
	if (!(await claim())) {
		return false;
	}
	await effect();
	return true;
};
