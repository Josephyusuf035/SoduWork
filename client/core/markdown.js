/* Shared Markdown dialect for desktop rendering, previews and speech. */
(function (global) {
  'use strict';
  const commonjs = typeof module !== 'undefined' && module.exports;
  const marked = commonjs ? require('../vendor/markdown/marked.umd.js') : global.marked;
  const PUNCTUATION = /[\p{P}\p{S}]/u;
  const SPACE = /\s/u;

  // Index just past the code span that opens at `start`, or -1 when the
  // backtick run has no closing run of the same length on this line.
  function codeSpanEnd(src, start) {
    let width = 0;
    while (src[start + width] === '`') width += 1;
    for (let i = start + width; i < src.length && src[i] !== '\n'; i += 1) {
      if (src[i] !== '`') continue;
      let run = 0;
      while (src[i + run] === '`') run += 1;
      if (run === width) return i + run;
      i += run - 1;
    }
    return -1;
  }

  // Index just past the bracketed text that opens at `start`, or -1.
  function bracketEnd(src, start) {
    let depth = 0;
    for (let i = start; i < src.length && src[i] !== '\n'; i += 1) {
      if (src[i] === '\\') { i += 1; continue; }
      if (src[i] === '`') {
        const end = codeSpanEnd(src, i);
        if (end > 0) { i = end - 1; continue; }
      }
      if (src[i] === '[') depth += 1;
      else if (src[i] === ']' && --depth === 0) return i + 1;
    }
    return -1;
  }

  // Position of the "**" that closes the one opening `src`, skipping escapes,
  // code spans and link text so their asterisks are never taken as delimiters.
  function strongClose(src) {
    if (!src.startsWith('**') || src[2] === '*' || !src[2] || SPACE.test(src[2])) return -1;
    for (let i = 2; i < src.length && src[i] !== '\n'; i += 1) {
      const char = src[i];
      if (char === '\\') { i += 1; continue; }
      if (char === '`' || char === '[') {
        const end = char === '`' ? codeSpanEnd(src, i) : bracketEnd(src, i);
        if (end > 0) { i = end - 1; continue; }
        if (char === '`') { while (src[i + 1] === '`') i += 1; }
        continue;
      }
      if (char === '*' && src[i + 1] === '*') {
        return src[i + 2] === '*' || SPACE.test(src[i - 1]) ? -1 : i;
      }
    }
    return -1;
  }

  marked.use({
    extensions: [{
      // CommonMark closes "**" after punctuation only when whitespace or
      // punctuation follows. Chinese has no spaces between words, so
      // "**注意：**这里" and "**重点（必读）**内容" keep their asterisks.
      // Handle only those edges; everything else stays with marked.
      name: 'cjkStrong',
      level: 'inline',
      start(src) {
        const index = src.indexOf('**');
        return index < 0 ? undefined : index;
      },
      tokenizer(src) {
        const close = strongClose(src);
        if (close < 0) return undefined;
        const text = src.slice(2, close);
        if (!PUNCTUATION.test(text[0]) && !PUNCTUATION.test(text[text.length - 1])) return undefined;
        return { type: 'strong', raw: src.slice(0, close + 2), text, tokens: this.lexer.inlineTokens(text) };
      },
    }],
    tokenizer: {
      del(src) {
        // Single tildes commonly separate numeric ranges. Only explicit double
        // tildes delegate to GFM; returning undefined prevents single-tilde fallback.
        if (src.startsWith('~~')) return false;
      },
    },
  });
  if (commonjs) module.exports = marked;
})(globalThis);
