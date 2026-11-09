const particles = new Set(['al', 'bin', 'da', 'de', 'del', 'der', 'di', 'dos', 'du', 'la', 'le', 'van', 'von']);

/** arXiv names occasionally contain TeX accents outside math delimiters. */
export function displayName(name: string): string {
  const accents: Record<string, string> = { "'": '\u0301', '`': '\u0300', '"': '\u0308', '^': '\u0302', '~': '\u0303', '=': '\u0304', '.': '\u0307', u: '\u0306', v: '\u030c', H: '\u030b', c: '\u0327', k: '\u0328' };
  return name.replace(/\\(['`"^~=.uvHck])\s*\{?([A-Za-z])\}?/g, (_, accent: string, letter: string) => (letter + accents[accent]).normalize('NFC'))
    .replace(/\{?\\([oOlL])\}?/g, (_, letter: string) => ({ o: 'ø', O: 'Ø', l: 'ł', L: 'Ł' })[letter]!)
    .replace(/[{}]/g, '').trim();
}

/** Unstructured RSS names need a conservative heuristic; the tooltip retains all names. */
export function abbreviateAuthor(name: string): string {
  const full = displayName(name);
  const words = full.split(/\s+/);
  if (words.length < 2 || /\b(collaboration|consortium|team|group)\b|\(|\)/i.test(full)) return full;
  let last = words.length - 1;
  if (/^(jr\.?|sr\.?|ii|iii|iv)$/i.test(words[last])) last--;
  while (last > 1 && particles.has(words[last - 1].toLowerCase())) last--;
  return `${Array.from(words[0])[0]}. ${words.slice(last).join(' ')}`;
}

/** Show every name up to four; otherwise retain the first two and last two. */
export function compactAuthors(authors: string[]): string {
  const names = authors.map(abbreviateAuthor);
  return names.length <= 4 ? names.join(', ') : `${names.slice(0, 2).join(', ')} … ${names.slice(-2).join(', ')}`;
}
