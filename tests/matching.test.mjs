import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  isDefaultSettings,
  finalizeMatches,
  cleanWord,
  splitWords,
  tokenizeText,
  createDocxWindows,
  buildWindowIndex,
  findWindowMatches,
  buildDocxTrigrams,
  buildTrigramSet,
  findSharedTrigrams,
  combineMatches,
  dropStrayStopWords,
  summarize,
  similarityLevel,
  isReferenceHeadingText,
  isReferenceHeadingBlock,
  isHeadingLikeBlock,
  looksLikeCitation,
  findReferenceSections,
  referenceBlockFlags,
  markQuotedParts,
  findQuotedParts,
  continuesQuotation,
  exclusionSummary,
  findWindowMatchesWithPositions,
  findTrigramPositions,
  STOP_WORDS,
} from "../js/matching.js";

const toWords = (text) => tokenizeText(text).map((content, id) => ({ id, content }));

// Reference: compare every source window with every manuscript window
function bruteForceMatches(windows, sourceWords, windowSize, threshold) {
  const matched = new Set();
  const starts = Math.max(1, sourceWords.length - windowSize + 1);
  for (let s = 0; s < starts; s++) {
    const sourceSet = new Set(sourceWords.slice(s, s + windowSize));
    for (const { contents, ids } of windows) {
      const shared = contents.filter((c) => sourceSet.has(c)).length;
      if (shared >= threshold) {
        contents.forEach((c, i) => sourceSet.has(c) && ids[i].forEach((id) => matched.add(id)));
      }
    }
  }
  return matched;
}

