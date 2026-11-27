/**
 * Matching core. Pure functions with no DOM access, shared by the page,
 * the PDF worker and the Node tests.
 *
 * Two signals decide which manuscript words are flagged for a source
 * (numbers are the defaults; every one is adjustable in DEFAULT_SETTINGS):
 *  A. Window overlap: a 13-word manuscript window and an 11-word source
 *     window share at least 8 distinct words (order ignored).
 *  B. Trigram overlap: 3-word runs (stop words removed) shared with a source
 *     that shares at least 21 of them overall. A shared trigram flags words
 *     only when exactly one source contains it.
 */

export const DEFAULT_SETTINGS = Object.freeze({
  docxWindow: 13, // manuscript window, in words
  pdfWindow: 11, // source window, in words
  windowMatch: 8, // distinct words a pair of windows must share
  phrases: true, // use trigram (phrase) overlap at all
  phraseGate: 21, // trigrams a source must share before any count
  phrasesUniqueOnly: true, // credit only trigrams found in exactly one source
  dropLoneStopWords: true, // unflag stop words with no flagged neighbour
  ignoreReferenceList: true, // exclude a References/Bibliography section whose entries read as citations
  ignoreQuotedText: false, // exclude quotation-mark and blockquote text
  moderateFrom: 10, // overall % where "moderate" starts
  highFrom: 25, // overall % where "high" starts
});

const clampInt = (value, low, high, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
};

/**
 * Fills gaps from the defaults and keeps every setting in a usable range:
 * the words-to-match can never exceed either window, and "high" never
 * starts below "moderate".
 * @param {Partial<typeof DEFAULT_SETTINGS>} input
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeSettings(input = {}) {
  const s = { ...DEFAULT_SETTINGS, ...input };
  const d = DEFAULT_SETTINGS;
  const docxWindow = clampInt(s.docxWindow, 5, 40, d.docxWindow);
  const pdfWindow = clampInt(s.pdfWindow, 5, 40, d.pdfWindow);
  const moderateFrom = clampInt(s.moderateFrom, 0, 100, d.moderateFrom);
  const highFrom = Math.max(moderateFrom, clampInt(s.highFrom, moderateFrom, 100, d.highFrom));
  return {
    docxWindow,
    pdfWindow,
    windowMatch: clampInt(s.windowMatch, 2, Math.min(docxWindow, pdfWindow), d.windowMatch),
    phrases: Boolean(s.phrases),
    phraseGate: clampInt(s.phraseGate, 1, 200, d.phraseGate),
    phrasesUniqueOnly: Boolean(s.phrasesUniqueOnly),
    dropLoneStopWords: Boolean(s.dropLoneStopWords),
    ignoreReferenceList: Boolean(s.ignoreReferenceList),
    ignoreQuotedText: Boolean(s.ignoreQuotedText),
    moderateFrom,
    highFrom,
  };
}

/** Whether every setting is at its default. */
export const isDefaultSettings = (settings) =>
  Object.keys(DEFAULT_SETTINGS).every((key) => settings[key] === DEFAULT_SETTINGS[key]);

/* ---------- Excluded text: reference lists and quotations ---------- */

export const REFERENCE_HEADING_TEXTS = new Set([
  "references",
  "bibliography",
  "works cited",
  "reference list",
  "sources",
  "literature cited",
]);

/** Whether normalised text is exactly a reference-list heading. */
export function isReferenceHeadingText(text = "") {
  return REFERENCE_HEADING_TEXTS.has(cleanWord(text));
}

/**
 * A manuscript block (heading, paragraph or list item) as the reference-list
 * rules see it. `lines` is the block's text split at line breaks, for
 * reference lists typed as one paragraph with a break after each entry.
 * @typedef {{tagName?: string, tag?: string, text?: string, lines?: string[],
 *   bold?: boolean, isBold?: boolean, allBold?: boolean}} Block
 */

const blockShape = (block = {}) => ({
  tag: String(block.tagName || block.tag || "").toLowerCase(),
  text: String(block.text || ""),
  bold: Boolean(block.bold ?? block.isBold ?? block.allBold),
});

const countWords = (text) => cleanWord(String(text)).split(" ").filter(Boolean).length;

// A paragraph that is entirely bold and at most this long reads as a heading
const MAX_BOLD_HEADING_WORDS = 12;

/**
 * Whether a block looks like a reference-list heading: any heading element,
 * or a short standalone paragraph whose text is entirely bold.
 * @param {Block} block
 */
