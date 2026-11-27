/**
 * Rebuilds a PDF page's text from the items PDF.js returns. Pure function
 * with no DOM or PDF.js access, so it can be tested in Node.
 *
 * Text items don't line up with words: a font change splits a word into
 * two items ("Hel" + bold "lo"), and so does a large first letter ("T" +
 * "he"). PDF.js already adds its own space items where words are apart on
 * the page and marks the end of each line (hasEOL), which is how its own
 * search rebuilds page text. So items are joined as they are, with a line
 * break after each line, and a space is added only where the layout shows
 * two items are not one word:
 *  - raised or lowered text, such as a footnote marker ("climate²"), and
 *  - text that starts back over the previous item (text drawn twice to
 *    look bold, or out of order), or well after it.
 */

// Measured against the larger font size of the two items
const BASELINE_SHIFT = 0.2; // a baseline this far off is a superscript or subscript
const OVERLAP = 0.25; // starting this far back over the previous item is a new run
const GAP = 0.3; // a gap this wide that PDF.js didn't mark is still a space

const isHorizontal = (item) =>
  Array.isArray(item.transform) &&
  item.transform[1] === 0 &&
  item.transform[2] === 0 &&
  (item.dir === undefined || item.dir === "ltr");

/**
 * Whether two touching items on one line are separate words, judged from
 * their position, size and baseline. Rotated, vertical and right-to-left
 * text is left as PDF.js returned it.
 * @param {{transform: number[], width: number, height: number}} before
 * @param {{transform: number[], width: number, height: number}} after
 */
export function separatedOnPage(before, after) {
  if (!isHorizontal(before) || !isHorizontal(after)) return false;
  if (!Number.isFinite(before.width)) return false;
  const size = Math.max(before.height || 0, after.height || 0, 1);
  const baselineShift = Math.abs(after.transform[5] - before.transform[5]);
  if (baselineShift > BASELINE_SHIFT * size) return true;
  const gap = after.transform[4] - (before.transform[4] + before.width);
  return gap < -OVERLAP * size || gap > GAP * size;
}

/**
 * Joins one page's text items into its text: items in order, a line break
 * after each line, and a space between two touching items only where
 * separatedOnPage says they are not one word.
 * @param {Array<{str?: string, hasEOL?: boolean, transform?: number[],
 *   width?: number, height?: number, dir?: string}>} items - From
 *   page.getTextContent(); marked-content items (no str) are skipped
 * @returns {string}
 */
export function joinTextItems(items = []) {
  let text = "";
  let previous = null; // last item that added visible text
  let broken = true; // whether whitespace or a line end came since then

  for (const item of items) {
    const str = typeof item?.str === "string" ? item.str : "";
    if (/\S/.test(str)) {
      if (!broken && !/^\s/.test(str) && previous && separatedOnPage(previous, item)) {
        text += " ";
      }
      text += str;
      previous = item;
      broken = /\s$/.test(str);
    } else if (str) {
      text += str; // a space item PDF.js added between words
      broken = true;
    }
    if (item?.hasEOL) {
      text += "\n";
      broken = true;
    }
  }
  return text;
}
