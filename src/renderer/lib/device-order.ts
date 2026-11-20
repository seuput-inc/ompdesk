/** Reconcile the cached device order with the remembered headers for first paint. A live order already names every section. */
import { reorderProjects } from "./project-order";

export function orderDevices(present: readonly string[], saved: readonly string[]): string[] {
	const placed = [...new Set(saved.filter(id => present.includes(id)))];
	return [...placed, ...present.filter(id => !placed.includes(id))];
}

/** `order` with `id` moved `delta` places (−1 up, +1 down); unchanged at an edge or for an unknown id. */
export function moveDevice(order: readonly string[], id: string, delta: number): string[] {
	const target = order[order.indexOf(id) + delta];
	return target === undefined || !order.includes(id) ? [...order] : reorderProjects(order, id, target);
}