export function isReferenceHeadingBlock(block = {}) {
  const { tag, text, bold } = blockShape(block);
  if (!isReferenceHeadingText(text)) return false;
  if (/^h[1-6]$/.test(tag)) return true;
  return tag === "p" && bold && countWords(text) <= 6;
}

/**
 * Whether a block reads as a heading of any kind: a heading element with
 * text, or a short paragraph that is entirely bold.
 * @param {Block} block
 */
export function isHeadingLikeBlock(block = {}) {
  const { tag, text, bold } = blockShape(block);
  const words = countWords(text);
  if (words === 0) return false;
  if (/^h[1-6]$/.test(tag)) return true;
  return tag === "p" && bold && words <= MAX_BOLD_HEADING_WORDS;
}

/* What makes a line read as a reference-list entry */
const YEAR = /(?:^|\D)(?:1[5-9]|20)\d{2}[a-z]?(?!\d)|\bn\.\s?d\./i;
const LINK = /\bdoi\b|\b10\.\d{4,9}\/|https?:\/\/|\bwww\./i;
const ET_AL = /\bet al\b/i;
const BIBLIOGRAPHIC =
  /\b(?:pp?|vols?|nos?|eds?|edn|trans)\.(?=\s|\d|$)|\b(?:journal|proceedings|press|publishers?|retrieved|accessed|available at)\b|\bin:/i;
// How entries open: "[1]", "1.", "Smith, J.", "Smith, John.", "J. Smith",
// "Smith JA," or "Organisation. (2021)." Running prose rarely opens like this.
const ENTRY_OPENINGS = [
  String.raw`\[\d+\]`, // [1]
  String.raw`\d+[.)]\s`, // 1.  or  1)
  String.raw`\p{Lu}[\p{L}'’-]+(?:\s\p{Lu}[\p{L}'’-]+)*,\s*(?:\p{Lu}\.|\p{Lu}[\p{L}'’-]+[.,])`, // Smith, J. / Smith, John.
  String.raw`(?:\p{Lu}\.\s?)+\p{Lu}[\p{L}'’-]+`, // J. Smith
  String.raw`\p{Lu}[\p{L}'’-]+\s\p{Lu}{1,3}[.,]`, // Smith JA,
  // Organisation. (2021).  or  Organisation. 2021.  ("et al." is not an organisation)
  String.raw`(?:(?!et al\.)[^.]){2,80}\.\s*(?:\((?:1[5-9]|20)\d{2}[a-z]?\)|(?:1[5-9]|20)\d{2}[a-z]?\.)`,
];
const ENTRY_OPENING = new RegExp(String.raw`^\s*(?:${ENTRY_OPENINGS.join("|")})`, "u");
// Entries longer than this are prose (or an annotation), not a citation
const MAX_CITATION_WORDS = 100;

/**
 * Whether one line of text reads as a reference-list entry: it opens like
 * an entry (or carries a DOI or web address) and shows at least two
 * bibliographic signals out of: that opening, a year or "n.d.", a DOI or
 * web address, "et al." and words such as "pp.", "vol.", "Journal", "Press".
 * A body sentence that cites a work ("Smith et al. (2019) found…") does not
 * open like an entry, so it does not count.
 * @param {string} text
 */
export function looksLikeCitation(text = "") {
  const value = String(text);
  const words = countWords(value);
  if (words < 3 || words > MAX_CITATION_WORDS) return false;
  const opensLikeEntry = ENTRY_OPENING.test(value);
  if (!opensLikeEntry && !LINK.test(value)) return false;
  const signals = [YEAR, LINK, ET_AL, BIBLIOGRAPHIC].filter((signal) => signal.test(value)).length;
  return signals + (opensLikeEntry ? 1 : 0) >= 2;
}

// Share of a section's entries that must read as citations
const REFERENCE_SHARE = 0.6;
// Inside a reference list, a paragraph longer than this that doesn't read
// as citations is prose (an appended passage, a note) and is still counted
const MAX_UNRECOGNISED_ENTRY_WORDS = 25;

/** A block's non-empty lines: its text, or each line where it has breaks. */
function blockEntries(block = {}) {
  const lines = Array.isArray(block.lines) && block.lines.length ? block.lines : [blockShape(block).text];
  return lines.map(String).filter((line) => countWords(line) > 0);
}

const readsAsReferences = (entries) =>
  entries.length > 0 &&
  entries.filter((entry) => looksLikeCitation(entry)).length >= entries.length * REFERENCE_SHARE;

