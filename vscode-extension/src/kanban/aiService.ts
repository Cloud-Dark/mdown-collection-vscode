import * as vscode from "vscode";
import { KanbanCard, FileEditProposal, CardPriority } from "./types";

export interface KanbanAiService {
  generatePlan(input: { requirement: string }): Promise<{ cards: Array<{ title: string; description: string; priority?: CardPriority }> }>;
  implementCards(input: { requirement: string; cards: KanbanCard[] }): Promise<{ proposals: FileEditProposal[] }>;
}

interface OpenAiMessage {
  role: "system" | "user";
  content: string;
}

export class OpenAiKanbanService implements KanbanAiService {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getConfig: () => { baseUrl: string; model: string }
  ) {}

  async generatePlan(input: { requirement: string }): Promise<{ cards: Array<{ title: string; description: string }> }> {
    const system = "You are a planning assistant. Return strict JSON only.";
    const user = `Buat planning cards untuk requirement berikut dalam bahasa Indonesia: ${input.requirement}. Return JSON format: {\"cards\":[{\"title\":string,\"description\":string}]}. Buat 3-6 cards.`;
    const json = await this.chatJson([ { role: "system", content: system }, { role: "user", content: user } ]);
    const cards = Array.isArray(json?.cards) ? json.cards : [];
    if (!cards.length) throw new Error("AI tidak mengembalikan planning cards yang valid.");
    return {
      cards: cards.map((c: any) => ({
        title: String(c.title ?? "Untitled"),
        description: String(c.description ?? "")
      }))
    };
  }

  async implementCards(input: { requirement: string; cards: KanbanCard[] }): Promise<{ proposals: FileEditProposal[] }> {
    const cardText = input.cards.map((c) => {
      const refs = c.docRefs?.length ? ` | docs: ${c.docRefs.join(", ")}` : "";
      return `- [${c.id}] ${c.title}: ${c.description}${refs}`;
    }).join("\n");
    const hasDocRefs = input.cards.some((c) => Array.isArray(c.docRefs) && c.docRefs.length > 0);
    const system = "You are a coding assistant. Return strict JSON only.";
    const user = `Project requirement: ${input.requirement}\nTasks:\n${cardText}\n${hasDocRefs ? "Gunakan docs yang direferensikan di tiap task sebagai acuan utama." : ""}\nReturn JSON format: {\"proposals\":[{\"cardId\":string,\"filePath\":string,\"action\":\"create\"|\"replace\",\"content\":string,\"summary\":string}]}. Only relative file paths.`;
    const json = await this.chatJson([ { role: "system", content: system }, { role: "user", content: user } ]);
    const proposals = Array.isArray(json?.proposals) ? json.proposals : [];
    if (!proposals.length) {
      throw new Error("AI tidak mengembalikan proposal edit yang valid.");
    }
    return {
      proposals: proposals.map((p: any) => ({
        cardId: String(p.cardId ?? ""),
        filePath: String(p.filePath ?? ""),
        action: p.action === "create" ? "create" : "replace",
        content: String(p.content ?? ""),
        summary: String(p.summary ?? "")
      }))
    };
  }

  private async chatJson(messages: OpenAiMessage[]): Promise<any> {
    const { baseUrl, model } = this.getConfig();
    const apiKey = await this.context.secrets.get("docBridge.kanban.apiKey");
    if (!apiKey) throw new Error("API key belum diset. Jalankan command: Kanban: Set API Key");

    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages,
        response_format: { type: "json_object" }
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`AI request gagal (${response.status}): ${text}`);
    }

    const data = await response.json() as any;
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("AI response kosong atau bukan string.");
    }

    try {
      return JSON.parse(content);
    } catch {
      throw new Error("AI response bukan JSON valid.");
    }
  }
}
