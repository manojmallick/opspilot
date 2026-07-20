import fs from "fs";
import path from "path";
import { QwenClient } from "./qwenClient";
import { HumanLedger, CONFIDENCE_AUTO_THRESHOLD } from "./humanLedger";

export interface Transaction {
  date: string; // ISO date
  type: "revenue" | "expense";
  amount: number;
  btwAmount: number;
  description?: string;
}

export interface Invoice {
  vendor: string;
  btwNumber: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  lineItems: Array<{ description: string; amountExclBtw: number; btwRate: number }>;
  totalExclBtw: number;
  btwAmount: number;
  totalInclBtw: number;
  category: string;
  approved: boolean | null;
  action: string;
  confidence: number;
  fieldConfidence: Record<string, number>;
}

export class BookkeepingStore {
  private data: {
    invoices: Invoice[];
    transactions: Transaction[];
    crm: any[];
    declarations: any[];
  };

  constructor(private filePath = "opspilot_store.json") {
    if (fs.existsSync(filePath)) {
      this.data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } else {
      this.data = { invoices: [], transactions: [], crm: [], declarations: [] };
    }
  }

  save() {
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  addInvoice(inv: Invoice) {
    this.data.invoices.push(inv);
    this.save();
  }

  addTransaction(tx: Transaction) {
    this.data.transactions.push(tx);
    this.save();
  }

  addCrm(record: any) {
    this.data.crm.push(record);
    this.save();
  }

  transactions() {
    return this.data.transactions;
  }

  invoices() {
    return this.data.invoices;
  }

  declarations() {
    return this.data.declarations;
  }

  pushDeclaration(decl: any) {
    this.data.declarations.push(decl);
    this.save();
  }
}

export class OpsPilot {
  private client: QwenClient;
  store: BookkeepingStore;
  ledger: HumanLedger;
  private autoApproveThreshold = 500;

  constructor(client?: QwenClient, store?: BookkeepingStore, ledger?: HumanLedger) {
    this.client = client || new QwenClient();
    this.store = store || new BookkeepingStore();
    this.ledger = ledger || new HumanLedger();
  }

  // ------------------------------------------------------------------
  // Workflow 1: Invoice Autopilot
  // ------------------------------------------------------------------
  async processInvoice(
    imagePath: string,
    approvedVendors: string[] = [],
    categories: string[] = ["tools", "services", "travel", "marketing", "office", "other"]
  ): Promise<Invoice> {
    const b64 = fs.readFileSync(imagePath).toString("base64");
    const ext = path.extname(imagePath).toLowerCase();
    const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const prompt = `Extract from this Dutch/English invoice and return JSON:
{
  "vendor": "...",
  "btwNumber": "...",
  "invoiceNumber": "...",
  "invoiceDate": "YYYY-MM-DD",
  "dueDate": "YYYY-MM-DD",
  "lineItems": [{"description": "...", "amountExclBtw": 0.0, "btwRate": 0.21}],
  "totalExclBtw": 0.0,
  "btwAmount": 0.0,
  "totalInclBtw": 0.0,
  "fieldConfidence": {"vendor": 0.0, "btwNumber": 0.0, "invoiceNumber": 0.0, "invoiceDate": 0.0, "dueDate": 0.0, "totalExclBtw": 0.0, "btwAmount": 0.0, "totalInclBtw": 0.0}
}
Use Dutch BTW terminology accurately. Dates on Dutch invoices are DD-MM-YYYY — convert to ISO YYYY-MM-DD.
fieldConfidence: your honest 0.0-1.0 confidence per field. Use low values for glare, handwriting, or low resolution. If a field is absent, use "" and confidence 0.`;
    const parsed = await this.client.visionJson<any>({ imageBase64: b64, prompt, mime, model: "qwen-vl-max" });

    const fieldConfidence: Record<string, number> = parsed.fieldConfidence || {};
    const confValues = Object.values(fieldConfidence);
    const confidence = confValues.length
      ? Math.min(...confValues)
      : 0; // no self-reported confidence → never auto-apply

    const invoice: Invoice = {
      vendor: parsed.vendor || "",
      btwNumber: parsed.btwNumber || "",
      invoiceNumber: parsed.invoiceNumber || "",
      invoiceDate: parsed.invoiceDate || "",
      dueDate: parsed.dueDate || "",
      lineItems: parsed.lineItems || [],
      totalExclBtw: parsed.totalExclBtw || 0,
      btwAmount: parsed.btwAmount || 0,
      totalInclBtw: parsed.totalInclBtw || 0,
      category: "other",
      approved: null,
      action: "",
      confidence,
      fieldConfidence,
    };

    const vendorApproved = approvedVendors.some(
      (v) => v.toLowerCase() === invoice.vendor.toLowerCase()
    );

    const classification = await this.client.jsonChat<{ category: string; reason: string }>({
      messages: [
        {
          role: "user",
          content: `Classify this invoice into one of: ${categories.join(
            ", "
          )}.
Vendor: ${invoice.vendor}
Items: ${JSON.stringify(invoice.lineItems)}
Return JSON: {"category": "...", "reason": "..."}`,
        },
      ],
      model: "qwen-max",
      temperature: 0.1,
    });
    invoice.category = classification.category || "other";

    let reason: string;
    if (confidence < CONFIDENCE_AUTO_THRESHOLD) {
      invoice.approved = null;
      invoice.action = "human_review_confidence";
      const weakest = Object.entries(fieldConfidence).sort((a, b) => a[1] - b[1])[0];
      reason = weakest
        ? `low confidence on ${weakest[0]} (${weakest[1]})`
        : "no field confidence reported";
    } else if (invoice.totalInclBtw <= this.autoApproveThreshold && vendorApproved) {
      invoice.approved = true;
      invoice.action = "auto_paid";
      reason = `within €${this.autoApproveThreshold} threshold, approved vendor`;
    } else if (invoice.totalInclBtw <= this.autoApproveThreshold) {
      invoice.approved = null;
      invoice.action = "human_review_vendor";
      reason = "vendor not in approved list";
    } else {
      invoice.approved = null;
      invoice.action = "human_review_amount";
      reason = `amount €${invoice.totalInclBtw} above €${this.autoApproveThreshold} threshold`;
    }

    this.ledger.recordDecision("invoice_extraction", confidence, reason, {
      vendor: invoice.vendor,
      invoiceNumber: invoice.invoiceNumber,
      totalInclBtw: invoice.totalInclBtw,
      action: invoice.action,
      file: path.basename(imagePath),
    });

    this.store.addInvoice(invoice);
    return invoice;
  }

