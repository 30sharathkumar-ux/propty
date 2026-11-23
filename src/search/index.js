/**
 * src/search/index.js
 * Semantic search – local TF-IDF mode (always available) + optional Gemini dense embeddings.
 */

import { itemRepo } from '../repo/index.js';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../config.js';
import { geminiService } from '../services/gemini.js';

// ── Domain synonym map ────────────────────────────────────────────────────────
const SYNONYMS = {
  'oscilloscope': ['scope', 'osc', 'waveform viewer'],
  'spectrum analyser': ['spectrum analyzer', 'sa', 'spectrum'],
  'vna': ['vector network analyser', 'vector network analyzer', 'network analyser'],
  'fpga': ['programmable logic', 'xilinx', 'intel fpga'],
  'gpu': ['graphics card', 'cuda', 'deep learning workstation'],
  'jetson': ['edge ai', 'nvidia jetson', 'orin'],
  'lidar': ['lidar sensor', 'point cloud', '3d mapping'],
  'soldering': ['solder', 'iron', 'soldering station'],
  'cnc': ['cnc router', 'milling machine', 'cnc mill'],
  '5g': ['fifth generation', 'nr', 'sub6', 'millimeter wave'],
  'mmwave': ['mmwave', 'millimeter wave', '5g mmwave', 'mm-wave'],
  'antenna': ['antenna testing', 'radiation pattern', 'patch antenna'],
  'computer vision': ['cv', 'image processing', 'object detection', 'yolo'],
  'inference': ['model inference', 'deployment', 'edge inference'],
  'slam': ['simultaneous localisation', 'mapping', 'autonomous navigation'],
  '3d print': ['3d printing', 'fdm', 'resin', 'additive manufacturing'],
  'robotics': ['robot arm', 'cobot', 'manipulation'],
  'pcb': ['printed circuit board', 'circuit board'],
};

// ── Tokeniser ─────────────────────────────────────────────────────────────────

/** @param {string} text @returns {string[]} tokens */
function tokenise(text) {
  if (!text) { return []; }
  const lower = text.toLowerCase();
  // Apply synonym expansion before tokenising
  let expanded = lower;
  for (const [canonical, variants] of Object.entries(SYNONYMS)) {
    for (const v of variants) {
      if (lower.includes(v)) {
        expanded += ' ' + canonical;
      }
    }
  }
  return expanded
    .split(/[\s,.\-/()[\]|&]+/)
    .map(t => t.trim())
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'of', 'in', 'is', 'with', 'on', 'at', 'by', 'as', 'it', 'its', 'this', 'that', 'are', 'be', 'can', 'use', 'used', 'using']);

// ── TF-IDF index ──────────────────────────────────────────────────────────────

/**
 * @typedef {object} IndexedItem
 * @property {string} id
 * @property {string[]} tokens
 * @property {Record<string, number>} tf
 * @property {object} raw  original item
 */

/** @type {IndexedItem[]} */
let tfidfIndex = [];
/** @type {Record<string, number>} idf per term */
let idfMap = {};

/** Build the TF-IDF index from seed items. Called at boot. */
export function buildIndex() {
  const allItems = itemRepo.findAll();

  // Tokenise each item from multiple fields
  const indexed = allItems.map(item => {
    const text = [
      item.name,
      item.description ?? '',
      item.datasheetSummary ?? '',
      (item.softwareInstalled ?? []).join(' '),
      (item.specTags ?? []).join(' '),
      item.category ?? '',
      item.department ?? '',
    ].join(' ');
    const tokens = tokenise(text);
    const tf = {};
    for (const t of tokens) { tf[t] = (tf[t] ?? 0) + 1; }
    // Normalise TF
    const total = tokens.length || 1;
    for (const t of Object.keys(tf)) { tf[t] = tf[t] / total; }
    return { id: item.id, tokens, tf, raw: item };
  });

  tfidfIndex = indexed;

  // Build IDF
  const N = indexed.length;
  const docFreq = {};
  for (const doc of indexed) {
    for (const t of Object.keys(doc.tf)) {
      docFreq[t] = (docFreq[t] ?? 0) + 1;
    }
  }
  idfMap = {};
  for (const [t, df] of Object.entries(docFreq)) {
    idfMap[t] = Math.log((N + 1) / (df + 1)) + 1;
  }
}

/** Compute TF-IDF cosine similarity between query tokens and an indexed item. */
function tfidfScore(queryTokens, doc) {
  if (!queryTokens.length) { return 0; }
  const qTf = {};
  for (const t of queryTokens) { qTf[t] = (qTf[t] ?? 0) + 1 / queryTokens.length; }

  let dot = 0, qNorm = 0, dNorm = 0;
  const allTerms = new Set([...Object.keys(qTf), ...Object.keys(doc.tf)]);
  for (const t of allTerms) {
    const idf = idfMap[t] ?? 0;
    const qVal = (qTf[t] ?? 0) * idf;
    const dVal = (doc.tf[t] ?? 0) * idf;
    dot   += qVal * dVal;
    qNorm += qVal * qVal;
    dNorm += dVal * dVal;
  }
  if (qNorm === 0 || dNorm === 0) { return 0; }
  return dot / (Math.sqrt(qNorm) * Math.sqrt(dNorm));
}