/**
 * Finds the reference lists in a manuscript. A reference list starts at a
 * reference heading (see isReferenceHeadingBlock) and holds only if the
 * entries under it read as citations, so a stray "References" line or a
 * body section titled "Sources" excludes nothing. It runs on through
 * subheadings ("Primary sources") whose entries also read as citations, and
 * stops at the first heading whose section doesn't (an appendix, the next
 * chapter). Every such list is found, not just the first.
 * @param {Block[]} blocks - In document order
 * @returns {Array<{start: number, end: number}>} Block index ranges, end exclusive
 */
export function findReferenceSections(blocks = []) {
  const list = Array.from(blocks);
  const sections = [];
  for (let i = 0; i < list.length; i++) {
    if (!isReferenceHeadingBlock(list[i])) continue;
    let end = -1;
    // Walk the parts between headings: each must read as citations
    for (let at = i + 1; at < list.length; ) {
      let next = at;
      while (next < list.length && !isHeadingLikeBlock(list[next])) next++;
      const entries = list.slice(at, next).flatMap(blockEntries);
      if (entries.length > 0) {
        if (!readsAsReferences(entries)) break;
        end = next;
      }
      at = next + 1; // past the heading that closed this part
    }
    if (end > i) {
      sections.push({ start: i, end });
      i = end - 1;
    }
  }
  return sections;
}

/**
 * Which blocks belong to a reference list (see findReferenceSections). A
 * longer paragraph inside a list that doesn't read as citations stays
 * counted, so text pasted under a real reference list is still checked.
 * @param {Block[]} blocks - In document order
 * @returns {boolean[]} One flag per block
 */
export function referenceBlockFlags(blocks = []) {
  const list = Array.from(blocks);
  const flags = new Array(list.length).fill(false);
  for (const { start, end } of findReferenceSections(list)) {
    for (let i = start; i < end; i++) {
      const block = list[i];
      const prose =
        !isHeadingLikeBlock(block) &&
        countWords(blockShape(block).text) > MAX_UNRECOGNISED_ENTRY_WORDS &&
        !readsAsReferences(blockEntries(block));
      flags[i] = !prose;
    }
  }
  return flags;
}

const isWordChar = (char) => char !== undefined && /[\p{L}\p{N}]/u.test(char);
const isDigit = (char) => char !== undefined && /\p{N}/u.test(char);
// What may sit right before an opening straight quote: a space, the start, a bracket or dash
const beforeOpening = (char) => char === undefined || /[\s([{—–-]/u.test(char);
// What may sit right after a closing straight quote: a space, the end, punctuation
const afterClosing = (char) => char === undefined || /[\s.,;:!?)\]}—–-]/u.test(char);

/**
 * Finds which pieces of one paragraph sit inside quotation marks. A
 * quotation counts only once its closing mark is found in the same
 * paragraph, so a stray or unmatched mark never hides the text after it.
 *
 * - “…” and «…» are double quotations; ‘…’ and '…' single ones. Each closing
 *   mark closes the nearest open quotation of its own kind, so ‘yes’ inside
 *   “…” is nested rather than ending the outer quotation.
 * - A straight " opens or closes by position: after a space or bracket and
 *   before text it opens, after text it closes. A closing-shaped mark with
 *   nothing open (an inch mark: 12") is ignored.
 * - ’ or ' between two letters is an apostrophe (don’t, O’Brien); after a
 *   space it is an elision (’90s, ’em); after a word with no single
 *   quotation open it is a possessive (the students’ work). ‘ before a digit
 *   is an elision too (‘90s). None of these open or close anything.
 * - A blockquote is handled by the caller.
 *
 * @param {string[]} pieces - The paragraph's text in order, whitespace pieces
 *   included, so that pieces.join("") is the paragraph
 * @returns {{quoted: boolean[], unclosed: boolean[]}} Per piece: quoted is
 *   inside a quotation closed in this paragraph; unclosed is inside a double
 *   quotation still open at the end, which counts only if the next paragraph
 *   continues it (see continuesQuotation)
 */
