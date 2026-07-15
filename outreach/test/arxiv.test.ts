import { describe, expect, test } from 'vitest';
import { parseArxivAtom, selectTargetAuthor, buildPaperContext } from '../src/pipeline/arxiv.js';

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2308.04079v1</id>
    <title>3D Gaussian Splatting for Real-Time Radiance Field Rendering</title>
    <summary>We present a method for real-time radiance field rendering.</summary>
    <author><name>Bernhard Kerbl</name><arxiv:affiliation>Inria</arxiv:affiliation></author>
    <author><name>Georgios Kopanas</name></author>
    <author><name>George Drettakis</name></author>
    <arxiv:primary_category term="cs.GR"/>
    <category term="cs.GR"/>
    <category term="cs.CV"/>
  </entry>
</feed>`;

describe('parseArxivAtom', () => {
  test('extracts id, title, abstract, ordered authors, and primary category', () => {
    const p = parseArxivAtom(ATOM);
    expect(p.arxivId).toBe('2308.04079');
    expect(p.title).toBe('3D Gaussian Splatting for Real-Time Radiance Field Rendering');
    expect(p.abstract).toContain('real-time radiance field');
    expect(p.authors).toEqual(['Bernhard Kerbl', 'Georgios Kopanas', 'George Drettakis']);
    expect(p.primaryCategory).toBe('cs.GR');
    expect(p.affiliationHint).toBe('Inria'); // first author's arxiv:affiliation
  });

  test('handles a single-author entry (parser returns object, not array)', () => {
    const solo = ATOM.replace(/<author><name>Georgios[\s\S]*?George Drettakis<\/name><\/author>/, '');
    const p = parseArxivAtom(solo);
    expect(p.authors).toEqual(['Bernhard Kerbl']);
  });
});

describe('selectTargetAuthor', () => {
  test('defaults to the first author', () => {
    const p = parseArxivAtom(ATOM);
    expect(selectTargetAuthor(p)).toEqual({ name: 'Bernhard Kerbl', index: 0 });
  });
});

describe('buildPaperContext', () => {
  test('builds context with co-authors (target excluded) and mapped area terms', () => {
    const p = parseArxivAtom(ATOM);
    const ctx = buildPaperContext(p, selectTargetAuthor(p));
    expect(ctx.arxivId).toBe('2308.04079');
    expect(ctx.affiliationHint).toBe('Inria');
    expect(ctx.coauthors).toEqual(['Georgios Kopanas', 'George Drettakis']); // target excluded
    expect(ctx.areaTerms).toContain('computer graphics'); // cs.GR mapped
  });
});
