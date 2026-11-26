/**
 * C137–C139/C143: the element picker, region select, comment pins, CSS
 * variable tweaks and the `data-choice` wait on a preview page; find in page and
 * the link under the pointer (Orca's `find/BrowserFind.tsx` and
 * `feedback/browser-link-status-bubble.tsx`). They run in an isolated world
 * (`PAGE_WORLD`), so the page's own scripts can neither read nor call them, and
 * they act only on trusted (real) input events; main adds the gesture and agent
 * checks on top (host.ts). Find and the link watch keep no state in the page:
 * main says which match to show and which link it last saw.
 */

/** Isolated world id for OMPdesk's page tools (any id other than 0, the page's own world). */
export const PAGE_WORLD = 1077;

const PRELUDE = String.raw`
if (!globalThis.__ompdesk) {
	const escape = value => CSS.escape(value);
	const uniqueId = node => node.id && document.querySelectorAll("#" + escape(node.id)).length === 1;
	const selectorOf = element => {
		const parts = [];
		let node = element;
		while (node && node.nodeType === 1 && node !== document.documentElement) {
			if (uniqueId(node)) {
				parts.unshift("#" + escape(node.id));
				break;
			}
			let part = node.tagName.toLowerCase();
			const parent = node.parentElement;
			if (parent) {
				const same = [...parent.children].filter(child => child.tagName === node.tagName);
				if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
			}
			parts.unshift(part);
			node = parent;
		}
		return parts.join(" > ") || "html";
	};
	const describe = element => ({
		selector: selectorOf(element),
		tag: element.tagName.toLowerCase(),
		text: (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
	});
	const host = document.createElement("div");
	host.setAttribute("data-ompdesk-overlay", "");
	host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
	const shadow = host.attachShadow({ mode: "closed" });
	const style = document.createElement("style");
	style.textContent =
		".box{position:fixed;border:2px solid #4f6bed;background:rgba(79,107,237,.12);border-radius:2px;pointer-events:none}" +
		".pin{position:fixed;min-width:18px;height:18px;padding:0 4px;border-radius:9px;background:#4f6bed;color:#fff;font:600 11px/18px system-ui,sans-serif;text-align:center;transform:translate(-50%,-50%);pointer-events:none}" +
		".layer{position:fixed;inset:0;cursor:crosshair;pointer-events:auto}" +
		".cursor{position:fixed;left:0;top:0;width:22px;height:22px;pointer-events:none;transition:transform .18s ease-out;filter:drop-shadow(0 0 6px rgba(79,107,237,.8))}";
	shadow.append(style);
	const mount = () => {
		if (!host.isConnected) document.documentElement.append(host);
	};
	const box = () => {
		const element = document.createElement("div");
		element.className = "box";
		shadow.append(element);
		return element;
	};
	const place = (element, rect) => {
		element.style.left = rect.left + "px";
		element.style.top = rect.top + "px";
		element.style.width = rect.width + "px";
		element.style.height = rect.height + "px";
	};
	const settle = () => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
	let pending = null;
	const finish = value => {
		const current = pending;
		pending = null;
		if (current) current(value);
	};
	let pinList = [];
	const pinNodes = [];
	const drawPins = () => {
		for (const node of pinNodes.splice(0)) node.remove();
		if (pinList.length) mount();
		for (const pin of pinList) {
			const element = document.querySelector(pin.selector);
			if (!element) continue;
			const rect = element.getBoundingClientRect();
			const node = document.createElement("div");
			node.className = "pin";
			node.textContent = String(pin.n);
			node.style.left = rect.left + "px";
			node.style.top = rect.top + "px";
			shadow.append(node);
			pinNodes.push(node);
		}
	};
	addEventListener("scroll", drawPins, true);
	addEventListener("resize", drawPins);
	const tweaked = new Set();
	// The one pending choose() wait; a new wait or cancel() ends it with null.
	let endChoice = null;
	globalThis.__ompdesk = {
		pick() {
			finish(null);
			mount();
			const outline = box();
			const move = event => {
				if (event.target === host) return;
				place(outline, event.target.getBoundingClientRect());
			};
			return new Promise(resolve => {
				const cleanup = value => {
					removeEventListener("mousemove", move, true);
					removeEventListener("click", click, true);
					removeEventListener("keydown", key, true);
					outline.remove();
					resolve(value);
				};
				const click = event => {
					if (!event.isTrusted) return;
					event.preventDefault();
					event.stopImmediatePropagation();
					finish(describe(event.target));
				};
				const key = event => {
					if (event.isTrusted && event.key === "Escape") finish(null);
				};
				pending = cleanup;
				addEventListener("mousemove", move, true);
				addEventListener("click", click, true);
				addEventListener("keydown", key, true);
			});
		},
		region() {
			finish(null);
			mount();
			const layer = document.createElement("div");
			layer.className = "layer";
			shadow.append(layer);
			const outline = box();
			outline.style.display = "none";
			return new Promise(resolve => {
				let start = null;
				let rect = null;
				const cleanup = async value => {
					removeEventListener("keydown", key, true);
					layer.remove();
					outline.remove();
					await settle();
					resolve(value);
				};
				const key = event => {
					if (event.isTrusted && event.key === "Escape") finish(null);
				};
				layer.addEventListener("mousedown", event => {
					if (!event.isTrusted) return;
					start = { x: event.clientX, y: event.clientY };
				});
				layer.addEventListener("mousemove", event => {
					if (!start || !event.isTrusted) return;
					rect = {
						left: Math.min(start.x, event.clientX),
						top: Math.min(start.y, event.clientY),
						width: Math.abs(event.clientX - start.x),
						height: Math.abs(event.clientY - start.y),
					};
					outline.style.display = "";
					place(outline, rect);
				});
				layer.addEventListener("mouseup", event => {
					if (!start || !event.isTrusted) return;
					if (!rect || rect.width < 4 || rect.height < 4) {
						start = null;
						return;
					}
					const found = [];
					layer.style.display = "none";
					for (const fx of [0.2, 0.5, 0.8])
						for (const fy of [0.2, 0.5, 0.8]) {
							const hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
							if (hit && hit !== host && hit !== document.body && hit !== document.documentElement && !found.includes(hit))
								found.push(hit);
						}
					finish({ rect, elements: found.slice(0, 10).map(describe) });
				});
				pending = cleanup;
				addEventListener("keydown", key, true);
			});
		},
		cancel() {
			finish(null);
			if (endChoice) endChoice(null);
			return null;
		},
		parent(selector) {
			const element = document.querySelector(selector);
			const parent = element && element.parentElement;
			return parent && parent !== document.documentElement ? describe(parent) : null;
		},
		pins(list) {
			pinList = list;
			drawPins();
			return null;
		},
		// The agent's pointer where its last mouse event landed (CSS pixels of the viewport); null hides it at once.
		cursor(point) {
			let node = shadow.querySelector(".cursor");
			if (!point) {
				if (node) node.style.visibility = "hidden";
				return null;
			}
			mount();
			if (!node) {
				const svg = "http://www.w3.org/2000/svg";
				node = document.createElementNS(svg, "svg");
				node.setAttribute("class", "cursor");
				node.setAttribute("viewBox", "0 0 22 22");
				const arrow = document.createElementNS(svg, "path");
				for (const [name, value] of [["d", "M2 2l7 18 2.6-7.4L19 10z"], ["fill", "#4f6bed"], ["stroke", "#fff"], ["stroke-width", "1.5"], ["stroke-linejoin", "round"]])
					arrow.setAttribute(name, value);
				node.append(arrow);
				shadow.append(node);
			}
			node.style.visibility = "visible";
			node.style.transform = "translate(" + (point.x - 2) + "px," + (point.y - 2) + "px)";
			return null;
		},
		highlight(selector) {
			const element = document.querySelector(selector);
			if (!element) return null;
			element.scrollIntoView({ block: "center", inline: "nearest" });
			mount();
			const outline = box();
			requestAnimationFrame(() => place(outline, element.getBoundingClientRect()));
			setTimeout(() => outline.remove(), 1500);
			return null;
		},
		tweaks() {
			const names = new Set();
			const visit = rules => {
				for (const rule of rules) {
					if (rule.cssRules && !(rule instanceof CSSStyleRule)) visit(rule.cssRules);
					else if (rule instanceof CSSStyleRule && /(^|,)\s*(:root|html)\s*(,|$)/.test(rule.selectorText))
						for (const name of rule.style) if (name.startsWith("--")) names.add(name);
				}
			};
			for (const sheet of document.styleSheets) {
				try {
					visit(sheet.cssRules);
				} catch {}
			}
			for (const name of document.documentElement.style) if (name.startsWith("--")) names.add(name);
			const computed = getComputedStyle(document.documentElement);
			return [...names]
				.sort()
				.slice(0, 200)
				.map(name => ({ name, value: computed.getPropertyValue(name).trim() }));
		},
		setVariable(name, value) {
			if (!/^--[\w-]+$/.test(name)) return null;
			document.documentElement.style.setProperty(name, value);
			tweaked.add(name);
			return null;
		},
		clearVariables() {
			for (const name of tweaked) document.documentElement.style.removeProperty(name);
			tweaked.clear();
			return null;
		},
		find(query, index) {
			// shortcut: a match split across elements ("Hel<b>lo</b>") is not found; join text runs if it matters.
			const needle = String(query).toLowerCase();
			const ranges = [];
			const root = document.body || document.documentElement;
			if (needle && root) {
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
					acceptNode(node) {
						const parent = node.parentElement;
						if (!parent || parent.closest("script,style,noscript,template")) return NodeFilter.FILTER_REJECT;
						return parent.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
					},
				});
				for (let node = walker.nextNode(); node && ranges.length < 1000; node = walker.nextNode()) {
					const text = node.data.toLowerCase();
					for (let at = text.indexOf(needle); at !== -1 && ranges.length < 1000; at = text.indexOf(needle, at + needle.length)) {
						const range = document.createRange();
						range.setStart(node, at);
						range.setEnd(node, at + needle.length);
						ranges.push(range);
					}
				}
			}
			const selection = getSelection();
			if (!ranges.length) {
				selection?.removeAllRanges();
				return { active: 0, total: 0 };
			}
			const at = ((index % ranges.length) + ranges.length) % ranges.length;
			const range = ranges[at];
			selection?.removeAllRanges();
			selection?.addRange(range);
			range.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
			mount();
			const outline = box();
			requestAnimationFrame(() => place(outline, range.getBoundingClientRect()));
			setTimeout(() => outline.remove(), 1200);
			return { active: at + 1, total: ranges.length };
		},
		findStop() {
			getSelection()?.removeAllRanges();
			return null;
		},
		hoverLink(last) {
			// Answers once the link under the pointer (or keyboard focus) is another than \`last\`: its address, "" for none.
			return new Promise(resolve => {
				const done = href => {
					removeEventListener("mouseover", seen, true);
					removeEventListener("focusin", seen, true);
					removeEventListener("mouseout", left, true);
					resolve(href);
				};
				const seen = event => {
					const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
					const href = anchor ? String(anchor.href) : "";
					if (href !== last) done(href);
				};
				const left = event => {
					if (!event.relatedTarget && last !== "") done("");
				};
				addEventListener("mouseover", seen, true);
				addEventListener("focusin", seen, true);
				addEventListener("mouseout", left, true);
			});
		},
		choose() {
			if (endChoice) endChoice(null);
			return new Promise(resolve => {
				const end = value => {
					removeEventListener("click", click, true);
					endChoice = null;
					resolve(value);
				};
				const click = event => {
					if (!event.isTrusted) return;
					const target = event.target instanceof Element ? event.target.closest("[data-choice]") : null;
					if (!target) return;
					event.preventDefault();
					end({
						value: String(target.getAttribute("data-choice") || "").slice(0, 200),
						text: (target.innerText || target.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
					});
				};
				endChoice = end;
				addEventListener("click", click, true);
			});
		},
	};
}
`;

/** One call into the page tools; `args` are JSON-encoded, never spliced as code. */
export function pageCall(method: string, ...args: unknown[]): string {
	return `${PRELUDE}\nglobalThis.__ompdesk[${JSON.stringify(method)}](...${JSON.stringify(args)})`;
}
