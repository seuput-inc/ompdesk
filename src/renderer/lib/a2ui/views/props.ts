/**
 * Reading a node's resolved props: web_core hands a dynamic value as a `ResolvedBinding` (a `WritableBinding` when it
 * names the data model, so an input writes back through it) and a literal as itself.
 */

import { type ComponentNode, isWritable, ResolvedBinding, type SurfaceModel } from "@a2ui/web_core";
import { createContext } from "react";

/** A dynamic or literal prop's value. */
export function read(value: unknown): unknown {
	return value instanceof ResolvedBinding ? value.value : value;
}

export function readText(value: unknown): string {
	const resolved = read(value);
	return typeof resolved === "string" || typeof resolved === "number" ? String(resolved) : "";
}

/** The setter of a prop bound to the data model, or undefined for a literal (the control stays as given). */
export function writer<T>(value: unknown): ((next: T) => void) | undefined {
	return value instanceof ResolvedBinding && isWritable(value) ? (value.set as (next: T) => void) : undefined;
}

export function isNode(value: unknown): value is ComponentNode {
	return typeof value === "object" && value !== null && "instanceId" in value && "props" in value;
}

/** Checks that failed, as web_core's binder puts them on a checkable component's props. */
export function checkErrors(props: Record<string, unknown>): string[] {
	const errors = props.validationErrors;
	return props.isValid === false && Array.isArray(errors) ? errors.filter(e => typeof e === "string") : [];
}

export interface A2uiViewState {
	surface: SurfaceModel | undefined;
	/** Nothing answers here: inputs are disabled and buttons inert (a card whose call no longer waits, a folded copy). */
	inert: boolean;
	/** The one Button drawn primary: the surface's first `primary` (others are drawn secondary). */
	primaryId: string | undefined;
}

export const A2uiViewContext = createContext<A2uiViewState>({ surface: undefined, inert: true, primaryId: undefined });

export interface ViewProps {
	node: ComponentNode;
	props: Record<string, unknown>;
}