export function findQuotedParts(pieces = []) {
  const list = Array.from(pieces, (piece) => String(piece));
  const text = list.join("");
  const stack = []; // open quotations: {id, double, straight}
  const closed = new Set();
  const active = list.map(() => new Set()); // ids open around each piece's letters
  let nextId = 0;

  const open = (double, straight) => stack.push({ id: nextId++, double, straight });
  const close = (matches) => {
    for (let j = stack.length - 1; j >= 0; j--) {
      if (!matches(stack[j])) continue;
      closed.add(stack[j].id);
      stack.length = j; // anything opened inside it and left open ends here too
      return true;
    }
    return false;
  };
  const singleOpen = () => stack.some((entry) => !entry.double);

  let at = 0;
  list.forEach((piece, p) => {
    for (let k = 0; k < piece.length; k++, at++) {
      const char = piece[k];
      const before = text[at - 1];
      const after = text[at + 1];
      if (char === "“" || char === "«") open(true, false);
      else if (char === "”" || char === "»") close((entry) => entry.double && !entry.straight);
      else if (char === '"') {
        const opens = beforeOpening(before) && !afterClosing(after);
        const closes = !beforeOpening(before) && afterClosing(after);
        const straightOpen = (entry) => entry.double && entry.straight;
        if (opens) open(true, true);
        else if (closes) close(straightOpen);
        else if (!close(straightOpen)) open(true, true); // " on its own, or between letters
      } else if (char === "‘" || char === "'" || char === "’") {
        const straight = char === "'";
        if (isWordChar(before) && isWordChar(after)) continue; // apostrophe
        if (char !== "’" && beforeOpening(before) && isWordChar(after) && !isDigit(after)) {
          open(false, straight);
        } else if (char !== "‘" && !beforeOpening(before) && singleOpen()) {
          close((entry) => !entry.double && entry.straight === straight);
        }
        // Otherwise an elision or possessive: nothing opens or closes
      } else if (stack.length && isWordChar(char)) {
        for (const entry of stack) active[p].add(entry.id);
      }
    }
  });

  const pendingDouble = new Set(stack.filter((entry) => entry.double).map((entry) => entry.id));
  const quoted = active.map((ids) => Array.from(ids).some((id) => closed.has(id)));
  const unclosed = active.map(
    (ids, p) => !quoted[p] && Array.from(ids).some((id) => pendingDouble.has(id))
  );
  return { quoted, unclosed };
}

/**
 * Whether a paragraph opens with an opening double quotation mark. A
 * quotation running over several paragraphs repeats the opening mark on
 * each one and closes only at the end, so the paragraph before it counts as
 * quoted too.
 * @param {string} text
 */
export function continuesQuotation(text = "") {
  return /^\s*(?:[“«]|"(?=[^\s"]))/u.test(String(text));
}

/**
 * Quoted flags for the whitespace-delimited parts of one paragraph.
 * @param {string[]} parts
 * @returns {boolean[]}
 */
export function markQuotedParts(parts = []) {
  const list = Array.from(parts, (part) => String(part));
  const { quoted } = findQuotedParts(list.flatMap((part, i) => (i ? [" ", part] : [part])));
  return list.map((_, i) => quoted[i * 2]);
}

/**
 * Ids excluded under the settings: reference-list words when
 * ignoreReferenceList is on, quoted words when ignoreQuotedText is on.
 * Words carry inReferenceList / inQuotedText flags (see manuscript.js).
 */
export function getExcludedWordIds(words = [], settings = DEFAULT_SETTINGS) {
  const excluded = new Set();
  words.forEach((word, index) => {
    const id = word.id ?? index;
    if (
      (settings.ignoreReferenceList && word.inReferenceList) ||
      (settings.ignoreQuotedText && word.inQuotedText)
    ) {
      excluded.add(id);
    }
  });
  return excluded;
}

/** Counted/ignored word totals for a manuscript under the settings. */
export function exclusionSummary(words = [], settings = DEFAULT_SETTINGS) {
  const excludedIds = getExcludedWordIds(words, settings);
  return {
    totalWords: words.length,
    countedWords: words.length - excludedIds.size,
    ignoredWords: excludedIds.size,
    referenceListIgnoredWords: settings.ignoreReferenceList
      ? words.filter((word) => word.inReferenceList).length
      : 0,
    quotedIgnoredWords: settings.ignoreQuotedText
      ? words.filter((word) => word.inQuotedText).length
      : 0,
    excludedIds,
  };
}

/* ---------- Words: what counts as one, and how it is compared ---------- */

// Characters that hold a word together wherever they appear: apostrophes
// (don't, O\u2019Brien, \u201890s), the soft hyphen and invisible joiners
const JOINERS = "'\u2019\u02bc\u2018\u00ad\u200c\u200d\u2060\ufeff";
const WORD_CHARS = String.raw`\p{L}\p{M}\p{N}${JOINERS}`;
// One word: letters, combining marks and digits, plus joiners, with hyphens
// allowed between them (state-of-the-art). Anything else between two words,
// such as a dash, slash, full stop or bracket, separates them, so
// "flood\u2014which" is two words, as "flood \u2014 which" is.
const WORD_RUN = new RegExp(`[${WORD_CHARS}]+(?:[-\u2010\u2011][${WORD_CHARS}]+)*`, "gu");

