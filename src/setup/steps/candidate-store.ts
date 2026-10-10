// A SecretStore that answers one key with a candidate value held in memory, so setup can verify a pasted key
// through code that resolves `store:<key>` refs before anything is written to secrets.json.
import { SecretStore } from "../../secrets/store.ts";

export class CandidateStore extends SecretStore {
	constructor(
		path: string,
		private readonly key: string,
		private readonly value: string,
	) {
		super(path);
	}

	override get(k: string): string | undefined {
		return k === this.key ? this.value : super.get(k);
	}
}
