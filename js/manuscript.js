import {
  cleanWord,
  continuesQuotation,
  findQuotedParts,
  referenceBlockFlags,
  splitWords,
} from "./matching.js";

// Elements that hold a run of text: the paragraphs that reference-list and
// quotation detection work on
const BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p, li";

/**
 * Converts a DOCX file to sanitised HTML with Mammoth.
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function docxToHtml(file) {
  const buffer = await file.arrayBuffer();
  const { value } = await window.mammoth.convertToHtml({ arrayBuffer: buffer });
  return value;
}

/**
 * Builds the readable manuscript and its word list from Mammoth HTML.
 * Every word becomes a <span class="w" data-i="id">, so highlights can be
 * switched on and off without rebuilding the document. Whitespace between
 * two words in the same run becomes a <span class="gap"> so a highlight can
 * bridge it when both neighbours belong to the same source.
 *
 * @param {string} html
 * @returns {{
 *   root: HTMLElement,
 *   words: Array<{id: number, content: string}>,
 *   spans: HTMLElement[],
 *   gaps: Array<{el: HTMLElement, left: number, right: number}>,
 * }}
 */
export function buildManuscript(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  sanitize(doc.body);

  const root = document.createElement("div");
  root.className = "manuscript-body";
  root.append(...Array.from(doc.body.childNodes, (node) => document.importNode(node, true)));

  // Reference lists: a References/Bibliography/... heading whose entries
  // read as citations (see referenceBlockFlags in matching.js). Words keep
  // the flag so the score can honour the setting without a re-read.
  const blockElements = Array.from(root.querySelectorAll(BLOCK_SELECTOR));
  const blockIndex = new Map(blockElements.map((el, i) => [el, i]));
  const referenceFlags = referenceBlockFlags(describeBlocks(root, blockElements, blockIndex));

  const words = [];
  const spans = [];
  const gaps = [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  let pendingGap = null; // whitespace after a word, waiting for the next word (may cross nodes)
  let afterWord = false; // whether the previous emitted token was a word
  let inReferenceList = false; // whether the current block is part of a reference list

  // Quotation marks are matched within each paragraph (findQuotedParts in
  // matching.js), so an unmatched mark never hides text past its paragraph.
  // Each paragraph's text is collected piece by piece, with the word id each
  // piece became, and flagged once the paragraph is complete.
  let paragraph = { block: undefined, pieces: [], ids: [] };
  let unclosedBefore = []; // word ids the previous paragraph left inside an open quotation
  const finishParagraph = () => {
    const { pieces, ids } = paragraph;
    paragraph = { block: undefined, pieces: [], ids: [] };
    const text = pieces.join("");
    if (!/\S/.test(text)) return; // an empty paragraph doesn't end a running quotation
    // A quotation over several paragraphs reopens on each one
    if (continuesQuotation(text)) for (const id of unclosedBefore) words[id].inQuotedText = true;
    unclosedBefore = [];
    const { quoted, unclosed } = findQuotedParts(pieces);
    ids.forEach((id, i) => {
      if (id === null) return;
      if (quoted[i]) words[id].inQuotedText = true;
      else if (unclosed[i]) unclosedBefore.push(id);
    });
  };
  const addPiece = (text, id = null) => {
    paragraph.pieces.push(text);
    paragraph.ids.push(id);
  };

  for (const node of textNodes) {
    // Text outside any block belongs to the block before it
    const block = blockIndex.get(node.parentElement?.closest(BLOCK_SELECTOR));
    if (block !== undefined) {
      inReferenceList = referenceFlags[block];
      if (block !== paragraph.block) {
        finishParagraph();
        paragraph.block = block;
      }
    }
    let inQuotedBlock = false;
    for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
      if (el.tagName === "BLOCKQUOTE" || el.tagName === "Q") inQuotedBlock = true;
    }
    const fragment = document.createDocumentFragment();

    for (const part of node.data.split(/(\s+)/)) {
      if (!part) continue;

      if (/^\s+$/.test(part)) {
        addPiece(part);
        if (pendingGap) {
          pendingGap.el.textContent += part;
        } else if (afterWord) {
          const el = document.createElement("span");
          el.className = "gap";
          el.textContent = part;
          el.dataset.left = words.length - 1;
          pendingGap = { el, left: words.length - 1 };
          fragment.append(el);
        } else {
          fragment.append(part);
        }
        afterWord = false;
        continue;
      }

      const pieces = splitWords(part);
      if (!pieces.some((piece) => piece.word)) {
        addPiece(part); // punctuation only, but it may hold a quotation mark
        pendingGap = null;
        afterWord = false;
        fragment.append(part);
        continue;
      }

      // A part can hold several words ("flood—which", "and/or"), split
      // exactly as source text is: each word gets its own span, and the
      // punctuation between two words a gap, so one passage can bridge it
      for (const { text, word } of pieces) {
        if (!word) {
          addPiece(text);
          const el = document.createElement("span");
          el.className = "gap";
          el.textContent = text;
          el.dataset.left = words.length - 1;
          pendingGap = { el, left: words.length - 1 };
          fragment.append(el);
          continue;
        }

        const id = words.length;
        addPiece(text, id);
        const span = document.createElement("span");
        span.className = "w";
        span.dataset.i = id;
        span.textContent = text;
        // Quotation marks add inQuotedText when the paragraph is finished
        words.push({
          id,
          content: word,
          ...(inReferenceList ? { inReferenceList: true } : {}),
          ...(inQuotedBlock ? { inQuotedText: true } : {}),
        });
        spans.push(span);
        fragment.append(span);

        if (pendingGap) {
          gaps.push({ ...pendingGap, right: id });
          pendingGap = null;
        }
      }
      afterWord = true;
    }
    node.replaceWith(fragment);
  }
  finishParagraph();

  return { root, words, spans, gaps };
}

