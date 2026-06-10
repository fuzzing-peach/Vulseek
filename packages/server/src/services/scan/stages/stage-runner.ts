export const runOptionalStageHook = async (hook?: () => Promise<unknown>) => {
	await hook?.().catch(() => {});
};

export abstract class AbstractStage<TOutput> {
	async run(): Promise<TOutput> {
		await this.onStart();

		try {
			const result = await this.execute();
			await this.onComplete(result);
			return result;
		} catch (error) {
			await this.onError(error).catch(() => {});
			throw error;
		} finally {
			await this.onFinally().catch(() => {});
		}
	}

	protected async onStart(): Promise<void> {}

	protected abstract execute(): Promise<TOutput>;

	protected async onComplete(_result: TOutput): Promise<void> {}

	protected async onError(_error: unknown): Promise<void> {}

	protected async onFinally(): Promise<void> {}
}
