import { runOfflineAcceptance } from "./harness.mjs";

const receipt = await runOfflineAcceptance();
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
