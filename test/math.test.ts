import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMathText } from '../src/math.ts';
import { renderDigest } from '../src/render.ts';
import type { Digest } from '../src/digest.ts';

test('inline and display TeX render with accessible MathML', () => {
  for (const input of [String.raw`$\alpha^2$`, String.raw`\(\alpha^2\)`]) {
    const html = renderMathText(input);
    assert.match(html, /class="katex"/);
    assert.match(html, /<math /);
    assert.match(html, /α/);
    assert.doesNotMatch(html, /class="katex-display"/);
  }
  for (const input of [String.raw`$$\frac{1}{2}$$`, String.raw`\[\frac{1}{2}\]`]) {
    assert.match(renderMathText(input), /class="katex-display"/);
  }
});

test('text escaping, escaped delimiters, brace groups, and malformed math stay readable', () => {
  assert.equal(renderMathText('<script> & "text"'), '&lt;script&gt; &amp; &quot;text&quot;');
  assert.equal(renderMathText(String.raw`Cost \$5; unmatched $x`), String.raw`Cost \$5; unmatched $x`);
  assert.equal(renderMathText(String.raw`Bad $\notACommand{x}$`), String.raw`Bad $\notACommand{x}$`);
  assert.equal(renderMathText(String.raw`Missing $\frac{1$`), String.raw`Missing $\frac{1$`);
  assert.equal((renderMathText(String.raw`$x$ and \(y\)`).match(/class="katex"/g) ?? []).length, 2);
  assert.match(renderMathText(String.raw`$\text{price: \$5} + x$`), /class="katex"/);
  assert.doesNotMatch(renderMathText(String.raw`$\href{javascript:alert(1)}{click}$`), /href="javascript:/);
  assert.doesNotMatch(renderMathText(String.raw`$\htmlClass{evil}{x}$`), /class="evil"/);
});

test('math appears in featured titles, abstracts, and collapsed remainder titles', () => {
  const digest: Digest = {
    date: '2026-11-09', categories: ['quant-ph'], featuredIds: ['2611.00001'],
    papers: [
      { id: '2611.00001', version: 1, title: 'Title $x^2$', abstract: String.raw`Abstract \(\alpha\)`, categories: ['quant-ph'] },
      { id: '2611.00002', version: 1, title: 'Other $y^2$', abstract: String.raw`Abstract \[\beta\]`, categories: ['quant-ph'] },
    ],
  };
  const html = renderDigest(digest);
  assert.match(html, /<h3>Title <span class="katex"/);
  assert.match(html, /<summary>Other <span class="katex"/);
  assert.equal((html.match(/class="katex"/g) ?? []).length, 4);
  assert.match(html, /href="\/assets\/katex\/katex.min.css"/);
  assert.doesNotMatch(html, /<script/);
});
