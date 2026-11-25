import { describe, expect, it } from "vitest";
import { matchReportAccount, type StoredAccount } from "../../resources/gui-bridge/accounts-core";

const first: StoredAccount = { credentialId: 1, active: true };
const second: StoredAccount = { credentialId: 2, active: false };
describe("stock account candidate reconciliation", () => {
	it("only attributes a unique stock match", () => {
		expect(matchReportAccount({}, [first, second], 2, (_report, account) => account === second)).toBe(second);
		expect(matchReportAccount({}, [first, second], 2, () => true)).toBeUndefined();
		expect(matchReportAccount({}, [first, second], 2, () => false)).toBeUndefined();
	});
	it("keeps only the single-account single-report fallback", () => {
		expect(matchReportAccount({}, [first], 1, () => false)).toBe(first);
		expect(matchReportAccount({}, [first], 2, () => false)).toBeUndefined();
	});
	it("tells two logins of one email apart by the report's account id", () => {
		// A ChatGPT Pro seat and the same person's Team seat: stock's email-first match takes both for either report.
		const pro: StoredAccount = { credentialId: 3, email: "me@example.test", accountId: "acct-pro", active: false };
		const team: StoredAccount = { credentialId: 4, email: "me@example.test", accountId: "acct-team", active: true };
		const sameEmail = () => true;
		expect(matchReportAccount({}, [pro, team], 2, sameEmail, "acct-team")).toBe(team);
		expect(matchReportAccount({}, [pro, team], 2, sameEmail, "acct-pro")).toBe(pro);
		expect(matchReportAccount({}, [pro, team], 2, sameEmail, "acct-other")).toBeUndefined();
		expect(matchReportAccount({}, [pro, team], 2, sameEmail)).toBeUndefined();
	});
});
