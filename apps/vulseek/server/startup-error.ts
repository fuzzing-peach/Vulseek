export const exitOnStartupError = (error: unknown): never => {
	console.error("Main Server Error", error);
	process.exit(1);
};
