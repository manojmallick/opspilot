import fs from "fs";

export const CONFIDENCE_AUTO_THRESHOLD = 0.9;

export interface LedgerEntry {
  timestamp: string;
  action: string;
  confidence: number;
  status: "auto_applied" | "held_for_review";
  reason: string;
  dataSummary: Record<string, unknown>;
}

/**
 * Every action OpsPilot takes on real business data is logged with
 * whether it was auto-applied or held for human review, and why.
 * Anything below the confidence threshold never auto-files.
 */
export class HumanLedger {
  constructor(private logPath = "opspilot_ledger.jsonl") {}

  recordDecision(
    action: string,
    confidence: number,
    reason: string,
    dataSummary: Record<string, unknown> = {}
  ): "auto_applied" | "held_for_review" {
    const status =
      confidence >= CONFIDENCE_AUTO_THRESHOLD ? "auto_applied" : "held_for_review";
    const entry: LedgerEntry = {
      timestamp: new Date().toISOString(),
      action,
      confidence,
      status,
      reason,
      dataSummary,
    };
    fs.appendFileSync(this.logPath, JSON.stringify(entry) + "\n");
    return status;
  }

  private entries(): LedgerEntry[] {
    if (!fs.existsSync(this.logPath)) return [];
    return fs
      .readFileSync(this.logPath, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  reviewQueue(): LedgerEntry[] {
    return this.entries().filter((e) => e.status === "held_for_review");
  }

  stats(): { autoApplied: number; heldForReview: number; total: number } {
    const all = this.entries();
    const heldForReview = all.filter((e) => e.status === "held_for_review").length;
    return { autoApplied: all.length - heldForReview, heldForReview, total: all.length };
  }
}
