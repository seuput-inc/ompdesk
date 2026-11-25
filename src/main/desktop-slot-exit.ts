type Presence = "present" | "absent" | "unknown";

function presence(pid: number): Presence {
	try {
		process.kill(pid, 0); // Existence query only. Never signal a bridge-reported pid.
		return "present";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH" ? "absent" : "unknown";
	}
}

/** Captured at acquire on the private bridge of this spawn. A cmd.exe wait is not a wait for its omp. */
export function desktopExitReceipt(
	identity: { launcher: number; owner: number; core: number; wrapped: boolean },
	wait: Promise<boolean>,
	generationEnded: () => boolean,
	inspect: (pid: number) => Presence = presence,
): { absentAtAcquire: boolean; exited: Promise<boolean>; gone(): boolean } {
	const { launcher, owner, core, wrapped } = identity;
	const direct = launcher === owner;
	const initial = inspect(owner);
	const observed = !(wrapped && direct) && initial === "present";
	let reaped = false;
	let lost = false;
	const gone = (): boolean => {
		if (!observed) return false;
		if (reaped) return inspect(owner) === "absent";
		// A rejected RPC says nothing about exit. After a core replacement require all captured processes absent.
		return (
			lost &&
			generationEnded() &&
			inspect(core) === "absent" &&
			inspect(launcher) === "absent" &&
			(direct || inspect(owner) === "absent")
		);
	};
	const exited = wait.then(
		confirmed => {
			reaped = confirmed;
			return gone();
		},
		() => {
			lost = true;
			return gone();
		},
	);
	return { absentAtAcquire: initial === "absent", exited, gone };
}
