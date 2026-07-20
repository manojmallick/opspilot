import fs from "fs";
import { usageReport } from "./qwenClient";
import { HumanLedger } from "./humanLedger";

/**
 * Qwen tool-coverage checklist (Upgrade 4) — every number counted from
 * the persisted usage log and Human Ledger, not typed in by hand.
 * Run: npm run coverage
 */
function main() {
  const usage = usageReport();
  const ledger = new HumanLedger().stats();

  let invoicesTested = "not yet run";
  if (fs.existsSync("benchmark_results.json")) {
    const b = JSON.parse(fs.readFileSync("benchmark_results.json", "utf-8"));
    invoicesTested = `${b.invoicesScored} (field accuracy ${b.fieldLevelAccuracy === null ? "n/a" : (b.fieldLevelAccuracy * 100).toFixed(1) + "%"})`;
  }

  const lines = [
    "## Qwen Tool Coverage (auto-counted)",
    "",
    `- Qwen-VL vision calls: ${usage.visionCalls}`,
    ...Object.entries(usage.byModel).map(([m, n]) => `- ${m} calls: ${n}`),
    `- Structured-output responses validated as clean JSON: ${usage.jsonValid}/${usage.jsonCalls}`,
    `- Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`,
    `- Real invoices benchmarked: ${invoicesTested}`,
    `- Human Ledger: ${ledger.autoApplied} auto-applied, ${ledger.heldForReview} held for review (${ledger.total} decisions)`,
  ];

  const out = lines.join("\n");
  console.log(out);
  fs.writeFileSync("TOOL_COVERAGE.md", out + "\n");
  console.log("\nWritten to TOOL_COVERAGE.md");
}

main();
