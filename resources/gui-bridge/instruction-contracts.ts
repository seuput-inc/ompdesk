/** Retired stock delivery settings: OMPdesk accepts only current instructions. */
export const RETIRED_INSTRUCTION_SETTINGS: ReadonlySet<string> = new Set([
	"steeringMode",
	"followUpMode",
	"interruptMode",
]);

/** Public commands that bypass canonical current-instruction admission or original-identity withdrawal. */
export const RETIRED_INSTRUCTION_COMMANDS: ReadonlySet<string> = new Set([
	"steer",
	"follow_up",
	"dequeue",
	"set_steering_mode",
	"set_follow_up_mode",
	"set_interrupt_mode",
]);

/** A raw page/device command is never an authenticated agent ingress. */
export function isAgentInstructionCommand(command: { type: string }): boolean {
	return command.type === "agent_control_instruction";
}