/** Whether every letter and digit of a paragraph is inside bold markup. */
function isBoldParagraph(el) {
  const boldText = Array.from(el.querySelectorAll("strong, b"))
    .map((node) => cleanWord(node.textContent))
    .join(" ")
    .replace(/\s+/g, "");
  return Boolean(boldText) && boldText === cleanWord(el.textContent).replace(/\s+/g, "");
}

/**
 * Describes each block for reference-list detection: its own text (text in
 * a nested block, such as a list inside a list item, belongs to the nested
 * one), split into lines at <br>, so a list typed as one paragraph with a
 * line break after each entry is read entry by entry.
 * @param {HTMLElement} root
 * @param {HTMLElement[]} elements - Blocks in document order
 * @param {Map<HTMLElement, number>} blockIndex - Element -> position in elements
 */
function describeBlocks(root, elements, blockIndex) {
  const lines = elements.map(() => [""]);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const isText = node.nodeType === Node.TEXT_NODE;
    if (!isText && node.tagName !== "BR") continue;
    const at = blockIndex.get(node.parentElement?.closest(BLOCK_SELECTOR));
    if (at === undefined) continue;
    if (isText) lines[at][lines[at].length - 1] += node.data;
    else lines[at].push("");
  }
  return elements.map((el, i) => ({
    tagName: el.tagName,
    text: lines[i].join(" "),
    lines: lines[i],
    bold: el.tagName === "P" && isBoldParagraph(el),
  }));
}

// Mammoth emits plain markup, but links come from the file, so strip
// anything that could run script.
function sanitize(body) {
  for (const el of body.querySelectorAll("script, style, iframe, object, embed")) {
    el.remove();
  }
  for (const el of body.querySelectorAll("*")) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim().toLowerCase();
      if (
        name.startsWith("on") ||
        name === "style" ||
        name === "srcset" ||
        name === "formaction" ||
        name === "xlink:href"
      ) {
        el.removeAttribute(attr.name);
      } else if (name === "src" && !/^(data:|blob:)/.test(value)) {
        // Linked (remote) images would fetch from the network; embedded ones stay
        el.removeAttribute(attr.name);
      } else if (name === "href" && !/^(https?:|mailto:|#)/.test(value)) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  }
}
