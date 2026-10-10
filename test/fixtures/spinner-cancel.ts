// Child process for the spinner cancel tests (spec §5): starts a ClackUi spinner, then exits the way clack's block()
// does on Ctrl-C in raw mode (`exit`), after stopping the spinner (`stop`), or waits for a signal (`wait`).
import { ClackUi } from "../../src/setup/ui.ts";

const mode = process.argv[2];
const spin = new ClackUi().spinner();
spin.start("checking the network");
if (mode === "stop") spin.stop("network ok");
if (mode === "wait") process.stderr.write("ready\n");
else process.exit(0);
