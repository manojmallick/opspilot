import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

export const QWEN_BASE_URL =
  process.env.QWEN_BASE_URL || "https://dashscope.aliyuncs.com/compatible-mode/v1";

const USAGE_LOG = process.env.OPSPILOT_USAGE_LOG || "opspilot_usage.jsonl";

export function getApiKey(): string {
  const key = process.env.QWEN_API_KEY;
  if (!key) {
    throw new Error(
      "QWEN_API_KEY not found. Copy .env.example to .env and add your key."
    );
  }
  return key;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: any;
}

function logUsage(record: {
  model: string;
  kind: "chat" | "vision" | "json";
  jsonValid?: boolean;
  inputTokens?: number;
  outputTokens?: number;
}) {
  fs.appendFileSync(
    USAGE_LOG,
    JSON.stringify({ timestamp: new Date().toISOString(), ...record }) + "\n"
  );
}

export interface UsageReport {
  totalCalls: number;
  byModel: Record<string, number>;
  visionCalls: number;
  jsonCalls: number;
  jsonValid: number;
  inputTokens: number;
  outputTokens: number;
}

/** Aggregate every logged Qwen call — the raw data behind the tool-coverage checklist. */
export function usageReport(logPath = USAGE_LOG): UsageReport {
  const report: UsageReport = {
    totalCalls: 0,
    byModel: {},
    visionCalls: 0,
    jsonCalls: 0,
    jsonValid: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  if (!fs.existsSync(logPath)) return report;
  for (const line of fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    report.totalCalls++;
    report.byModel[r.model] = (report.byModel[r.model] || 0) + 1;
    if (r.kind === "vision") report.visionCalls++;
    if (r.kind === "json" || r.jsonValid !== undefined) {
      report.jsonCalls++;
      if (r.jsonValid) report.jsonValid++;
    }
    report.inputTokens += r.inputTokens || 0;
    report.outputTokens += r.outputTokens || 0;
  }
  return report;
}

/** Strip markdown code fences and any prose around the first JSON object/array. */
export function cleanJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();
  const start = text.search(/[[{]/);
  if (start >= 0) {
    const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (end > start) return text.slice(start, end + 1);
  }
  return text.trim();
}

export class QwenClient {
  private client: OpenAI;

  constructor(apiKey?: string) {
    this.client = new OpenAI({
      apiKey: apiKey || getApiKey(),
      baseURL: QWEN_BASE_URL,
    });
  }

  async chat(options: {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string> {
    const model = options.model || "qwen-max";
    const res = await this.client.chat.completions.create({
      model,
      messages: options.messages as any,
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens,
    });
    logUsage({
      model,
      kind: "chat",
      inputTokens: res.usage?.prompt_tokens,
      outputTokens: res.usage?.completion_tokens,
    });
    return res.choices[0].message.content || "";
  }

  async jsonChat<T = any>(options: {
    messages: ChatMessage[];
    model?: string;
    temperature?: number;
  }): Promise<T> {
    const text = await this.chat({
      ...options,
      model: options.model || "qwen-max",
      temperature: options.temperature ?? 0.1,
    });
    try {
      const parsed = JSON.parse(cleanJson(text));
      logUsage({ model: options.model || "qwen-max", kind: "json", jsonValid: true });
      return parsed;
    } catch (e) {
      logUsage({ model: options.model || "qwen-max", kind: "json", jsonValid: false });
      throw new Error(`Qwen returned invalid JSON: ${text.slice(0, 200)}`);
    }
  }

  async visionChat(options: {
    imageBase64: string;
    prompt: string;
    model?: string;
    mime?: string;
    temperature?: number;
  }): Promise<string> {
    const model = options.model || "qwen-vl-max";
    const mime = options.mime || "image/jpeg";
    const url = `data:${mime};base64,${options.imageBase64}`;
    const res = await this.client.chat.completions.create({
      model,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url } },
            { type: "text", text: options.prompt },
          ],
        } as any,
      ],
      temperature: options.temperature ?? 0.1,
    });
    logUsage({
      model,
      kind: "vision",
      inputTokens: res.usage?.prompt_tokens,
      outputTokens: res.usage?.completion_tokens,
    });
    return res.choices[0].message.content || "";
  }

  /** Vision call whose answer must be JSON — fence-stripped and validated. */
  async visionJson<T = any>(options: {
    imageBase64: string;
    prompt: string;
    model?: string;
    mime?: string;
  }): Promise<T> {
    const raw = await this.visionChat(options);
    try {
      const parsed = JSON.parse(cleanJson(raw));
      logUsage({ model: options.model || "qwen-vl-max", kind: "json", jsonValid: true });
      return parsed;
    } catch (e) {
      logUsage({ model: options.model || "qwen-vl-max", kind: "json", jsonValid: false });
      throw new Error(`Qwen-VL returned invalid JSON: ${raw.slice(0, 200)}`);
    }
  }
}
