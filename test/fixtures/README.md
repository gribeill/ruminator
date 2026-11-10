# arXiv fixtures

`quant-ph.xml` is an excerpt downloaded from https://rss.arxiv.org/rss/quant-ph, with announcement date 2026-11-09 as reported by the source feed. It retains the original channel metadata and the first eight new announcements, one cross-listing, and one replacement. Other entries were omitted to keep tests small.

The fixture preserves source text and XML escaping. Tests deliberately run offline; dates and paper IDs are test data, not assumptions about the current day.

`paper.html` is a synthetic arXiv/LaTeXML-style article, not a downloaded scientific paper. It exercises article-only extraction, section and paragraph boundaries, MathML with TeX alternatives, Unicode/entities, image alt text/captions, tables, appendices, and excluded navigation/scripts. Retrieval integration tests serve it over loopback HTTP without contacting arXiv.

`paper-unsectioned.html` is a synthetic regression fixture for papers with prose paragraphs but no numbered sections, matching the layout that caused extraction of `2611.12481v1` to fail. It also checks that bibliography and post-reference methods are retained.
