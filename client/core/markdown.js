/* Shared Markdown dialect for desktop rendering, previews and speech. */
(function (global) {
  'use strict';
  const commonjs = typeof module !== 'undefined' && module.exports;
  const marked = commonjs ? require('../vendor/markdown/marked.umd.js') : global.marked;
  const INSTALLED = '__soduworkMarkdownDialect';

  if (!marked[INSTALLED]) {
    Object.defineProperty(marked, INSTALLED, { value: true });

    // GFM accepts a single "~" as strikethrough, which turns ranges such as
    // "3~5 天" or "20~25℃" into deleted text. Only explicit "~~" delegates
    // to GFM; returning undefined prevents the single-tilde fallback.
    const nativeEmStrong = new marked.Lexer(marked.defaults).tokenizer.emStrong;
    const NON_ASCII_PUNCTUATION = /[\p{P}\p{S}]/u;

    function isFullWidthPunctuation(character) {
      return !!character && character.codePointAt(0) > 0x7f &&
        NON_ASCII_PUNCTUATION.test(character);
    }

    // CommonMark closes "**" only when the delimiter is right-flanking. In
    // "**注意：**这里" the closing delimiter follows "：" (punctuation) and
    // precedes a Chinese character, so it is not right-flanking and the
    // asterisks stay literal. Find the first closing "**" whose inner edge is
    // full-width punctuation, while ignoring code spans, escapes and link
    // destinations so existing Markdown is never reparsed as emphasis.
    function cjkStrongClose(src) {
      if (src[0] !== '*' || src[1] !== '*' || !src[2] || src[2] === '*' || /\s/.test(src[2])) return null;
      let codeTicks = 0;
      for (let index = 2; index < src.length - 1; index++) {
        const character = src[index];
        if (character === '\\') { index++; continue; }
        if (character === '`') {
          let run = 0;
          while (src[index + run] === '`') run++;
          if (!codeTicks) codeTicks = run;
          else if (codeTicks === run) codeTicks = 0;
          index += run - 1;
          continue;
        }
        if (codeTicks) continue;
        if (character === ']' && src[index + 1] === '(') {
          for (index += 2; index < src.length && src[index] !== ')'; index++) {
            if (src[index] === '\\') index++;
          }
          continue;
        }
        if (character !== '*' || src[index + 1] !== '*' || src[index + 2] === '*') continue;
        const before = src[index - 1];
        const after = src[index + 2] || '';
        const text = src.slice(2, index);
        if (!isFullWidthPunctuation(before) || !after || /\s/.test(after) ||
            !text || /[\r\n]/.test(text) || /\s$/.test(text)) continue;
        return { raw: src.slice(0, index + 2), text };
      }
      return null;
    }

    marked.use({
      tokenizer: {
        del(src) {
          if (src.startsWith('~~')) return false;
        },
        emStrong(src, scanned, preceding) {
          const native = nativeEmStrong.call(this, src, scanned, preceding);
          const cjk = cjkStrongClose(src);
          // A native match that ends later than the first CJK-punctuation
          // delimiter produces nested <strong><strong> output, so prefer the
          // narrower CJK match in that case.
          if (cjk && (!native || native.raw.length > cjk.raw.length)) {
            return {
              type: 'strong',
              raw: cjk.raw,
              text: cjk.text,
              tokens: this.lexer.inlineTokens(cjk.text),
            };
          }
          return native;
        },
      },
    });
  }
  if (commonjs) module.exports = marked;
})(globalThis);