/**
 * One word as it is compared: accents (on Latin letters), joiners, hyphens
 * and case removed. Combining marks of other scripts are kept, so
 * Devanagari vowel signs, for example, stay part of their word.
 */
function normalizeWord(raw) {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{M}\p{N}]/gu, "")
    .toLowerCase();
}

/** The compared words of some text, in order. */
function wordsOf(text) {
  const words = [];
  for (const match of String(text).matchAll(WORD_RUN)) {
    const word = normalizeWord(match[0]);
    if (word) words.push(word);
  }
  return words;
}

/**
 * Normalises text for comparison: one space between words, each word
 * lowercased and stripped of accents, apostrophes and hyphens ("Don't",
 * "state-of-the-art" -> "dont", "stateoftheart"). Other punctuation
 * separates words ("and/or" -> "and or").
 * @param {string} text
 * @returns {string}
 */
export function cleanWord(text) {
  return wordsOf(text).join(" ");
}

/**
 * Splits text with no whitespace (one whitespace-delimited part of the
 * manuscript) into its words and the punctuation between them, by the same
 * rule as tokenizeText, so both sides of a comparison see the same words.
 * Punctuation before the first word or after the last stays with that word.
 * @param {string} part
 * @returns {Array<{text: string, word: string}>} Pieces that join back into
 *   the part; word is the compared word, or "" for punctuation between words
 */
export function splitWords(part) {
  const text = String(part);
  const pieces = [];
  let last = 0;
  for (const match of text.matchAll(WORD_RUN)) {
    const word = normalizeWord(match[0]);
    if (!word) continue; // joiners alone: punctuation
    const before = text.slice(last, match.index);
    if (pieces.length === 0) pieces.push({ text: before + match[0], word });
    else {
      if (before) pieces.push({ text: before, word: "" });
      pieces.push({ text: match[0], word });
    }
    last = match.index + match[0].length;
  }
  if (pieces.length === 0) return [{ text, word: "" }];
  pieces[pieces.length - 1].text += text.slice(last);
  return pieces;
}

// Stored in cleaned form ("don't" -> "dont") so they match cleaned text
export const STOP_WORDS = new Set(
  [
    "a", "about", "above", "after", "again", "against", "ain", "al", "all",
    "am", "an", "and", "any", "are", "aren", "aren't", "as", "at", "be",
    "because", "been", "before", "being", "below", "between", "both", "but",
    "by", "can", "couldn", "couldn't", "d", "did", "didn", "didn't", "do",
    "does", "doesn", "doesn't", "doing", "don", "don't", "down", "during",
    "each", "et", "few", "for", "from", "further", "had", "hadn", "hadn't",
    "has", "hasn", "hasn't", "have", "haven", "haven't", "having", "he",
    "her", "here", "hers", "herself", "him", "himself", "his", "how", "i",
    "if", "in", "into", "is", "isn", "isn't", "it", "it's", "its", "itself",
    "just", "ll", "m", "ma", "me", "mightn", "mightn't", "more", "most",
    "mustn", "mustn't", "my", "myself", "needn", "needn't", "no", "nor",
    "not", "now", "o", "of", "off", "on", "once", "only", "or", "other",
    "our", "ours", "ourselves", "out", "over", "own", "re", "s", "same",
    "shan", "shan't", "she", "she's", "should", "should've", "shouldn",
    "shouldn't", "so", "some", "such", "t", "than", "that", "that'll", "the",
    "their", "theirs", "them", "themselves", "there", "these", "they", "this",
    "those", "through", "to", "too", "under", "until", "up", "ve", "very",
    "was", "wasn", "wasn't", "we", "were", "weren", "weren't", "what", "when",
    "where", "which", "while", "who", "whom", "why", "will", "with", "won",
    "won't", "wouldn", "wouldn't", "y", "you", "you'd", "you'll", "you're",
    "you've", "your", "yours", "yourself", "yourselves",
  ].map(cleanWord)
);

/**
 * Splits raw source text into cleaned words.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeText(text) {
  // Join words split by a line-break hyphen ("exam-\nple" -> "example")
  return wordsOf(String(text).replace(/(\p{L})-\s+(\p{L})/gu, "$1$2"));
}

/**
 * Cuts the manuscript into overlapping windows. Each window keeps its
 * distinct words and, for each, the ids of every occurrence in the window,
 * so a repeated word ("by the middle of the century") is flagged each time.
 * A manuscript shorter than one window becomes a single window.
 * @param {Array<{id: number, content: string}>} words
 * @param {number} size
 * @returns {Array<{contents: string[], ids: number[][]}>}
 */
