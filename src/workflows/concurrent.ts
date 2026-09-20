/**
 * Running several things at once, but not all of them: a subtask is a session,
 * and N sessions opening together is the bill nobody meant to pay.
 */

/**
 * Runs `run` over `items` with at most `concurrency` in flight, in index order.
 *
 * A bounded worker pool, not a `Promise.all`: N subtasks must not open N
 * sessions at once. Results come back **in the order of `items`**, whatever the
 * order they finished in - a caller reading `results[2]` means the third task,
 * always.
 *
 * `run` is expected to handle its own failures; a rejection here rejects the
 * whole map, which is why every combinator hands it a function that returns a
 * failed `Result` instead of throwing.
 */
export async function mapConcurrent<T, R>(
	items: readonly T[],
	concurrency: number,
	run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;

	const worker = async () => {
		for (;;) {
			const index = next++;
			if (index >= items.length) return;
			results[index] = await run(items[index] as T, index);
		}
	};

	const workers = Math.min(Math.max(1, concurrency), items.length);
	await Promise.all(Array.from({ length: workers }, worker));
	return results;
}