// ── Dense embeddings (Gemini, optional) ──────────────────────────────────────

/** @type {Map<string, Float32Array>} itemId -> embedding vector */
const embeddingCache = new Map();
let embeddingsReady = false;

/** Cosine similarity between two Float32Arrays. */
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Pre-compute embeddings for all items at boot (only if API key exists).
 * Failure is non-fatal – falls back to TF-IDF.
 */
export async function buildEmbeddings() {
  const allItems = itemRepo.findAll();
  const texts = allItems.map(item =>
    [item.name, item.description ?? '', (item.specTags ?? []).join(' ')].join(' ')
  );

  try {
    const embeddings = await geminiService.embedBatch(texts);
    if (!embeddings) { return; }
    for (let i = 0; i < allItems.length; i++) {
      if (embeddings[i]) {
        embeddingCache.set(allItems[i].id, new Float32Array(embeddings[i]));
      }
    }
    embeddingsReady = embeddingCache.size > 0;
  } catch (_e) {
    // non-fatal
  }
}

// ── Hybrid search ─────────────────────────────────────────────────────────────

/**
 * @typedef {object} SearchResult
 * @property {object} item
 * @property {number} score
 * @property {string} whyMatched
 * @property {string} statusBadge
 */

/**
 * Search items by query string and optional filters.
 * @param {object} opts
 * @param {string} [opts.q]
 * @param {string} [opts.department]
 * @param {string} [opts.category]
 * @param {string} [opts.status]
 * @param {string} [opts.tier]
 * @param {number} [opts.page]
 * @param {number} [opts.pageSize]
 * @returns {Promise<{ results: SearchResult[], total: number, page: number, totalPages: number }>}
 */
export async function search(opts = {}) {
  const { q = '', department, category, status, tier } = opts;
  const page = Math.max(1, parseInt(opts.page ?? '1', 10));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(opts.pageSize ?? String(DEFAULT_PAGE_SIZE), 10)));

  const queryTokens = tokenise(q);
  let queryEmbedding = null;

  // Try to embed the query if embeddings are available
  if (embeddingsReady && q.trim()) {
    try {
      const emb = await geminiService.embed(q);
      if (emb) { queryEmbedding = new Float32Array(emb); }
    } catch (_e) { /* fall back to TF-IDF */ }
  }

  let results = tfidfIndex.map(doc => {
    // Compute relevance score
    const hasQuery = q.trim().length > 0;
    let score;

    if (hasQuery) {
      const tfidf = tfidfScore(queryTokens, doc);
      let dense = 0;
      if (queryEmbedding && embeddingCache.has(doc.id)) {
        dense = cosineSim(queryEmbedding, embeddingCache.get(doc.id));
      }
      // Hybrid: if dense available use 60/40, else pure TF-IDF
      score = queryEmbedding ? 0.6 * dense + 0.4 * tfidf : tfidf;
    } else {
      score = 0.5; // no query = show all with neutral score
    }

    return { doc, score };
  });

  // Apply filters
  results = results.filter(({ doc, score }) => {
    if (q.trim() && score < 0.01) { return false; }
    const item = doc.raw;
    if (department && item.department !== department) { return false; }
    if (category && item.category !== category) { return false; }
    if (status && item.status !== status) { return false; }
    if (tier && String(item.tier) !== tier) { return false; }
    return true;
  });

  // Sort by score descending
  results.sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id));

  const total = results.length;
  const totalPages = Math.ceil(total / pageSize) || 1;
  const paged = results.slice((page - 1) * pageSize, page * pageSize);

  const formatted = paged.map(({ doc, score }) => ({
    item: doc.raw,
    score: +score.toFixed(4),
    whyMatched: buildWhyMatched(queryTokens, doc, queryEmbedding !== null),
    statusBadge: buildStatusBadge(doc.raw.status),
  }));

  return { results: formatted, total, page, totalPages };
}

/** @param {object} item @returns {object[]} compatible items sorted by lab distance */
export function getCompatibleBundle(item, getLabDistance) {
  if (!item?.compatibleWith?.length) { return []; }
  const allItems = itemRepo.findAll();
  return item.compatibleWith
    .map(cid => allItems.find(i => i.id === cid))
    .filter(Boolean)
    .filter(i => i.status !== 'maintenance')
    .map(i => ({
      item: i,
      distance: getLabDistance(item.lab, i.lab),
    }))
    .sort((a, b) => a.distance - b.distance || a.item.tier - b.item.tier);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildWhyMatched(queryTokens, doc, usedDense) {
  if (!queryTokens.length) { return 'Showing all items'; }
  const matched = queryTokens.filter(t => doc.tf[t] > 0);
  const method = usedDense ? 'AI-assisted semantic match' : 'keyword match';
  return matched.length
    ? `${method}: ${matched.slice(0, 5).join(', ')}`
    : `${method} (synonym or semantic)`;
}

const STATUS_BADGES = {
  available:          { text: 'Available',          icon: '✓' },
  in_use:             { text: 'In Use',              icon: '⏳' },
  maintenance:        { text: 'Maintenance',         icon: '🔧' },
  approval_required:  { text: 'Approval Required',  icon: '📋' },
};

function buildStatusBadge(status) {
  return STATUS_BADGES[status] ?? { text: status, icon: '?' };
}
