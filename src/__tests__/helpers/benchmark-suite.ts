import { describe, expect, test } from 'vitest';
import type { BenchFn, BenchFnOptions } from 'vitest';

interface BenchmarkRegistration {
	name: string
	fn: BenchFn
	setup?: BenchmarkSetup
}

interface BenchmarkSetupTask {
	opts: BenchFnOptions
}

type BenchmarkSetup = (task: BenchmarkSetupTask) => void;

export interface BenchmarkRegistrar {
	(name: string, fn: BenchFn, options?: { setup: BenchmarkSetup }): void
	skip(name: string, fn: BenchFn, options?: { setup: BenchmarkSetup }): void
}

export function benchmarkSuite(name: string, define: (bench: BenchmarkRegistrar) => void): void {
	describe.each([name])('%s', () => {
		const registrations: Array<BenchmarkRegistration> = [];
		const bench = Object.assign(
			(registrationName: string, fn: BenchFn, options?: { setup: BenchmarkSetup }) => {
				registrations.push({ name: registrationName, fn, setup: options?.setup });
			},
			{
				skip(registrationName: string) {
					test.skip.each([registrationName])('%s', () => {
						expect.unreachable();
					});
				},
			},
		);

		define(bench);

		test('benchmarks', { timeout: Math.max(60_000, registrations.length * 30_000) }, async ({ bench: createBench }) => {
			const runnable = registrations.map(({ name: registrationName, fn, setup }) => {
				const options: BenchFnOptions = {};
				setup?.({ opts: options });
				return Object.keys(options).length
					? createBench(registrationName, options, fn)
					: createBench(registrationName, fn);
			});
			expect(runnable.length).toBeGreaterThan(0);
			if(runnable.length === 1) {
				await runnable[0].run();
			} else {
				await createBench.compare(...runnable);
			}
		});
	});
}
