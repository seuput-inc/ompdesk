import { userInfo } from "node:os";

interface Model {
	id: string;
	provider: string;
}

interface Session {
	model?: Model | null;
	getAvailableModels(): readonly Model[];
	modelRegistry: {
		authStorage: {
			keys: { source(provider: string): { kind: string } | undefined | null; keyless(provider: string): boolean };
		};
	};
	sessionManager: { ensureOnDisk(): unknown; flush(): unknown };
}

/** The host gets neither a credential nor a provider URL. The provider can still reject a revoked login at request time. */
export async function wslAdmission(session: Session) {
	if (process.platform !== "linux" || !process.getuid?.()) throw new Error("Expected a non-root Linux guest");
	const { homedir: home } = userInfo();
	const model = session.model;
	const keys = session.modelRegistry.authStorage.keys;
	const source = model && keys.source(model.provider)?.kind;
	if (
		!model ||
		(source !== "oauth" && source !== "api_key") ||
		keys.keyless(model.provider) ||
		!session.getAvailableModels().some(row => row.id === model.id && row.provider === model.provider)
	)
		return { available: false, home };
	await session.sessionManager.ensureOnDisk();
	await session.sessionManager.flush();
	return { available: session.model?.id === model.id && session.model.provider === model.provider, home };
}
