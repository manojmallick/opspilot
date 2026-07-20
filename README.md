# OpsPilot — Track 4: Autopilot Agent

Dutch SME operations autopilot, built by the co-owner of Topclass Nederland VOF and tested against that business's real invoices. Handles invoice processing, customer inquiries, quarterly BTW declarations, and weekly growth intelligence — end-to-end, with a **Human Ledger** keeping humans in the loop for every decision that matters.

## The Human Ledger (governance, named and inspectable)

Every action OpsPilot takes on real business data is appended to `opspilot_ledger.jsonl` with its confidence, status, and reason. The rules:

- Any invoice extraction where Qwen-VL's **lowest field confidence is below 0.90** is **held for review** — never auto-filed into BTW calculations.
- BTW declarations are **always** held for human sign-off before filing.
- Auto-approval additionally requires: amount ≤ €500 **and** vendor on the approved list.

Inspect the queue anytime: the ledger's `reviewQueue()` returns everything awaiting a human.

## Run

```bash
cp .env.example .env      # add your Qwen Cloud API key
npm install
npm run dev               # demo: BTW declaration + growth intelligence on sample data
```

## Benchmark against real invoices (measured, not claimed)

1. Put invoice images (jpg/png/webp) in `data/invoices/` — photograph or export PDFs as images.
2. Fill `data/ground_truth.json` with manually verified field values per file (template in `src/benchmark.ts`).
3. `npm run benchmark` → prints real field-level accuracy and writes `benchmark_results.json`.

Report whatever the actual numbers are, including misses — e.g. "23/24 fields correct across 4 real invoices (95.8%), one BTW number misread on a low-resolution photo."

## Tool coverage (auto-counted)

`npm run coverage` generates `TOOL_COVERAGE.md` from the persisted usage log (`opspilot_usage.jsonl`) and the Human Ledger — Qwen-VL calls, per-model call counts, JSON-validity rate, token totals, auto-applied vs held-for-review decisions. No hand-typed numbers.

## Workflows

1. **Invoice Autopilot** — Qwen-VL extracts fields with per-field confidence; Human Ledger gates auto-approval; classification via qwen-max.
2. **Customer Inquiry** — classifies Dutch/English messages, drafts quotes, logs to CRM with follow-up dates.
3. **BTW Declaration** — aggregates quarterly transactions, computes Dutch VAT owed, always held for human sign-off.
4. **Growth Intelligence** — weekly digest, overdue reminders, SEO blog outline, pipeline follow-ups.

## Qwen-specific capabilities used

- **qwen-vl-max** — reads Dutch invoice images natively (photos and scans)
- **qwen-max** — classification, quoting, digests
- **Structured output** — every JSON response fence-stripped and validated; validity rate tracked in the coverage report
- **Multilingual** — Dutch Belastingdienst terminology handled natively, not translated

## Files

- `src/qwenClient.ts` — Qwen Cloud client: vision, JSON validation, persistent usage tracking
- `src/humanLedger.ts` — the Human Ledger (confidence-gated human-in-the-loop)
- `src/index.ts` — all four workflows + demo
- `src/benchmark.ts` — real-invoice accuracy benchmark
- `src/coverage.ts` — auto-counted Qwen tool-coverage checklist
- `CHALLENGES.md` — real challenges diary (fill during benchmark runs)
