'use strict';
// Local machine translation, in a worker thread.
//
// This is the only engine that needs no key, no account and no quota: the model
// runs in this process and the text never leaves the machine. That is what makes
// whole-ticket translation affordable - a full thread is thousands of characters,
// which would exhaust a free hosted tier on one ticket.
//
// It lives in a worker for one reason: inference is synchronous, CPU-bound and
// takes about a second per sentence. Run it on the main thread and a fifty
// segment ticket stops answering every other agent's requests for a minute.
//
// Models are Helsinki-NLP opus-mt, one per language pair, ~40-80MB each,
// downloaded on first use and then cached on disk - the "install a language
// package on demand" behaviour. They are pairwise, not multilingual: the
// many-to-English model was tested and is not good enough to put in front of a
// client ("je souhaite annuler ma reservation" came back as "I want to warm up
// the mahe"), whereas the dedicated pairs read correctly.

const { parentPort, workerData } = require('worker_threads');
const path = require('path');

// Quantised weights. fp32 was tried first and the process was killed loading it
// on an 8GB box; q8 fits, loads in half the time, and the output was
// indistinguishable in testing.
const DTYPE = 'q8';
// Each resident model is a few hundred MB of RSS. Two covers the normal case (a
// language and its reverse, or two busy inboxes) without putting the server at
// risk of being killed. They are released again once the engine goes idle -
// see unloadAll and the parent's idle shutdown.
const MAX_RESIDENT_MODELS = Number(workerData?.maxModels || 2);
const CACHE_DIR = workerData?.cacheDir || path.join(__dirname, 'data', 'mt-models');

// ------------------------------------------------------------------- batching
//
// The pipeline takes an array, and handing it the whole ticket at once looks
// like the cheap thing to do. It is the opposite. A batch is padded to its
// longest member and the decoder runs until every row in it has finished, so a
// batch costs (rows x longest row), not the sum of its rows. A real mail body is
// a few long paragraphs among a hundred short nodes - "Bonjour,", a name, a
// signature line, an empty table cell - so one batch of 200 nodes charges every
// one of those short nodes the full length of the longest paragraph.
//
// Measured against this repo's model cache, a 200-node body of that shape sent
// as a single batch did not finish in ten minutes and peaked over 1.3GB of RSS.
// That is the "cannot translate an opened ticket" failure: the request outlives
// the gateway, the gateway answers 502 with an HTML body, and the toast has no
// reason in it to print beyond the status code.
//
// So: sort by length, group like with like, and cap each group by both row count
// and padded cost. The sort is what makes the cap effective - neighbours in a
// sorted list are nearly the same length, so almost no padding is added.
const MAX_BATCH_ROWS = Number(workerData?.batchRows || 8);
// Rows x longest-row-chars. 3200 is eight rows of 400 chars, or thirty-two of
// 100 - either way a couple of seconds of CPU and a bounded tensor.
const MAX_BATCH_COST = Number(workerData?.batchCost || 3200);
// opus-mt has a 512-token window. A text node longer than that is split on
// sentence boundaries and rejoined afterwards, because the alternative is the
// model quietly truncating it: a client's paragraph that stops mid-sentence
// reads as our bug and is invisible without the original beside it.
const MAX_TEXT_CHARS = Number(workerData?.maxTextChars || 480);

// Pairs published as ONNX. Anything not here is reached by pivoting through
// English, which is why en is on both sides of almost every entry.
const AVAILABLE_PAIRS = new Set([
  'ar-en', 'de-en', 'de-fr', 'en-ar', 'en-de', 'en-es', 'en-fr', 'en-it',
  'en-nl', 'en-ro', 'en-ru', 'en-zh', 'es-en', 'fr-de', 'fr-en', 'it-en',
  'ja-en', 'ko-en', 'nl-en', 'pl-en', 'ru-en', 'tr-en', 'zh-en'
]);

let transformers = null;
const resident = new Map(); // "fr-en" -> { pipeline, lastUsed }

async function getTransformers() {
  if (!transformers) {
    transformers = await import('@huggingface/transformers');
    transformers.env.cacheDir = CACHE_DIR;
    // Downloads are the whole point - a language package arrives the first time
    // someone asks for that language.
    transformers.env.allowRemoteModels = true;
  }
  return transformers;
}

// Base language, since models are keyed by language and not locale: zh-TW and
// zh share a model, fr-CA and fr likewise.
function base(code) { return String(code || '').split('-')[0].toLowerCase(); }

// How to get from one language to another: a direct model, or two hops through
// English. Returns null when neither exists.
function route(from, to) {
  const a = base(from);
  const b = base(to);
  if (!a || !b || a === b) return [];
  if (AVAILABLE_PAIRS.has(`${a}-${b}`)) return [`${a}-${b}`];
  if (a !== 'en' && b !== 'en' && AVAILABLE_PAIRS.has(`${a}-en`) && AVAILABLE_PAIRS.has(`en-${b}`)) {
    return [`${a}-en`, `en-${b}`];
  }
  return null;
}

async function getPipeline(pair) {
  const hit = resident.get(pair);
  if (hit) { hit.lastUsed = Date.now(); return hit.pipeline; }

  const { pipeline } = await getTransformers();
  // First call for a language downloads it; later calls read the disk cache.
  const built = await pipeline('translation', `Xenova/opus-mt-${pair}`, { dtype: DTYPE });
  resident.set(pair, { pipeline: built, lastUsed: Date.now() });

  // Evict least-recently-used beyond the cap, and dispose properly - dropping
  // the reference alone leaves the ONNX session holding its memory.
  while (resident.size > MAX_RESIDENT_MODELS) {
    let oldest = null;
    for (const [key, value] of resident) {
      if (!oldest || value.lastUsed < resident.get(oldest).lastUsed) oldest = key;
    }
    if (oldest === pair || oldest === null) break;
    const evicted = resident.get(oldest);
    resident.delete(oldest);
    try { await evicted.pipeline.dispose?.(); } catch (_) { /* best effort */ }
  }
  return built;
}