export function createDocxWindows(words, size = DEFAULT_SETTINGS.docxWindow) {
  if (words.length === 0) return [];
  const windows = [];
  const last = Math.max(0, words.length - size);

  for (let start = 0; start <= last; start++) {
    const slot = new Map(); // content -> index in contents
    const contents = [];
    const ids = [];
    const end = Math.min(start + size, words.length);
    for (let i = start; i < end; i++) {
      const { id, content } = words[i];
      const at = slot.get(content);
      if (at === undefined) {
        slot.set(content, contents.length);
        contents.push(content);
        ids.push([id]);
      } else {
        ids[at].push(id);
      }
    }
    windows.push({ contents, ids });
  }
  return windows;
}

/**
 * Builds an index from each word to the manuscript windows that contain it.
 * @param {Array<{contents: string[]}>} windows
 * @returns {Map<string, number[]>}
 */
export function buildWindowIndex(windows) {
  const index = new Map();
  windows.forEach((window, w) => {
    for (const term of window.contents) {
      let postings = index.get(term);
      if (!postings) {
        postings = [];
        index.set(term, postings);
      }
      postings.push(w);
    }
  });
  return index;
}

/**
 * Slides a window over every position of the source text and collects the
 * ids of manuscript words in any manuscript window sharing at least
 * `threshold` distinct words with it.
 *
 * Overlap counts are updated incrementally: when the source window moves by
 * one word, only the manuscript windows containing the word that left or the
 * word that entered change. Every position is checked; nothing is sampled.
 *
 * @param {Array<{contents: string[], ids: number[][]}>} windows
 * @param {Map<string, number[]>} index - From buildWindowIndex
 * @param {string[]} sourceWords - Cleaned source words
 * @param {number} windowSize - Source window size
 * @param {number} threshold - Minimum number of shared distinct words
 * @returns {number[]} Distinct manuscript word ids that matched
 */
export function findWindowMatches(
  windows,
  index,
  sourceWords,
  windowSize = DEFAULT_SETTINGS.pdfWindow,
  threshold = DEFAULT_SETTINGS.windowMatch
) {
  const overlap = new Int32Array(windows.length);
  const inWindow = new Map(); // source word -> occurrences in current window
  const active = new Set(); // manuscript windows at or above the threshold
  const matched = new Set();

  const add = (word) => {
    const count = inWindow.get(word) || 0;
    inWindow.set(word, count + 1);
    if (count > 0) return; // repeated word, already counted
    const postings = index.get(word);
    if (!postings) return;
    for (const w of postings) {
      if (++overlap[w] === threshold) active.add(w);
    }
  };

  const remove = (word) => {
    const count = inWindow.get(word);
    if (count > 1) {
      inWindow.set(word, count - 1);
      return;
    }
    inWindow.delete(word);
    const postings = index.get(word);
    if (!postings) return;
    for (const w of postings) {
      if (overlap[w]-- === threshold) active.delete(w);
    }
  };

  // Flag the manuscript words the current source window actually shares
  const collect = () => {
    for (const w of active) {
      const { contents, ids } = windows[w];
      for (let i = 0; i < contents.length; i++) {
        if (inWindow.has(contents[i])) for (const id of ids[i]) matched.add(id);
      }
    }
  };

  const firstEnd = Math.min(windowSize, sourceWords.length);
  for (let i = 0; i < firstEnd; i++) add(sourceWords[i]);
  collect();

  for (let i = windowSize; i < sourceWords.length; i++) {
    remove(sourceWords[i - windowSize]);
    add(sourceWords[i]);
    collect();
  }

  return Array.from(matched);
}

/**
 * Like findWindowMatches, but also records, for every flagged manuscript
 * word, the best matching source window: the one sharing the most distinct
 * words (earliest on a tie). Positions are source word offsets, so they can
 * be turned into page numbers and excerpts without re-reading the PDF.
 * @returns {{ids: number[], positions: Map<number, {sourceStart: number, shared: number}>}}
 */
