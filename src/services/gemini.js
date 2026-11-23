/**
 * src/services/gemini.js
 * Thin wrapper around @google/genai v1.x with:
 *   - 5s timeout on every call
 *   - LRU cache (GEMINI_CACHE_SIZE entries)
 *   - Deterministic fallback when API key absent or call fails
 */

import { GEMINI_MODEL, GEMINI_EMBED_MODEL, GEMINI_CACHE_SIZE, GEMINI_TIMEOUT_MS } from '../config.js';

// ── LRU cache ─────────────────────────────────────────────────────────────────

class LRUCache {
  /** @param {number} max */
  constructor(max) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) { return undefined; }
    const val = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, val);
    return val;
  }
  set(key, val) {
    if (this.map.has(key)) { this.map.delete(key); }
    if (this.map.size >= this.max) {
      this.map.delete(this.map.keys().next().value);
    }
    this.map.set(key, val);
  }
  has(key) { return this.map.has(key); }
}

const cache = new LRUCache(GEMINI_CACHE_SIZE);

// ── Lazy client init ──────────────────────────────────────────────────────────

let _client = null;
let _ready = false;
let GoogleGenAIClass = null;

async function ensureClient() {
  if (_client) { return _client; }
  if (!process.env.GEMINI_API_KEY) { return null; }
  try {
    if (!GoogleGenAIClass) {
      const mod = await import('@google/genai');
      GoogleGenAIClass = mod.GoogleGenAI;
    }
    _client = new GoogleGenAIClass({ apiKey: process.env.GEMINI_API_KEY });
    _ready = true;
    return _client;
  } catch (_e) {
    return null;
  }
}

// ── Timeout helper ────────────────────────────────────────────────────────────

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Gemini timeout')), ms)
    ),
  ]);
}

// ── Prompt injection hygiene ──────────────────────────────────────────────────

function wrapUserText(text) {
  return `<<<USER_INPUT>>>${text}<<<END_USER_INPUT>>>`;
}

// ── Gemini service ────────────────────────────────────────────────────────────

export const geminiService = {
  get isReady() { return _ready && !!_client; },

  /**
   * Generate text completion.
   * @param {string} prompt
   * @param {string} [fallback]
   * @returns {Promise<{ text: string, source: 'gemini'|'template' }>}
   */
  async generate(prompt, fallback = '') {
    const cacheKey = 'gen:' + prompt.slice(0, 200);
    if (cache.has(cacheKey)) { return { text: cache.get(cacheKey), source: 'gemini' }; }

    const client = await ensureClient();
    if (!client) { return { text: fallback, source: 'template' }; }

    try {
      const result = await withTimeout(
        client.models.generateContent({ model: GEMINI_MODEL, contents: prompt }),
        GEMINI_TIMEOUT_MS
      );
      // v1.x API: result.text or candidates path
      const text = (typeof result.text === 'string' ? result.text : null)
        ?? result?.candidates?.[0]?.content?.parts?.[0]?.text
        ?? fallback;
      cache.set(cacheKey, text);
      return { text, source: 'gemini' };
    } catch (_e) {
      return { text: fallback, source: 'template' };
    }
  },

  /**
   * Embed a single string.
   * @param {string} text
   * @returns {Promise<number[]|null>}
   */
  async embed(text) {
    const cacheKey = 'emb:' + text.slice(0, 200);
    if (cache.has(cacheKey)) { return cache.get(cacheKey); }

    const client = await ensureClient();
    if (!client) { return null; }

    try {
      const result = await withTimeout(
        client.models.embedContent({ model: GEMINI_EMBED_MODEL, contents: text }),
        GEMINI_TIMEOUT_MS
      );
      // v1.x: result.embeddings[0].values
      const vec = result?.embeddings?.[0]?.values ?? null;
      if (vec) { cache.set(cacheKey, vec); }
      return vec;
    } catch (_e) {
      return null;
    }
  },

  /**
   * Embed multiple texts in one batched call.
   * @param {string[]} texts
   * @returns {Promise<number[][]|null>}
   */
  async embedBatch(texts) {
    const client = await ensureClient();
    if (!client) { return null; }

    try {
      const result = await withTimeout(
        client.models.embedContent({ model: GEMINI_EMBED_MODEL, contents: texts }),
        GEMINI_TIMEOUT_MS
      );
      return result?.embeddings?.map(e => e.values) ?? null;
    } catch (_e) {
      return null;
    }
  },

  /**
   * Build a Risk and Readiness summary.
   * Falls back to a deterministic template if Gemini is unavailable.
   * @param {object} booking
   * @param {object} item
   * @param {object} user
   * @param {object} project
   * @returns {Promise<{ summary: string, missingPrereqs: string[], source: 'gemini'|'template' }>}
   */
  async readinessSummary(booking, item, user, project) {
    const missing = (item.prerequisiteModules ?? []).filter(
      m => !(user.completedModules ?? []).includes(m)
    );

    const facts = [
      `Item: ${item.name} (risk: ${item.riskLevel})`,
      `Student: ${user.name}`,
      `Project: ${project.title} (deadline: ${project.hardDeadline})`,
      `Completed modules: ${(user.completedModules ?? []).join(', ') || 'none'}`,
      `Required modules: ${(item.prerequisiteModules ?? []).join(', ') || 'none'}`,
      `Missing prerequisites: ${missing.join(', ') || 'none'}`,
      `Trailing usage hours (14 days): ${user.trailingUsageHours ?? 0}`,
    ].join('\n');

    const templateSummary =
      `${user.name} requests "${item.name}" (risk level: ${item.riskLevel}) for project "${project.title}" ` +
      `(deadline: ${new Date(project.hardDeadline).toLocaleDateString()}). ` +
      (missing.length
        ? `⚠ Missing prerequisites: ${missing.join(', ')}. Faculty review required.`
        : 'All prerequisites met.') +
      ` Trailing lab usage: ${user.trailingUsageHours ?? 0} hours in the past 14 days.` +
      ` Verify with the lab technician.`;

    const prompt =
      `You are a lab safety officer. Write a concise one-paragraph risk and readiness summary ` +
      `for a faculty approval decision. Use only these facts:\n${wrapUserText(facts)}\n` +
      `Output only the summary paragraph, no preamble. End with "verify with the lab technician".`;

    const { text, source } = await this.generate(prompt, templateSummary);
    return { summary: text || templateSummary, missingPrereqs: missing, source };
  },

  /**
   * Turn mediator JSON result into friendly negotiation text.
   * @param {object} mediationResult
   * @param {object} item
   * @returns {Promise<{ text: string, source: 'gemini'|'template' }>}
   */
  async negotiationText(mediationResult, _item) {
    const templateText = mediationResult.reason;
    const prompt =
      `You are a fair and helpful lab coordinator. Rewrite the following conflict mediation result ` +
      `as a friendly, concise message to students. Keep all facts identical. Max 100 words.\n` +
      `Facts: ${wrapUserText(JSON.stringify({ reason: mediationResult.reason, alternatives: mediationResult.alternatives }))}`;

    return this.generate(prompt, templateText);
  },
};