// Release every resident model. The parent calls this when nobody has translated
// anything for a while: a language package sitting idle is several hundred MB of
// RSS held against the chance that someone translates another ticket, and
// reloading it from the disk cache costs a couple of seconds.
async function unloadAll() {
  const entries = [...resident.values()];
  resident.clear();
  for (const entry of entries) {
    try { await entry.pipeline.dispose?.(); } catch (_) { /* best effort */ }
  }
  return entries.length;
}

// Split a long text into pieces the model's window can hold, keeping every
// delimiter attached so rejoining is plain concatenation - no character of the
// client's text is invented or dropped. Sentence ends first; a "sentence" that
// is still too long (a pasted log line, a list of URLs) is cut at a space.
function splitLongText(text) {
  if (text.length <= MAX_TEXT_CHARS) return [text];
  const pieces = [];
  let rest = text;
  while (rest.length > MAX_TEXT_CHARS) {
    const window = rest.slice(0, MAX_TEXT_CHARS);
    let cut = Math.max(
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
      window.lastIndexOf('\n')
    );
    // Only take a boundary that actually divides the window; one at character 3
    // would turn a paragraph into hundreds of fragments.
    cut = cut > MAX_TEXT_CHARS * 0.4 ? cut + 1 : -1;
    if (cut < 0) {
      const space = window.lastIndexOf(' ');
      cut = space > MAX_TEXT_CHARS * 0.4 ? space + 1 : MAX_TEXT_CHARS;
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

// Group row indices into batches of similar-length rows, capped by row count and
// by padded cost. Returns an array of index arrays.
function planBatches(rows) {
  const order = rows.map((_, i) => i).sort((a, b) => rows[a].length - rows[b].length);
  const batches = [];
  let current = [];
  let longest = 0;
  for (const i of order) {
    const nextLongest = Math.max(longest, rows[i].length);
    const cost = (current.length + 1) * nextLongest;
    if (current.length && (current.length >= MAX_BATCH_ROWS || cost > MAX_BATCH_COST)) {
      batches.push(current);
      current = [];
      longest = 0;
    }
    current.push(i);
    longest = Math.max(longest, rows[i].length);
  }
  if (current.length) batches.push(current);
  return batches;
}

// One hop over every string: split what is too long, batch by length, translate
// each batch, then put every piece back where it came from.
async function runHop(pair, texts, onProgress) {
  const translate = await getPipeline(pair);

  // Flatten to pieces, remembering which text each piece came from.
  const rows = [];
  const layout = texts.map(text => splitLongText(String(text ?? '')).map(piece => {
    rows.push(piece);
    return rows.length - 1;
  }));

  const out = new Array(rows.length);
  const batches = planBatches(rows);
  let done = 0;
  for (const batch of batches) {
    const input = batch.map(i => rows[i]);
    // A batch of blank-ish rows has nothing for the model to do, and asking it
    // anyway is where opus-mt likes to invent a sentence out of "-".
    if (input.every(t => !t.trim())) {
      batch.forEach(i => { out[i] = rows[i]; });
    } else {
      const result = await translate(input);
      const list = Array.isArray(result) ? result : [result];
      batch.forEach((i, k) => {
        const text = list[k]?.translation_text;
        // A row that produces nothing keeps its input, so a later hop still has
        // something to work with and the caller falls back to the original.
        out[i] = typeof text === 'string' && text.trim() ? text : rows[i];
      });
    }
    done += batch.length;
    if (onProgress) onProgress(done, rows.length);
  }

  // Rejoin: a text that was never split is its single piece, one that was gets
  // its pieces concatenated back in original order, delimiters and all.
  return layout.map(ids => (ids.length === 1 ? out[ids[0]] : ids.map(id => out[id]).join('')));
}

parentPort.on('message', async (msg) => {
  const { id, kind } = msg || {};
  try {
    if (kind === 'route') {
      // Asked before committing: can this pair be served at all?
      parentPort.postMessage({ id, ok: true, result: { route: route(msg.source, msg.target) } });
      return;
    }
    if (kind === 'unload') {
      parentPort.postMessage({ id, ok: true, result: { unloaded: await unloadAll() } });
      return;
    }
    if (kind === 'warm') {
      const hops = route(msg.source, msg.target);
      if (!hops) throw new Error(`no model route from ${msg.source} to ${msg.target}`);
      for (const hop of hops) await getPipeline(hop);
      parentPort.postMessage({ id, ok: true, result: { warmed: hops } });
      return;
    }
    if (kind === 'translate') {
      const hops = route(msg.source, msg.target);
      if (!hops) throw new Error(`no model route from ${msg.source} to ${msg.target}`);
      let texts = msg.texts;
      // Already in the target language: nothing to do, and no model to load.
      if (!hops.length) {
        parentPort.postMessage({ id, ok: true, result: { texts, hops } });
        return;
      }
      // Progress is per batch, not per hop. A hundred-node body is now dozens
      // of small batches rather than one opaque wait, and the parent uses these
      // to tell a slow translation from a wedged one.
      for (let h = 0; h < hops.length; h++) {
        texts = await runHop(hops[h], texts, (done, total) => {
          parentPort.postMessage({ progress: { id, hop: h + 1, hops: hops.length, done, total } });
        });
      }
      parentPort.postMessage({ id, ok: true, result: { texts, hops } });
      return;
    }
    throw new Error(`unknown message kind: ${kind}`);
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error?.message || error) });
  }
});

parentPort.postMessage({ ready: true });