  // ------------------------------------------------------------------
  // Workflow 2: Customer Inquiry Autopilot
  // ------------------------------------------------------------------
  async processCustomerInquiry(
    message: string,
    services: Array<{ name: string; price: number }>,
    pricingRules: Record<string, any>
  ): Promise<any> {
    const classification = await this.client.jsonChat<any>({
      messages: [
        {
          role: "user",
          content: `Classify this customer message into one of: sales_inquiry, support, complaint, spam.
Also extract: intent, requirements, urgency, language (Dutch/English).
Message: ${message}
Return JSON.`,
        },
      ],
      model: "qwen-max",
      temperature: 0.1,
    });

    if (classification.classification === "spam") {
      return { classification: "spam", reply: null };
    }

    let quote: any = null;
    if (classification.classification === "sales_inquiry") {
      quote = await this.client.jsonChat<any>({
        messages: [
          {
            role: "user",
            content: `Services: ${JSON.stringify(services)}
Pricing rules: ${JSON.stringify(pricingRules)}
Customer requirements: ${classification.intent || ""}
Language: ${classification.language || "English"}
Draft a personalised quote and a short follow-up plan. If the requirements are outside standard parameters, say "CUSTOM" and explain why.
Return JSON: {"quoteAmount": 0.0, "currency": "EUR", "quoteText": "...", "isStandard": true/false, "followUpDays": 7}`,
          },
        ],
        model: "qwen-max",
        temperature: 0.3,
      });
    }

    const now = new Date();
    const followUpDays = quote?.followUpDays || 7;
    const followUp = new Date(now);
    followUp.setDate(now.getDate() + followUpDays);

    const record = {
      type: classification.classification,
      message,
      classification,
      quote,
      followUp: followUp.toISOString(),
      createdAt: now.toISOString(),
    };
    this.store.addCrm(record);
    return record;
  }

  // ------------------------------------------------------------------
  // Workflow 3: BTW Declaration Autopilot
  // ------------------------------------------------------------------
  async prepareBtwDeclaration(quarter: "Q1" | "Q2" | "Q3" | "Q4", year: number): Promise<any> {
    const startMonth = { Q1: 1, Q2: 4, Q3: 7, Q4: 10 }[quarter];
    const months = [
      `${year}-${String(startMonth).padStart(2, "0")}`,
      `${year}-${String(startMonth + 1).padStart(2, "0")}`,
      `${year}-${String(startMonth + 2).padStart(2, "0")}`,
    ];
    const quarterTxs = this.store.transactions().filter((t) =>
      months.some((m) => t.date.startsWith(m))
    );

    const revenue = quarterTxs
      .filter((t) => t.type === "revenue")
      .reduce((sum, t) => sum + t.amount, 0);
    const revenueBtw = revenue * 0.21;
    const expensesBtw = quarterTxs
      .filter((t) => t.type === "expense")
      .reduce((sum, t) => sum + t.btwAmount, 0);
    const btwOwed = Math.max(0, revenueBtw - expensesBtw);

    const declaration = {
      quarter: `${year}-${quarter}`,
      revenueExclBtw: revenue,
      btwOnRevenue: revenueBtw,
      btwOnExpenses: expensesBtw,
      btwOwed,
      transactionCount: quarterTxs.length,
      status: "pending_human_review",
      createdAt: new Date().toISOString(),
    };
    this.ledger.recordDecision("btw_declaration", 0, "BTW declarations always require human sign-off before filing", {
      quarter: declaration.quarter,
      btwOwed: declaration.btwOwed,
      transactionCount: declaration.transactionCount,
    });

    this.store.pushDeclaration(declaration);
    return declaration;
  }

