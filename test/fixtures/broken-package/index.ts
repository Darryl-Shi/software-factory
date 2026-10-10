import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** A pi package whose extension factory throws. */
export default function (_pi: ExtensionAPI) {
	throw new Error("fixture boom");
}
