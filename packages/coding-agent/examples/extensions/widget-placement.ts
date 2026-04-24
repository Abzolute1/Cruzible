import type { ExtensionAPI } from "@ag1/coding-agent";

export default function widgetPlacementExtension(ag1: ExtensionAPI) {
	ag1.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget("widget-above", ["Above editor widget"]);
		ctx.ui.setWidget("widget-below", ["Below editor widget"], { placement: "belowEditor" });
	});
}