  // ------------------------------------------------------------------
  // Workflow 4: Growth Intelligence
  // ------------------------------------------------------------------
  async weeklyGrowthIntelligence(
    revenueTarget: number,
    searchConsoleData: any = {},
    pipeline: any[] = []
  ): Promise<any> {
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const txs = this.store.transactions();

    const recent = txs.filter((t) => new Date(t.date) >= oneWeekAgo);
    const previous = txs
      .filter((t) => new Date(t.date) < oneWeekAgo)
      .slice(-recent.length);

    const weeklyRevenue = recent
      .filter((t) => t.type === "revenue")
      .reduce((sum, t) => sum + t.amount, 0);
    const prevRevenue = previous
      .filter((t) => t.type === "revenue")
      .reduce((sum, t) => sum + t.amount, 0);
    const trend = weeklyRevenue > prevRevenue ? "up" : weeklyRevenue < prevRevenue ? "down" : "flat";

    const overdueInvoices = this.store.invoices().filter(
      (i) => i.action === "human_review_amount"
    );
    const reminderEmails = overdueInvoices.map((i) => ({
      to: i.vendor,
      subject: "Payment reminder",
      body: `Hi, invoice ${i.invoiceNumber} is awaiting approval.`,
    }));

    let blogOutline: any = null;
    const keywords = searchConsoleData.opportunityKeywords || [];
    if (keywords.length > 0) {
      blogOutline = await this.client.jsonChat<any>({
        messages: [
          {
            role: "user",
            content: `Write a blog post outline for a business website targeting this keyword: ${keywords[0]}.
Return JSON: {"title": "...", "sections": ["..."]}}`,
          },
        ],
        model: "qwen-max",
        temperature: 0.5,
      });
    }

    const pipelineFollowups = pipeline
      .filter((quote) => {
        const last = new Date(quote.lastContact || "1970-01-01");
        return (now.getTime() - last.getTime()) / (1000 * 60 * 60 * 24) >= 7;
      })
      .map((quote) => ({
        quoteId: quote.id,
        subject: "Following up on your quote",
        body: `Hi ${quote.contact || ""}, I wanted to follow up on the quote we sent. Let me know if you have questions.`,
      }));

    const monthlyProgress = revenueTarget ? (weeklyRevenue * 4) / revenueTarget : 0;
    const escalate = monthlyProgress < 0.8;

    const digest = await this.client.chat({
      messages: [
        {
          role: "system",
          content:
            "You are an operations assistant. Write a 2-paragraph weekly digest for a Dutch SME founder.",
        },
        {
          role: "user",
          content: `Weekly revenue: €${weeklyRevenue.toFixed(2)}. Trend: ${trend} vs previous period.
Overdue approvals: ${overdueInvoices.length}. Pipeline follow-ups: ${pipelineFollowups.length}.
Monthly progress vs target: ${(monthlyProgress * 100).toFixed(0)}%. Escalate: ${escalate}.
Write in English unless asked otherwise.`,
        },
      ],
      model: "qwen-max",
      temperature: 0.5,
    });

    return {
      weekOf: now.toISOString(),
      weeklyRevenue,
      trend,
      reminderEmails,
      blogOutline,
      pipelineFollowups,
      monthlyProgress,
      escalate,
      digest,
    };
  }
}

async function demo() {
  const ops = new OpsPilot();
  ops.store.addTransaction({
    date: "2026-04-01",
    type: "revenue",
    amount: 1200,
    btwAmount: 252,
  });
  ops.store.addTransaction({
    date: "2026-04-15",
    type: "expense",
    amount: 150,
    btwAmount: 31.5,
  });
  ops.store.addTransaction({
    date: "2026-05-01",
    type: "revenue",
    amount: 900,
    btwAmount: 189,
  });

  console.log("BTW Q2:", await ops.prepareBtwDeclaration("Q2", 2026));
  console.log(
    "Growth:",
    await ops.weeklyGrowthIntelligence(5000, {
      opportunityKeywords: ["rijlessen Amsterdam", "driving school English"],
    })
  );
}

if (require.main === module) {
  demo().catch(console.error);
}
