import fs from "fs";
import path from "path";
import { OpsPilot } from "./index";

/**
 * Benchmark Qwen-VL extraction against REAL invoices with manually
 * verified ground truth. Reports the actual measured accuracy — misses
 * included — for the hackathon submission.
 *
 * Setup:
 *   1. Put invoice images (jpg/png/webp — photograph or export PDFs to images)
 *      in data/invoices/
 *   2. Fill in data/ground_truth.json — one entry per file, manually verified:
 *      [{ "file": "inv_001.jpg", "vendor": "...", "btwNumber": "...",
 *         "invoiceNumber": "...", "invoiceDate": "2026-06-01",
 *         "totalExclBtw": 100.0, "btwAmount": 21.0, "dueDate": "2026-07-01" }]
 *   3. npm run benchmark
 */

const INVOICE_DIR = "data/invoices";
const GROUND_TRUTH = "data/ground_truth.json";
const RESULTS_FILE = "benchmark_results.json";

function normalize(v: unknown): string {
  if (typeof v === "number") return v.toFixed(2);
  const s = String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const asNum = Number(s.replace(",", "."));
  if (s !== "" && !isNaN(asNum) && /^[\d.,-]+$/.test(s)) return asNum.toFixed(2);
  return s;
}

async function main() {
  if (!fs.existsSync(GROUND_TRUTH)) {
    console.error(`Missing ${GROUND_TRUTH} — create it first (see comment at top of src/benchmark.ts).`);
    process.exit(1);
  }
  const truths: Array<Record<string, unknown> & { file: string }> = JSON.parse(
    fs.readFileSync(GROUND_TRUTH, "utf-8")
  );
  if (truths.length === 0) {
    console.error("ground_truth.json is empty — add at least one manually verified invoice.");
    process.exit(1);
  }

  const ops = new OpsPilot();
  const perInvoice: any[] = [];

  for (const truth of truths) {
    const imgPath = path.join(INVOICE_DIR, truth.file);
    if (!fs.existsSync(imgPath)) {
      console.error(`SKIP ${truth.file}: file not found in ${INVOICE_DIR}/`);
      perInvoice.push({ invoice: truth.file, error: "file_not_found" });
      continue;
    }
    console.log(`Processing ${truth.file} ...`);
    try {
      const extracted: any = await ops.processInvoice(imgPath);
      const fields = Object.keys(truth).filter((k) => k !== "file");
      const fieldMatches: Record<string, boolean> = {};
      for (const f of fields) {
        fieldMatches[f] = normalize(extracted[f]) === normalize(truth[f]);
      }
      perInvoice.push({
        invoice: truth.file,
        fieldMatches,
        allCorrect: Object.values(fieldMatches).every(Boolean),
        modelConfidence: extracted.confidence,
        ledgerAction: extracted.action,
        mismatches: fields
          .filter((f) => !fieldMatches[f])
          .map((f) => ({ field: f, expected: truth[f], got: extracted[f] })),
      });
    } catch (e: any) {
      console.error(`ERROR on ${truth.file}: ${e.message}`);
      perInvoice.push({ invoice: truth.file, error: e.message });
    }
  }

  const scored = perInvoice.filter((r) => r.fieldMatches);
  const totalFields = scored.reduce((n, r) => n + Object.keys(r.fieldMatches).length, 0);
  const correctFields = scored.reduce(
    (n, r) => n + Object.values(r.fieldMatches).filter(Boolean).length,
    0
  );

  const summary = {
    invoicesTested: truths.length,
    invoicesScored: scored.length,
    fieldLevelAccuracy: totalFields ? Number((correctFields / totalFields).toFixed(3)) : null,
    correctFields,
    totalFields,
    fullyCorrectInvoices: scored.filter((r) => r.allCorrect).length,
    heldForReviewByLedger: scored.filter((r) => r.ledgerAction === "human_review_confidence").length,
    perInvoice,
  };

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(summary, null, 2));
  console.log("\n=== BENCHMARK RESULT (real, measured) ===");
  console.log(
    `${correctFields}/${totalFields} fields correct across ${scored.length} real invoices` +
      (totalFields ? ` (${(100 * correctFields / totalFields).toFixed(1)}%)` : "")
  );
  console.log(`Fully correct invoices: ${summary.fullyCorrectInvoices}/${scored.length}`);
  console.log(`Held for human review by Human Ledger: ${summary.heldForReviewByLedger}`);
  console.log(`Full details written to ${RESULTS_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