// Small deterministic PRNG so failures are reproducible
function rng(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

test("cleanWord strips accents, punctuation and case", () => {
  assert.equal(cleanWord("  Café, Naïve—RÉSUMÉ!\n"), "cafe naive resume");
  assert.equal(cleanWord("line\nbreak\ttab"), "line break tab");
  assert.equal(cleanWord("—"), "");
});

test("punctuation between words separates them; apostrophes and hyphens join", () => {
  // Dashes, slashes and stops separate, with or without spaces around them
  assert.equal(cleanWord("the flood—which nobody predicted"), "the flood which nobody predicted");
  assert.equal(cleanWord("and/or"), "and or");
  assert.equal(cleanWord("1990–2010"), "1990 2010");
  assert.equal(cleanWord("e.g. this"), "e g this");
  // Apostrophes, hyphens inside a word, the soft hyphen and joiners hold it together
  assert.equal(cleanWord("Don't don’t O’Brien’s ‘90s"), "dont dont obriens 90s");
  assert.equal(cleanWord("state-of-the-art rock-'n'-roll"), "stateoftheart rocknroll");
  assert.equal(cleanWord("hyphen­ation"), "hyphenation");
  // A hyphen with nothing on one side is punctuation
  assert.equal(cleanWord("pre- and post-war -5"), "pre and postwar 5");
  // Combining marks of other scripts stay in their word
  assert.equal(cleanWord("हिन्दी भाषा"), "हिन्दी भाषा");
});

test("ligatures and other compatibility forms read as their plain letters", () => {
  assert.equal(cleanWord("ﬁnancial ﬂows through the oﬃce buﬀer"), "financial flows through the office buffer");
  assert.deepEqual(tokenizeText("Scientiﬁc ﬁndings"), tokenizeText("Scientific findings"));
  assert.equal(cleanWord("ＦＵＬＬ width"), "full width");
  // Accents are still stripped after unfolding
  assert.equal(cleanWord("Naïve ﬁancée"), "naive fiancee");
  // The modifier-letter apostrophe joins like any other apostrophe
  assert.equal(cleanWord("donʼt"), "dont");
  for (const part of ["ﬁnancial,", "“oﬃce—buﬀer”", "donʼt"]) {
    assert.deepEqual(splitWords(part).filter((piece) => piece.word).map((piece) => piece.word), tokenizeText(part), part);
  }
});

test("a draft with ligatures matches a source without them", () => {
  const manuscript = toWords("Mangrove restoration is a low cost buﬀer that also supports ﬁsheries and stores carbon");
  const windows = createDocxWindows(manuscript);
  const source = tokenizeText("Mangrove restoration is a low cost buffer that also supports fisheries and stores carbon");
  const ids = new Set(findWindowMatches(windows, buildWindowIndex(windows), source));
  for (const word of ["buffer", "fisheries"]) {
    assert.ok(ids.has(manuscript.find((w) => w.content === word).id), word);
  }
});

test("source text splits on dashes and slashes as spaced text does", () => {
  const glued = tokenizeText("The flood—which nobody predicted—and/or the storm");
  assert.deepEqual(glued, ["the", "flood", "which", "nobody", "predicted", "and", "or", "the", "storm"]);
  assert.deepEqual(tokenizeText("The flood — which nobody predicted — and / or the storm"), glued);
  // A line-break hyphen still joins the halves of a word
  assert.deepEqual(tokenizeText("exam-\nple"), ["example"]);
});

test("splitWords splits a manuscript part into words exactly as tokenizeText does", () => {
  assert.deepEqual(splitWords("“flood—which,”"), [
    { text: "“flood", word: "flood" },
    { text: "—", word: "" },
    { text: "which,”", word: "which" },
  ]);
  assert.deepEqual(splitWords("don’t"), [{ text: "don’t", word: "dont" }]);
  assert.deepEqual(splitWords("—"), [{ text: "—", word: "" }]);
  // Pieces join back into the part, and their words are the part's tokens
  for (const part of ["(see—p.", "and/or", "“It’s", "state-of-the-art,", "1990–2010.", "a--b", "‘’", "x-'y'-z", "Naïve—RÉSUMÉ!"]) {
    const pieces = splitWords(part);
    assert.equal(pieces.map((piece) => piece.text).join(""), part, part);
    assert.deepEqual(pieces.filter((piece) => piece.word).map((piece) => piece.word), tokenizeText(part), part);
  }
});

test("stop words are stored in cleaned form", () => {
  assert.ok(STOP_WORDS.has("dont"));
  assert.ok(STOP_WORDS.has("the"));
  assert.ok(!STOP_WORDS.has("don't"));
});

test("windows keep distinct words and every occurrence's id", () => {
  const words = toWords("a b a c d");
  const [only] = createDocxWindows(words, 13);
  assert.deepEqual(only, { contents: ["a", "b", "c", "d"], ids: [[0, 2], [1], [3], [4]] });
  assert.equal(createDocxWindows(toWords("w ".repeat(20)), 13).length, 8);
  assert.deepEqual(createDocxWindows([], 13), []);
});

test("indexed matcher equals brute force on random text", () => {
  const random = rng(42);
  const vocab = Array.from({ length: 40 }, (_, i) => `w${i}`);
  const pick = () => vocab[Math.floor(random() * vocab.length)];

  for (let round = 0; round < 60; round++) {
    const docx = Array.from({ length: 30 + Math.floor(random() * 200) }, pick);
    const source = Array.from({ length: 5 + Math.floor(random() * 300) }, pick);
    // Paste some manuscript passages into the source
    for (let k = 0; k < 3; k++) {
      const from = Math.floor(random() * docx.length);
      const to = Math.floor(random() * source.length);
      source.splice(to, 0, ...docx.slice(from, from + 5 + Math.floor(random() * 20)));
    }
    const windowSize = 8 + Math.floor(random() * 8);
    const threshold = 3 + Math.floor(random() * 6);

    const words = docx.map((content, id) => ({ id, content }));
    const windows = createDocxWindows(words, 13);
    const fast = new Set(
      findWindowMatches(windows, buildWindowIndex(windows), source, windowSize, threshold)
    );
    const slow = bruteForceMatches(windows, source, windowSize, threshold);
    assert.deepEqual([...fast].sort((a, b) => a - b), [...slow].sort((a, b) => a - b),
      `round ${round}`);
  }
});

test("a copied sentence deep inside a 100k-word source is found", () => {
  const random = rng(7);
  const filler = () => `filler${Math.floor(random() * 5000)}`;
  const sentence =
    "rising sea levels now pose a serious threat to coastal infrastructure worldwide";
  const manuscript = toWords(
    `an introduction that is entirely original prose ${sentence} followed by more original prose here`
  );

  const source = Array.from({ length: 100_000 }, filler);
  source.splice(73_219, 0, ...tokenizeText(sentence));

  const windows = createDocxWindows(manuscript);
  const ids = findWindowMatches(windows, buildWindowIndex(windows), source);
  const flagged = ids.map((id) => manuscript[id].content);
  for (const word of tokenizeText(sentence)) assert.ok(flagged.includes(word), word);
  assert.ok(!flagged.includes("introduction"));
});

test("a passage copied twice in the manuscript is flagged both times", () => {
  const passage = "the quick brown fox jumps over the lazy sleeping dog near the riverbank today";
  const manuscript = toWords(`${passage} some unrelated words sit between both copies ${passage}`);
  const windows = createDocxWindows(manuscript);
  const ids = new Set(findWindowMatches(windows, buildWindowIndex(windows), tokenizeText(passage)));
  const first = manuscript.findIndex((w) => w.content === "quick");
  const second = manuscript.findLastIndex((w) => w.content === "quick");
  assert.ok(ids.has(first) && ids.has(second));
});

test("a repeated word inside a copied passage is flagged every time", () => {
  const sentence = "arriving every decade by the middle of the century according to the models";
  const manuscript = toWords(sentence);
  const windows = createDocxWindows(manuscript);
  const ids = new Set(findWindowMatches(windows, buildWindowIndex(windows), tokenizeText(sentence)));
  manuscript.forEach((w) => assert.ok(ids.has(w.id), `${w.content} #${w.id}`));
});

test("trigrams record every occurrence and drop stop words", () => {
  const words = toWords("climate change impacts the climate change impacts of cities");
  const trigrams = buildDocxTrigrams(words);
  // "the" and "of" removed: climate change impacts climate change impacts cities
  assert.deepEqual(trigrams.get("climate change impacts"), [0, 1, 2, 4, 5, 6]);
  assert.ok(trigrams.has("change impacts climate"));
  assert.ok(buildTrigramSet(tokenizeText("the climate of change impacts")).has("climate change impacts"));
});

test("shared trigrams are gated by the threshold", () => {
  const docx = ["a b c", "b c d", "c d e"];
  assert.deepEqual(findSharedTrigrams(docx, new Set(["a b c", "c d e"]), 2), ["a b c", "c d e"]);
  assert.deepEqual(findSharedTrigrams(docx, new Set(["a b c"]), 2), []);
});

test("combineMatches credits trigrams found in exactly one source", () => {
  const docxTrigrams = new Map([
    ["only first", [1, 2, 3]],
    ["in both", [4, 5, 6]],
  ]);
  const [first, second] = combineMatches(
    [
      { windowIds: [10], sharedTrigrams: ["only first", "in both"] },
      { windowIds: [], sharedTrigrams: ["in both"] },
    ],
    docxTrigrams
  );
  assert.deepEqual([...first].sort((a, b) => a - b), [1, 2, 3, 10]);
  assert.deepEqual([...second], []);
});

test("lone stop words are dropped, stop words inside passages kept", () => {
  const words = toWords("the problem across the developing world of survey");
  // flagged: "the"(0) alone, "across the developing"(2,3,4), "of"(6) alone
  const kept = dropStrayStopWords(new Set([0, 2, 3, 4, 6]), words);
  assert.deepEqual([...kept].sort((a, b) => a - b), [2, 3, 4]);
});

test("summarize removes disabled sources from every figure", () => {
  const sources = [new Set([1, 2, 3, 4]), new Set([3, 4, 5]), new Set([9])];

  const all = summarize(sources, [true, true, true], 20);
  assert.equal(all.flaggedWords, 6);
  assert.equal(all.overallPercent, 30);
  assert.deepEqual(all.sourcePercent, [20, 15, 5]);
  assert.deepEqual(all.attributedPercent, [20, 5, 5]); // 3 and 4 go to source 0
  assert.equal(all.primary.get(3), 0);

  const firstOff = summarize(sources, [false, true, true], 20);
  assert.equal(firstOff.overallPercent, 20);
  assert.deepEqual(firstOff.sourcePercent, [null, 15, 5]);
  assert.equal(firstOff.primary.get(3), 1);
  assert.ok(!firstOff.primary.has(1));

  assert.equal(summarize(sources, [false, false, false], 20).overallPercent, 0);
});

test("similarity levels, default and custom", () => {
  assert.equal(similarityLevel(9.99), "low");
  assert.equal(similarityLevel(10), "moderate");
  assert.equal(similarityLevel(25), "high");
  const strict = normalizeSettings({ moderateFrom: 3, highFrom: 8 });
  assert.equal(similarityLevel(2.9, strict), "low");
  assert.equal(similarityLevel(5, strict), "moderate");
  assert.equal(similarityLevel(8, strict), "high");
});

test("default settings match the documented values", () => {
  assert.deepEqual({ ...DEFAULT_SETTINGS }, {
    docxWindow: 13,
    pdfWindow: 11,
    windowMatch: 8,
    phrases: true,
    phraseGate: 21,
    phrasesUniqueOnly: true,
    dropLoneStopWords: true,
    ignoreReferenceList: true,
    ignoreQuotedText: false,
    moderateFrom: 10,
    highFrom: 25,
  });
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  assert.ok(isDefaultSettings(normalizeSettings()));
  assert.ok(!isDefaultSettings(normalizeSettings({ windowMatch: 6 })));
});

test("normalizeSettings keeps every setting usable", () => {
  // Words to match can't exceed the smaller window
  assert.equal(normalizeSettings({ docxWindow: 13, pdfWindow: 6, windowMatch: 9 }).windowMatch, 6);
  // Out-of-range and junk values are clamped or fall back
  const odd = normalizeSettings({ docxWindow: 999, pdfWindow: -4, phraseGate: "abc", windowMatch: 7.6 });
  assert.equal(odd.docxWindow, 40);
  assert.equal(odd.pdfWindow, 5);
  assert.equal(odd.phraseGate, 21);
  assert.equal(odd.windowMatch, 5); // rounded to 8, then capped by the 5-word window
  // "High" never starts below "moderate"
  assert.deepEqual(
    (({ moderateFrom, highFrom }) => ({ moderateFrom, highFrom }))(normalizeSettings({ moderateFrom: 30, highFrom: 20 })),
    { moderateFrom: 30, highFrom: 30 }
  );
  // Unknown keys are dropped, so stale saved settings can't break anything
  assert.ok(!("bogus" in normalizeSettings({ bogus: 1 })));
});

test("indexed matcher equals brute force across window and threshold settings", () => {
  const random = rng(99);
  const vocab = Array.from({ length: 30 }, (_, i) => `v${i}`);
  const pick = () => vocab[Math.floor(random() * vocab.length)];
  for (let round = 0; round < 40; round++) {
    const settings = normalizeSettings({
      docxWindow: 5 + Math.floor(random() * 20),
      pdfWindow: 5 + Math.floor(random() * 20),
      windowMatch: 2 + Math.floor(random() * 20),
    });
    const docx = Array.from({ length: 20 + Math.floor(random() * 120) }, pick);
    const source = Array.from({ length: 3 + Math.floor(random() * 200) }, pick);
    const words = docx.map((content, id) => ({ id, content }));
    const windows = createDocxWindows(words, settings.docxWindow);
    const fast = findWindowMatches(windows, buildWindowIndex(windows), source, settings.pdfWindow, settings.windowMatch);
    const slow = bruteForceMatches(windows, source, settings.pdfWindow, settings.windowMatch);
    assert.deepEqual([...fast].sort((a, b) => a - b), [...slow].sort((a, b) => a - b), JSON.stringify(settings));
  }
});

test("finalizeMatches follows the phrase and stop-word settings", () => {
  // ids: alpha 0, beta 1, gamma 2, one 3, the 4, two 5, delta 6, epsilon 7, zeta 8
  const words = toWords("alpha beta gamma one the two delta epsilon zeta");
  const docxTrigrams = new Map([
    ["alpha beta gamma", [0, 1, 2]],
    ["delta epsilon zeta", [6, 7, 8]],
  ]);
  const results = [
    { windowIds: [4], sharedTrigrams: ["alpha beta gamma", "delta epsilon zeta"] },
    { windowIds: [], sharedTrigrams: ["delta epsilon zeta"] },
  ];
  const sorted = (set) => [...set].sort((a, b) => a - b);
  const run = (overrides) => finalizeMatches(results, docxTrigrams, words, normalizeSettings(overrides));

  // Defaults: only the phrase unique to source 0 counts; the lone "the" (4) is dropped
  assert.deepEqual(run({}).map(sorted), [[0, 1, 2], []]);
  // Credit shared phrases to every source
  assert.deepEqual(run({ phrasesUniqueOnly: false }).map(sorted), [[0, 1, 2, 6, 7, 8], [6, 7, 8]]);
  // Phrase check off: only window matches remain, and keeping lone stop words keeps "the"
  assert.deepEqual(run({ phrases: false, dropLoneStopWords: false }).map(sorted), [[4], []]);
});

test("reference headings are recognised by normalised text and block shape", () => {
  for (const text of ["References", "BIBLIOGRAPHY.", "Works Cited", "Reference List", "Sources", "Literature Cited"]) {
    assert.ok(isReferenceHeadingText(text), text);
  }
  assert.ok(!isReferenceHeadingText("References and further reading"));
  assert.ok(isReferenceHeadingBlock({ tagName: "H2", text: "Bibliography" }));
  assert.ok(isReferenceHeadingBlock({ tagName: "p", text: "Works Cited", bold: true }));
  assert.ok(!isReferenceHeadingBlock({ tagName: "p", text: "Works Cited", bold: false }));
  assert.ok(!isReferenceHeadingBlock({ tagName: "p", text: "Sources of inspiration for this long chapter title", bold: true }));
  assert.ok(isHeadingLikeBlock({ tagName: "h3", text: "Appendix A" }));
  assert.ok(isHeadingLikeBlock({ tagName: "p", text: "Primary sources", bold: true }));
  assert.ok(!isHeadingLikeBlock({ tagName: "p", text: "Primary sources" }));
  assert.ok(!isHeadingLikeBlock({ tagName: "h2", text: " " }));
});

/* Reference lists: a reference heading counts only when citations follow it */

const REFERENCE_ENTRIES = [
  // APA, MLA, an organisation with a web address, IEEE, Vancouver, Chicago author-date
  "Smith, J. A., & Lee, K. (2019). Coastal flooding in delta cities. Journal of Water Policy, 12(3), 45–67. https://doi.org/10.1000/xyz123",
  "Okafor, Ngozi. Living with Water. Oxford University Press, 2021.",
  "Environment Agency. (2021). Flood risk maps for England. Retrieved from https://www.gov.uk/flood-maps",
  "J. Smith and K. Lee, “Tidal gauges,” IEEE Trans. Geosci., vol. 3, no. 2, pp. 1–10, 2018.",
  "Smith J, Lee K. Mangrove buffers. J Coast Res. 2020;36(2):101-9.",
  "Brown, Alice. 2017. Harbour Records of the North Sea. London: Routledge.",
];
const BODY =
  "Across the developing world, coastal infrastructure faces a serious threat because sea levels are " +
  "rising now, and storm surges that once arrived every fifty years are projected to occur every decade " +
  "by the middle of the century.";
const SHORT_BODY = "The council has piloted two small sites along the estuary.";
const h = (level, text) => ({ tagName: `h${level}`, text });
const p = (text, extra = {}) => ({ tagName: "p", text, ...extra });
const flagged = (blocks) => referenceBlockFlags(blocks).flatMap((flag, i) => (flag ? [i] : []));

test("citations in common styles read as reference entries; body sentences do not", () => {
  for (const entry of REFERENCE_ENTRIES) assert.ok(looksLikeCitation(entry), entry);
  for (const sentence of [
    BODY,
    SHORT_BODY,
    "Smith et al. (2019) found that mangroves reduce wave heights by a third.",
    "However, Smith (2019) argued that the levee was too low for the 2020 surge.",
    "In 2019, the council published its first flood plan.",
    "References",
  ]) {
    assert.ok(!looksLikeCitation(sentence), sentence);
  }
});

test("a reference list at the end is found, from its heading to the end", () => {
  const blocks = [h(1, "Living With Water"), p(BODY), h(2, "Responses"), p(BODY), h(2, "References"), ...REFERENCE_ENTRIES.map((e) => p(e))];
  assert.deepEqual(findReferenceSections(blocks), [{ start: 4, end: blocks.length }]);
  assert.deepEqual(flagged(blocks), [4, 5, 6, 7, 8, 9, 10]);
});

test("a stray reference heading above body text excludes nothing", () => {
  // A bold "References" line near the top used to hide the whole draft
  const blocks = [h(1, "Living With Water"), p(SHORT_BODY), p("References", { bold: true }), h(2, "The problem"), p(BODY), p(BODY), h(2, "Responses"), p(BODY)];
  assert.deepEqual(findReferenceSections(blocks), []);
  assert.deepEqual(flagged(blocks), []);
});

test("a body section titled Sources is still counted", () => {
  const blocks = [h(1, "Living With Water"), p(BODY), h(2, "Sources"), p(BODY), p(SHORT_BODY), h(2, "Conclusion"), p(BODY)];
  assert.deepEqual(flagged(blocks), []);
});

test("a reference list ends at the next heading whose section is not citations", () => {
  const blocks = [h(2, "References"), p(REFERENCE_ENTRIES[0]), p(REFERENCE_ENTRIES[1]), h(2, "Appendix A: Survey questions"), p(BODY), p(SHORT_BODY)];
  assert.deepEqual(flagged(blocks), [0, 1, 2]);
});

test("a reference list continues through subheadings that hold citations", () => {
  const blocks = [
    h(2, "Bibliography"),
    p("Primary sources", { bold: true }),
    p(REFERENCE_ENTRIES[0]),
    p(REFERENCE_ENTRIES[1]),
    h(3, "Secondary sources"),
    p(REFERENCE_ENTRIES[2]),
    { tagName: "LI", text: REFERENCE_ENTRIES[3] },
  ];
  assert.deepEqual(flagged(blocks), [0, 1, 2, 3, 4, 5, 6]);
});

test("prose pasted under a real reference list is still counted", () => {
  const blocks = [h(2, "References"), p(REFERENCE_ENTRIES[0]), p(REFERENCE_ENTRIES[1]), p(REFERENCE_ENTRIES[2]), p(BODY)];
  assert.deepEqual(flagged(blocks), [0, 1, 2, 3]);
});

test("a reference list typed as one paragraph is read line by line", () => {
  const blocks = [h(2, "Works Cited"), p(REFERENCE_ENTRIES.join(" "), { lines: REFERENCE_ENTRIES })];
  assert.deepEqual(flagged(blocks), [0, 1]);
});

test("every reference list is found, and only real ones", () => {
  const blocks = [
    h(1, "Chapter 1"),
    p(BODY),
    p("References", { bold: true }), // stray: body text follows
    h(2, "The problem"),
    p(BODY),
    h(2, "References"),
    p(REFERENCE_ENTRIES[0]),
    p(REFERENCE_ENTRIES[1]),
    h(1, "Chapter 2"),
    p(BODY),
    h(2, "Literature Cited"),
    p(REFERENCE_ENTRIES[4]),
    p(REFERENCE_ENTRIES[5]),
  ];
  assert.deepEqual(findReferenceSections(blocks), [
    { start: 5, end: 8 },
    { start: 10, end: 13 },
  ]);
});

test("quoted parts are tracked across straight and curly quotation marks", () => {
  assert.deepEqual(
    markQuotedParts(['"alpha', 'beta"', "gamma", "“delta", "epsilon”", "zeta"]),
    [true, true, false, true, true, false]
  );
});

/* Quotation marks: apostrophes, elisions, inch marks, nesting, unmatched marks */

// The words of a sentence that read as quoted
const quotedWords = (sentence) => {
  const parts = sentence.split(/\s+/);
  const flags = markQuotedParts(parts);
  return parts.filter((_, i) => flags[i]).join(" ");
};

test("an apostrophe inside a quotation does not end it", () => {
  assert.equal(
    quotedWords("“I don’t think the council’s plan will work,” she said, and the meeting ended."),
    "“I don’t think the council’s plan will work,”"
  );
  assert.equal(quotedWords("He said \"it's O'Brien's turn\" and sat down."), "\"it's O'Brien's turn\"");
});

test("elisions, possessives and inch marks open nothing", () => {
  for (const sentence of [
    "In the ‘90s the port grew quickly and the city expanded along the river.",
    "In the ’90s the port grew quickly and the city expanded along the river.",
    "In the '90s the port grew quickly and the city expanded along the river.",
    "The students’ work was strong, and the teachers’ notes were brief.",
    'The 12" pipe failed. Engineers replaced it and the district stayed dry.',
    "The 6\" valve and the 12\" pipe were both replaced.",
  ]) {
    assert.equal(quotedWords(sentence), "", sentence);
  }
});

test("a single quotation inside a double one is nested", () => {
  assert.equal(
    quotedWords("“He said ‘yes’ and left the room,” she wrote later."),
    "“He said ‘yes’ and left the room,”"
  );
  assert.equal(quotedWords("She called it 'the plan' twice."), "'the plan'");
});

test("an unmatched quotation mark hides nothing", () => {
  assert.equal(quotedWords("He called it “the plan and then left the meeting early."), "");
  assert.equal(quotedWords('The memo said "see attached and nothing more.'), "");
  // A closed quotation later in the paragraph still counts
  assert.equal(quotedWords("A stray “ mark, then a real “quoted phrase” here."), "“quoted phrase”");
});

test("quotation marks are read across pieces with no space between them", () => {
  // Text split over several runs (bold, italics) arrives in separate pieces
  const { quoted } = findQuotedParts(["“", "quoted", "”", " ", "after", " ", '"', "word", '"', " ", "end"]);
  assert.deepEqual(
    quoted.map((flag, i) => (flag ? i : -1)).filter((i) => i >= 0),
    [1, 7]
  );
});

test("a quotation over several paragraphs is left open for the next paragraph", () => {
  const first = findQuotedParts(["“The", " ", "first", " ", "paragraph."]);
  assert.deepEqual(first.quoted, [false, false, false, false, false]);
  assert.deepEqual(first.unclosed, [true, false, true, false, true]);
  assert.ok(continuesQuotation("“The second paragraph ends here.”"));
  assert.ok(continuesQuotation('  "Straight opening'));
  assert.ok(!continuesQuotation("A plain paragraph."));
  assert.ok(!continuesQuotation('" spaced mark'));
  // Single quotations do not run over paragraphs
  assert.deepEqual(findQuotedParts(["‘open", " ", "single"]).unclosed, [false, false, false]);
});

test("excluded words are removed by finalizeMatches and left out of the count", () => {
  const words = toWords("alpha beta gamma delta epsilon");
  words[3].inQuotedText = true;
  words[4].inReferenceList = true;
  const results = [{ windowIds: [0, 1, 2, 3, 4], sharedTrigrams: [] }];

  const both = normalizeSettings({ ignoreReferenceList: true, ignoreQuotedText: true });
  assert.deepEqual([...finalizeMatches(results, new Map(), words, both)[0]].sort((a, b) => a - b), [0, 1, 2]);
  const summary = exclusionSummary(words, both);
  assert.equal(summary.totalWords, 5);
  assert.equal(summary.countedWords, 3);
  assert.equal(summary.ignoredWords, 2);
  assert.equal(summary.referenceListIgnoredWords, 1);
  assert.equal(summary.quotedIgnoredWords, 1);

  const counted = normalizeSettings({ ignoreReferenceList: false, ignoreQuotedText: false });
  assert.deepEqual(
    [...finalizeMatches(results, new Map(), words, counted)[0]].sort((a, b) => a - b),
    [0, 1, 2, 3, 4]
  );
  assert.equal(exclusionSummary(words, counted).countedWords, 5);
});

test("window matches with positions agree with findWindowMatches and locate the source window", () => {
  const sentence = "rising sea levels pose a serious threat to coastal infrastructure worldwide today";
  const manuscript = toWords(`original opening words here ${sentence} original closing words`);
  const source = tokenizeText(`filler one two three ${sentence} trailing filler words`);
  const windows = createDocxWindows(manuscript);
  const index = buildWindowIndex(windows);
  const detailed = findWindowMatchesWithPositions(windows, index, source);
  const plain = new Set(findWindowMatches(windows, index, source));
  assert.deepEqual([...detailed.ids].sort((a, b) => a - b), [...plain].sort((a, b) => a - b));
  const threat = manuscript.find((word) => word.content === "threat");
  const position = detailed.positions.get(threat.id);
  assert.ok(position, "position recorded");
  assert.ok(source.slice(position.sourceStart, position.sourceStart + 11).includes("threat"));
  assert.ok(position.shared >= DEFAULT_SETTINGS.windowMatch);
});

test("trigram positions point at the first occurrence in the source", () => {
  const source = tokenizeText("filler words alpha beta gamma more filler alpha beta gamma");
  const positions = findTrigramPositions(source, ["alpha beta gamma", "absent trigram here"]);
  assert.equal(positions.get("alpha beta gamma"), 2);
  assert.ok(!positions.has("absent trigram here"));
});