export function findWindowMatchesWithPositions(
  windows,
  index,
  sourceWords,
  windowSize = DEFAULT_SETTINGS.pdfWindow,
  threshold = DEFAULT_SETTINGS.windowMatch
) {
  const overlap = new Int32Array(windows.length);
  const inWindow = new Map();
  const active = new Set();
  const matched = new Set();
  const positions = new Map();

  const add = (word) => {
    const count = inWindow.get(word) || 0;
    inWindow.set(word, count + 1);
    if (count > 0) return;
    const postings = index.get(word);
    if (!postings) return;
    for (const w of postings) {
      if (++overlap[w] === threshold) active.add(w);
    }
  };

  const remove = (word) => {
    const count = inWindow.get(word);
    if (count > 1) {
      inWindow.set(word, count - 1);
      return;
    }
    inWindow.delete(word);
    const postings = index.get(word);
    if (!postings) return;
    for (const w of postings) {
      if (overlap[w]-- === threshold) active.delete(w);
    }
  };

  const collect = (sourceStart) => {
    for (const w of active) {
      const shared = overlap[w];
      const { contents, ids } = windows[w];
      for (let i = 0; i < contents.length; i++) {
        if (!inWindow.has(contents[i])) continue;
        for (const id of ids[i]) {
          matched.add(id);
          const current = positions.get(id);
          if (
            !current ||
            shared > current.shared ||
            (shared === current.shared && sourceStart < current.sourceStart)
          ) {
            positions.set(id, { sourceStart, shared });
          }
        }
      }
    }
  };

  const firstEnd = Math.min(windowSize, sourceWords.length);
  for (let i = 0; i < firstEnd; i++) add(sourceWords[i]);
  collect(0);

  for (let i = windowSize; i < sourceWords.length; i++) {
    remove(sourceWords[i - windowSize]);
    add(sourceWords[i]);
    collect(i - windowSize + 1);
  }

  return { ids: Array.from(matched), positions };
}

/**
 * First source position (original word offset) of each wanted trigram.
 * Stop words are removed exactly as in buildTrigramSet, but each kept word
 * remembers its offset in the unfiltered source word list.
 * @param {string[]} sourceWords
 * @param {Iterable<string>} trigramTexts
 * @returns {Map<string, number>}
 */
export function findTrigramPositions(sourceWords, trigramTexts) {
  const wanted = new Set(trigramTexts);
  const found = new Map();
  if (wanted.size === 0) return found;
  const content = [];
  sourceWords.forEach((word, offset) => {
    if (!STOP_WORDS.has(word)) content.push({ word, offset });
  });
  for (let i = 0; i + 2 < content.length && found.size < wanted.size; i++) {
    const text = `${content[i].word} ${content[i + 1].word} ${content[i + 2].word}`;
    if (wanted.has(text) && !found.has(text)) found.set(text, content[i].offset);
  }
  return found;
}

/**
 * Builds the manuscript's trigrams (stop words removed). Every occurrence of a
 * repeated trigram is kept, so all copies can be highlighted.
 * @param {Array<{id: number, content: string}>} words
 * @returns {Map<string, number[]>} trigram text -> distinct word ids
 */
export function buildDocxTrigrams(words) {
  const content = words.filter((w) => !STOP_WORDS.has(w.content));
  const trigrams = new Map();

  for (let i = 0; i + 2 < content.length; i++) {
    const text = `${content[i].content} ${content[i + 1].content} ${content[i + 2].content}`;
    let ids = trigrams.get(text);
    if (!ids) {
      ids = new Set();
      trigrams.set(text, ids);
    }
    ids.add(content[i].id).add(content[i + 1].id).add(content[i + 2].id);
  }

  const result = new Map();
  for (const [text, ids] of trigrams) result.set(text, Array.from(ids));
  return result;
}

/**
 * Builds the set of a source's trigrams (stop words removed).
 * @param {string[]} sourceWords
 * @returns {Set<string>}
 */
export function buildTrigramSet(sourceWords) {
  const content = sourceWords.filter((w) => !STOP_WORDS.has(w));
  const set = new Set();
  for (let i = 0; i + 2 < content.length; i++) {
    set.add(`${content[i]} ${content[i + 1]} ${content[i + 2]}`);
  }
  return set;
}

/**
 * Lists the manuscript trigrams a source shares, or none when it shares
 * fewer than `threshold` of them.
 * @param {Iterable<string>} docxTrigramTexts
 * @param {Set<string>} sourceTrigrams
 * @param {number} threshold
 * @returns {string[]}
 */
export function findSharedTrigrams(
  docxTrigramTexts,
  sourceTrigrams,
  threshold = DEFAULT_SETTINGS.phraseGate
) {
  const shared = [];
  for (const text of docxTrigramTexts) {
    if (sourceTrigrams.has(text)) shared.push(text);
  }
  return shared.length >= threshold ? shared : [];
}

