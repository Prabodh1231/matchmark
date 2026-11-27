import {
  cleanWord,
  quoteFlagForPart,
  referenceBlockFlags,
} from "./matching.js";

// Elements that hold a run of text: what reference-list detection looks at
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
  const quoteState = { open: false }; // inside “…” / "…" quotation marks

  for (const node of textNodes) {
    // Text outside any block keeps the flag of the block before it
    const block = blockIndex.get(node.parentElement?.closest(BLOCK_SELECTOR));
    if (block !== undefined) inReferenceList = referenceFlags[block];
    let inQuotedBlock = false;
    for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
      if (el.tagName === "BLOCKQUOTE" || el.tagName === "Q") inQuotedBlock = true;
    }
    const fragment = document.createDocumentFragment();

    for (const part of node.data.split(/(\s+)/)) {
      if (!part) continue;

      if (/^\s+$/.test(part)) {
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

      const quotedByMarks = quoteFlagForPart(part, quoteState);
      const content = cleanWord(part);
      if (!/[\p{L}\p{N}]/u.test(content)) {
        pendingGap = null;
        afterWord = false;
        fragment.append(part);
        continue;
      }

      const id = words.length;
      const span = document.createElement("span");
      span.className = "w";
      span.dataset.i = id;
      span.textContent = part;
      words.push({
        id,
        content,
        ...(inReferenceList ? { inReferenceList: true } : {}),
        ...(inQuotedBlock || quotedByMarks ? { inQuotedText: true } : {}),
      });
      spans.push(span);
      fragment.append(span);
      afterWord = true;

      if (pendingGap) {
        gaps.push({ ...pendingGap, right: id });
        pendingGap = null;
      }
    }
    node.replaceWith(fragment);
  }

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
