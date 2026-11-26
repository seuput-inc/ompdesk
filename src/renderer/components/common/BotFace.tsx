/**
 * BotFace — a bot's living face (adapted from momobot's `app/src/components/agents/bot-face.tsx` and
 * `abstract-avatar.tsx`, MIT; LICENSES/MIT-momobot.txt): a small character whose body colour, shape and eyes come from
 * `seed`, the bot's id, so the same bot has the same face on every device. React draws it at rest and owns its identity;
 * the rig (`lib/bot-face-motion.ts`) is loaded once the page has loaded and moves the same contours in place, without
 * re-rendering: it acts out `presence`, glances at a pointer passing close and bounces when pressed.
 *
 * Still at rest under reduced motion, and in test runs (the `botFaces` pref is `"rest"`: main sets it under
 * OMP_GUI_HEADLESS unless OMP_GUI_TEST_BOT_FACES=1, the dev harness unless `?faces=1`), so captures stay the same. Off
 * screen or in a hidden window it keeps no timer and asks for no frame. Decorative: whoever draws it names the bot.
 */
import { useEffect, useId, useMemo, useRef } from "react";
import { FACE_VIEWBOX, type FacePresence, faceDrawing, faceTraits, REST_FACE_POSE } from "../../lib/bot-face";
import type * as FaceMotion from "../../lib/bot-face-motion";
import { cx } from "../../lib/format";

/** `"rest"` keeps every face still (test runs, see the header). */
const BOT_FACES_PREF = "botFaces";

export interface BotFaceProps {
	/** The bot's stable id. */
	seed: string;
	/** px, or any CSS length. */
	size?: number | string;
	presence?: FacePresence;
	/** Paints the body in this colour instead of the seed's (a face not drawn for a bot yet); the seed keeps its shape. */
	color?: string;
	className?: string;
}

let rigLoad: Promise<typeof FaceMotion | null> | null = null;

/** The rig module, once per page, after the page's own load; null when faces stay at rest. */
function loadRig() {
	rigLoad ??= (async () => {
		if (!window.omp?.prefs) return null;
		if (document.readyState !== "complete")
			await new Promise(resolve => window.addEventListener("load", resolve, { once: true }));
		if ((await window.omp.prefs.get(BOT_FACES_PREF).catch(() => undefined)) === "rest") return null;
		return import("../../lib/bot-face-motion");
	})().catch(() => null);
	return rigLoad;
}

export function BotFace({ seed, size = 32, presence = "idle", color, className }: BotFaceProps) {
	const clipId = useId();
	const node = useRef<HTMLSpanElement>(null);
	const motion = useRef<FaceMotion.BotFaceMotion | null>(null);
	const latest = useRef(presence);
	latest.current = presence;
	const traits = useMemo(() => faceTraits(seed), [seed]);
	const drawing = useMemo(() => faceDrawing(traits, REST_FACE_POSE), [traits]);

	useEffect(() => {
		let gone = false;
		void loadRig().then(rig => {
			if (gone || !rig || !node.current) return;
			motion.current = rig.attachBotFace(node.current, seed, latest.current);
		});
		return () => {
			gone = true;
			motion.current?.dispose();
			motion.current = null;
		};
	}, [seed]);
	useEffect(() => motion.current?.update(presence), [presence]);

	return (
		<span
			aria-hidden
			className={cx("inline-flex shrink-0", className)}
			data-bot-face={seed}
			ref={node}
			style={{ width: size, height: size }}
		>
			<svg
				className="block size-full overflow-visible"
				viewBox={`0 0 ${FACE_VIEWBOX} ${FACE_VIEWBOX}`}
				xmlns="http://www.w3.org/2000/svg"
			>
				<g data-face-part="character" transform={drawing.transform}>
					<defs>
						<clipPath id={clipId}>
							<path d={drawing.body} data-face-part="clip" />
						</clipPath>
					</defs>
					<path
						d={drawing.body}
						data-face-part="body"
						fill={traits.bodyColor}
						style={color ? { fill: color } : undefined}
					/>
					<g clipPath={`url(#${clipId})`} fill="#fff">
						<path d={drawing.left.path} data-face-part="left" transform={drawing.left.transform} />
						<path d={drawing.right.path} data-face-part="right" transform={drawing.right.transform} />
					</g>
				</g>
			</svg>
		</span>
	);
}