/**
 * Combines both signals into one set of flagged word ids per source.
 * By default a shared trigram adds its words only when exactly one source
 * has it, so phrasing common to the field is not credited to every source.
 * @param {Array<{windowIds: number[], sharedTrigrams: string[]}>} results
 * @param {Map<string, number[]>} docxTrigrams - From buildDocxTrigrams
 * @param {{uniqueOnly?: boolean}} options - false credits every shared trigram
 * @returns {Array<Set<number>>}
 */
export function combineMatches(results, docxTrigrams, { uniqueOnly = true } = {}) {
  const frequency = new Map();
  for (const result of results) {
    for (const text of new Set(result.sharedTrigrams)) {
      frequency.set(text, (frequency.get(text) || 0) + 1);
    }
  }

  return results.map((result) => {
    const ids = new Set(result.windowIds);
    for (const text of result.sharedTrigrams) {
      if (uniqueOnly && frequency.get(text) !== 1) continue;
      for (const id of docxTrigrams.get(text) || []) ids.add(id);
    }
    return ids;
  });
}

/**
 * Everything after the per-source matching, for a given set of settings:
 * combine both signals, then optionally drop lone stop words.
 * @param {Array<{windowIds: number[], sharedTrigrams: string[]}>} results
 * @param {Map<string, number[]>} docxTrigrams
 * @param {Array<{content: string}>} words - Manuscript words, indexed by id
 * @param {typeof DEFAULT_SETTINGS} settings
 * @returns {Array<Set<number>>}
 */
export function finalizeMatches(results, docxTrigrams, words, settings) {
  const combined = combineMatches(
    settings.phrases ? results : results.map((r) => ({ ...r, sharedTrigrams: [] })),
    docxTrigrams,
    { uniqueOnly: settings.phrasesUniqueOnly }
  );
  const dropped = settings.dropLoneStopWords
    ? combined.map((ids) => dropStrayStopWords(ids, words))
    : combined;
  const excluded = getExcludedWordIds(words, settings);
  if (excluded.size === 0) return dropped;
  return dropped.map((ids) => new Set(Array.from(ids).filter((id) => !excluded.has(id))));
}

/**
 * Removes flagged stop words with no flagged neighbour. A window match marks
 * every shared word, so a lone "the" or "of" next to a copied passage can be
 * swept in; inside a passage its neighbours keep it.
 * @param {Set<number>} ids - Flagged word ids for one source
 * @param {Array<{content: string}>} words - Manuscript words, indexed by id
 * @returns {Set<number>}
 */
export function dropStrayStopWords(ids, words) {
  const kept = new Set();
  for (const id of ids) {
    const isStray =
      STOP_WORDS.has(words[id].content) && !ids.has(id - 1) && !ids.has(id + 1);
    if (!isStray) kept.add(id);
  }
  return kept;
}

/**
 * Works out what to show for the current on/off state of the sources.
 * Sources are in priority order: a word found in several enabled sources is
 * attributed to the first of them.
 * @param {Array<Set<number>>} sourceIds
 * @param {boolean[]} enabled
 * @param {number} totalWords
 * @returns {{
 *   primary: Map<number, number>,
 *   flaggedWords: number,
 *   overallPercent: number,
 *   sourcePercent: Array<number|null>,
 *   attributedPercent: number[],
 * }}
 */
export function summarize(sourceIds, enabled, totalWords) {
  const primary = new Map();
  sourceIds.forEach((ids, s) => {
    if (!enabled[s]) return;
    for (const id of ids) {
      if (!primary.has(id)) primary.set(id, s);
    }
  });

  const attributed = new Array(sourceIds.length).fill(0);
  for (const s of primary.values()) attributed[s]++;

  const percent = (count) => (totalWords ? (count / totalWords) * 100 : 0);
  return {
    primary,
    flaggedWords: primary.size,
    overallPercent: percent(primary.size),
    sourcePercent: sourceIds.map((ids, s) => (enabled[s] ? percent(ids.size) : null)),
    attributedPercent: attributed.map(percent),
  };
}

/**
 * Names the level for an overall percentage.
 * @param {number} percent
 * @param {{moderateFrom: number, highFrom: number}} settings
 * @returns {"low"|"moderate"|"high"}
 */
export function similarityLevel(percent, settings = DEFAULT_SETTINGS) {
  if (percent < settings.moderateFrom) return "low";
  if (percent < settings.highFrom) return "moderate";
  return "high";
}
