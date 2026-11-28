import { z } from "zod";

export const ItemEffect = z.object({
	item: z.string().min(1).max(200),
	generation: z.number().int().positive().safe(),
	effectKey: z.string().regex(/^[0-9a-f]{32}$/),
});
export const ItemTab = z.string().regex(/^item-[0-9a-f]{32}$/);
export const ItemCheck = ItemEffect.pick({ item: true, generation: true }).extend({
	session: z.string().min(1).max(32_768),
	mail: z.object({ key: z.string().min(1).max(2048), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).nullish(),
});
export const ItemChallenge = z.object({ request: z.string().uuid(), tab: ItemTab, check: ItemCheck });
export type PeerItemCheck = z.infer<typeof ItemCheck>;
export type PeerItemAsk = { peer: string; tab: string; pid: number; check: PeerItemCheck };
export type PeerItemVerdict = { allowed: boolean; mailKey: string | null };
export type PeerItemStep =
	| { op: "ready" }
	| { op: "accept"; effect: z.infer<typeof ItemEffect> }
	| { op: "read" }
	| { op: "worktree"; fingerprint: string }
	| { op: "treeCreated"; fingerprint: string; tree: { path: string; branch: string; baseCwd: string } }
	| { op: "open"; session?: string }
	| { op: "bind"; session: string }
	| { op: "first"; session: string; fingerprint: string }
	| { op: "confirm"; fingerprint: string };
