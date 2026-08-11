import type { LLMClient } from "./types.js";

/**
 * OpenAI-compatible LLM client.
 * Works with OpenAI, Ollama, LM Studio, and any endpoint that implements the /chat/completions API.
 */
export class OpenAILLMClient implements LLMClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(opts: { apiKey: string; baseUrl?: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.model = opts.model ?? "gpt-4o-mini";
  }

  async complete(prompt: string): Promise<string> {
    const url = `${this.baseUrl}/chat/completions`;
    const body = {
      model: this.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 500,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${text}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0]?.message?.content ?? "";
  }
}
