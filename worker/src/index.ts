/**
 * Question Deck AI Worker
 * Two routes:
 *   POST /seed  — rough idea -> 3 variant questions
 *   POST /batch — persona-tuned batch of 8 questions (backs the deck's "Write new ones")
 *
 * Guards: origin allowlist, daily KV cap.
 * Set via `wrangler secret put ANTHROPIC_API_KEY`.
 * Set ALLOWED_ORIGINS and DAILY_CAP in wrangler.toml [vars].
 */

import Anthropic from "@anthropic-ai/sdk";

export interface Env {
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGINS: string;  // comma-separated, e.g. "https://sdiasuez11.github.io"
  DAILY_CAP: string;        // e.g. "50"
  RATE_LIMIT: KVNamespace;
}

function corsHeaders(origin: string) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function jsonResponse(body: unknown, status = 200, origin = "") {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}

async function checkDailyCap(env: Env): Promise<{ allowed: boolean; used: number; cap: number }> {
  const cap = parseInt(env.DAILY_CAP || "50", 10);
  const key = "calls:" + new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const raw = await env.RATE_LIMIT.get(key);
  const used = raw ? parseInt(raw, 10) : 0;
  if (used >= cap) return { allowed: false, used, cap };
  // increment with 25-hour TTL so keys expire after the day rolls over
  await env.RATE_LIMIT.put(key, String(used + 1), { expirationTtl: 90000 });
  return { allowed: true, used: used + 1, cap };
}

async function callClaude(env: Env, prompt: string, maxTokens: number): Promise<string> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await client.messages.create({
    model: "claude-opus-5",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("no text block");
  return block.text;
}

function parseJsonArray(raw: string): unknown[] {
  const clean = raw.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);
  if (!Array.isArray(parsed)) throw new Error("not an array");
  return parsed;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // CORS preflight
    if (request.method === "OPTIONS") {
      if (allowed.includes(origin)) {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }
      return new Response(null, { status: 403 });
    }

    // Origin check — must be a configured allowed origin
    if (!allowed.includes(origin)) {
      return jsonResponse({ error: "origin not allowed" }, 403);
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "method not allowed" }, 405, origin);
    }

    // Daily cap
    const cap = await checkDailyCap(env);
    if (!cap.allowed) {
      return jsonResponse(
        { error: `Daily generation limit reached (${cap.cap}/day). Try again tomorrow.` },
        429,
        origin
      );
    }

    let body: { prompt?: string };
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400, origin);
    }

    const { prompt } = body;
    if (!prompt || typeof prompt !== "string" || prompt.trim().length < 5) {
      return jsonResponse({ error: "prompt is required" }, 400, origin);
    }

    // Route
    if (url.pathname === "/seed") {
      try {
        const raw = await callClaude(env, prompt, 800);
        const variants = parseJsonArray(raw)
          .slice(0, 3)
          .map((v: unknown) => {
            const item = v as Record<string, unknown>;
            return {
              text: String(item.text || "").trim(),
              vibe: item.vibe === "deep" ? "deep" : "playful",
            };
          })
          .filter((v) => v.text.length > 0);
        if (!variants.length) throw new Error("empty response");
        return jsonResponse({ variants }, 200, origin);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        return jsonResponse({ error: "Generation failed: " + msg }, 502, origin);
      }
    }

    if (url.pathname === "/batch") {
      try {
        const raw = await callClaude(env, prompt, 1400);
        const questions = parseJsonArray(raw)
          .map((v: unknown) => {
            const item = v as Record<string, unknown>;
            return {
              text: String(item.text || "").trim(),
              vibe: item.vibe === "deep" ? "deep" : "playful",
            };
          })
          .filter((v) => v.text.length > 0);
        if (!questions.length) throw new Error("empty response");
        return jsonResponse({ questions }, 200, origin);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "unknown error";
        return jsonResponse({ error: "Generation failed: " + msg }, 502, origin);
      }
    }

    return jsonResponse({ error: "not found" }, 404, origin);
  },
};
