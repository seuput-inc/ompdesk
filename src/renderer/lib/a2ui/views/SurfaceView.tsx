/** One A2UI surface drawn from its root with OMPdesk's views; `inert` while nothing answers here. */

import { NodeResolver, type SurfaceModel } from "@a2ui/web_core";
import { useLayoutEffect, useState } from "react";
import { Skeleton } from "../../../components/common";
import { useSignal } from "../use-signal";
import { NodeView } from "./NodeView";
import { A2uiViewContext } from "./props";

/** The surface's first `primary` Button, in the order its components arrived: the one drawn primary. */
function firstPrimary(surface: SurfaceModel): string | undefined {
	for (const component of surface.componentsModel.values) {
		if (component.type === "Button" && component.properties.variant === "primary") return component.id;
	}
	return undefined;
}

function Root({ resolver }: { resolver: NodeResolver }) {
	const root = useSignal(resolver.rootNode);
	return root ? <NodeView node={root} /> : <Skeleton className="h-16 w-full" />;
}

export function SurfaceView({
	surface,
	inert,
	pressedId,
}: {
	surface: SurfaceModel;
	inert: boolean;
	/** The Button whose action the person sent: it keeps a check mark. */
	pressedId?: string;
}) {
	// The resolver holds subscriptions on the surface: made and disposed with the mount (and again for a new surface).
	const [resolver, setResolver] = useState<NodeResolver>();
	useLayoutEffect(() => {
		const next = new NodeResolver(surface);
		setResolver(next);
		return () => next.dispose();
	}, [surface]);
	return (
		<A2uiViewContext.Provider value={{ surface, inert, pressedId, primaryId: firstPrimary(surface) }}>
			<div className="flex min-w-0 flex-col gap-3" data-a2ui-surface={surface.id}>
				{resolver && !resolver.disposed ? <Root resolver={resolver} /> : <Skeleton className="h-16 w-full" />}
			</div>
		</A2uiViewContext.Provider>
	);
}
