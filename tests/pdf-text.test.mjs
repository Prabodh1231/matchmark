import { test } from "node:test";
import assert from "node:assert/strict";
import { joinTextItems, separatedOnPage } from "../js/pdf-text.js";
import { tokenizeText } from "../js/matching.js";

// A horizontal text item as PDF.js returns it (positions in PDF points)
const item = (str, x, y, width, height = 12, extra = {}) => ({
  str,
  transform: [height, 0, 0, height, x, y],
  width,
  height,
  dir: "ltr",
  hasEOL: false,
  ...extra,
});
// The space item PDF.js adds between words placed apart
const space = (x, y, width) => item(" ", x, y, width, 0);

// Items below are the ones PDF.js 4.6 returned for small test PDFs

test("a word split by a font change stays one word", () => {
  const items = [item("Hel", 72, 700, 18), item("lo world", 90, 700, 46)];
  assert.equal(joinTextItems(items), "Hello world");
});

test("a large first letter or small capitals on one baseline stay one word", () => {
  const items = [item("T", 72, 700, 11, 18), item("he harbour", 83, 700, 58)];
  assert.equal(joinTextItems(items), "The harbour");
});

test("spaces PDF.js adds between words and columns are kept, once", () => {
  assert.equal(
    joinTextItems([item("coastal", 72, 700, 38), space(110, 700, 12), item("flooding", 122, 700, 42)]),
    "coastal flooding"
  );
  assert.equal(
    joinTextItems([item("left", 72, 700, 16), space(88, 700, 284), item("right", 372, 700, 23)]),
    "left right"
  );
});

test("each line ends with a line break, so a line-end hyphen still joins its word", () => {
  const lines = [item("first line", 72, 700, 41, 12, { hasEOL: true }), item("second line", 72, 686, 61)];
  assert.equal(joinTextItems(lines), "first line\nsecond line");
  const hyphen = [item("exam-", 72, 700, 33, 12, { hasEOL: true }), item("ple continues", 72, 686, 71)];
  assert.deepEqual(tokenizeText(joinTextItems(hyphen)), ["example", "continues"]);
  // PDF.js also sends empty items that only mark a line end
  assert.equal(joinTextItems([item("one", 72, 700, 20), item("", 92, 700, 0, 0, { hasEOL: true }), item("two", 72, 686, 20)]), "one\ntwo");
});

test("a raised footnote marker does not glue onto its word", () => {
  const items = [item("climate", 72, 700, 38), item("2", 110, 705, 4, 7), space(114, 705, 3), item("change", 117, 700, 39)];
  assert.equal(joinTextItems(items), "climate 2 change");
  assert.deepEqual(tokenizeText(joinTextItems(items)), ["climate", "2", "change"]);
});

test("text drawn twice, or a wide gap PDF.js left unmarked, is separated", () => {
  // Fake bold: the same word drawn again 0.3 pt to the right
  assert.equal(joinTextItems([item("Hello", 72, 700, 28), item("Hello", 72.3, 700, 28)]), "Hello Hello");
  assert.equal(joinTextItems([item("coastal", 72, 700, 38), item("flooding", 118, 700, 42)]), "coastal flooding");
});

test("rotated and right-to-left text is joined as PDF.js returned it", () => {
  const rotated = (str, x, y) => ({ str, transform: [0, 12, -12, 0, x, y], width: 20, height: 12, dir: "ltr" });
  assert.equal(joinTextItems([rotated("Hel", 72, 700), rotated("lo", 72, 900)]), "Hello");
  assert.ok(!separatedOnPage(item("a", 72, 700, 6, 12, { dir: "rtl" }), item("b", 10, 700, 6, 12, { dir: "rtl" })));
});

test("marked-content items and missing fields are skipped safely", () => {
  assert.equal(joinTextItems([{ type: "beginMarkedContent" }, item("text", 72, 700, 20), { type: "endMarkedContent" }]), "text");
  assert.equal(joinTextItems([]), "");
  assert.equal(joinTextItems([{ str: "no" }, { str: "position" }]), "noposition");
});
