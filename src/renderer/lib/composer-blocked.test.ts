import { afterEach, describe, expect, it } from "vitest";
import { awaitedInput, createExtensionUiStore } from "../stores/extension-ui";
import { composerBlockedBy } from "./composer-blocked";

describe("composerBlockedBy", () => {
	it("names an approval before a question", () => {
		expect(composerBlockedBy("approval")).toBe("approval");
		expect(composerBlockedBy("input")).toBe("ask");
		expect(composerBlockedBy(null)).toBeNull();
	});
});

describe("composerBlockedBy over the store that holds the cards", () => {
	const extension = createExtensionUiStore();
	afterEach(() => {
		extension.setState({ pendingRequests: [], loginRequestIds: {} });
	});
	const blocked = () => composerBlockedBy(awaitedInput(extension.getState()));

	it("sees an ask card and a tool approval, and nothing once they are answered", () => {
		expect(blocked()).toBeNull();

		extension.getState().pushRequest({
			type: "extension_ui_request",
			id: "q1",
			method: "input",
			title: "Which file?",
		});
		expect(blocked()).toBe("ask");
		extension.getState().removeRequest("q1");

		extension.getState().pushRequest({
			type: "extension_ui_request",
			id: "a1",
			method: "select",
			title: "Allow tool: bash\nrm -rf build",
			options: ["Approve", "Deny"],
		});
		expect(blocked()).toBe("approval");
		extension.getState().removeRequest("a1");
		expect(blocked()).toBeNull();
	});
});
