/**
 * `src/main/snowflake.ts` copies stock pi-utils `snowflake` (`Snowflake.Source`), because tab ids are minted before
 * omp starts. Stock's source, started one step before our sequence, mints the same ids for the same clock readings.
 */
import { describe, expect, it } from "vitest";
import { nextSnowflake } from "./snowflake";
import { runStock, stockSource } from "./test-bridge-probe";

const snowflake = stockSource("pi-utils", "snowflake.ts");
const EPOCH = 1420070400000;

describe.skipIf(!snowflake)("nextSnowflake against the installed stock Snowflake", () => {
	it("mints stock's ids, including clocks before the epoch and past the 42-bit field", () => {
		const now = Date.now();
		const times = [now, now, now + 1, EPOCH, EPOCH - 1, 0, EPOCH + 2 ** 42, 1_800_000_000_000];
		const ours = times.map(time => nextSnowflake(time));
		const firstSequence = Number(BigInt(`0x${ours[0]}`) & 0x3fffffn);
		const stock = runStock<string[]>(
			`const { Snowflake } = await import(${JSON.stringify(snowflake)});
			const source = new Snowflake.Source(${firstSequence - 1});
			const ids = ${JSON.stringify(times)}.map(time => source.generate(time));
			if (!ids.every(id => Snowflake.valid(id))) throw new Error("stock minted an invalid id");
			console.log(JSON.stringify(ids));`,
		);
		expect(ours).toEqual(stock);
	}, 90_000);
});
