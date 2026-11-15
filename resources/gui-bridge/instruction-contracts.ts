/** Retired stock delivery settings: OMPdesk accepts only current instructions. */
export const RETIRED_INSTRUCTION_SETTINGS: ReadonlySet<string> = new Set([
	"steeringMode",
	"followUpMode",
	"interruptMode",
]);

/** A raw page/device command is never an authenticated agent ingress. */
export function isAgentInstructionCommand(command: { type: string }): boolean {
	return command.type === "agent_control_instruction";
}
