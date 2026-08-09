import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { initVault } from '../src/vault.js';
import { SourceService, reconstructChunks, validateChunkEndpoints } from '../src/sources.js';
import { WikiService, isExecutableHtml } from '../src/wiki.js';

const temporaryRoots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(join('/tmp', 'pi-scholar-knowledge-'));
  temporaryRoots.push(root);
  const paths = initVault(root);
  const db = openDatabase(paths);
  return { root, paths, db, sources: new SourceService(db, paths), wiki: new WikiService(db, paths) };
}
afterEach(async () => { for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe('source admission mechanics', () => {
  it('discovers every direct inbox entry in canonical order', async () => {
    const { paths, db, sources } = await fixture();
    for (let index = 0; index < 200; index++) await fs.writeFile(join(paths.inboxRoot, `entry-${String(index).padStart(3, '0')}.txt`), `entry ${index}\n`);
    const entries = await sources.discover();
    expect(entries).toHaveLength(200);
    expect(entries[0].relativePath).toBe('entry-000.txt');
    expect(entries.at(-1)?.relativePath).toBe('entry-199.txt');
    db.close();
  });

  it('isolates malformed siblings and publishes the valid claim', async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, 'good.txt'), 'valid\n');
    await fs.symlink('/etc/passwd', join(paths.inboxRoot, 'bad.txt'));
    const results = await sources.admitClaims(await sources.discover());
    expect(results).toHaveLength(2);
    expect(results.filter((result) => result.result)).toHaveLength(1);
    expect(await fs.readdir(paths.sourcesRoot)).toHaveLength(1);
    db.close();
  });

  it('retains long native extraction and reconstructs planned chunks exactly', async () => {
    const { paths, db, sources } = await fixture();
    const text = Array.from({ length: 20_000 }, (_, index) => `line-${index}\n`).join('');
    await fs.writeFile(join(paths.inboxRoot, 'long.txt'), text);
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const result = await sources.admitClaim(claim, { endpoints: [10_000, 20_000] });
    const extracted = await fs.readFile(join(result.packetPath, 'extracted.md'));
    expect(extracted.toString()).toBe(text);
    const chunks = validateChunkEndpoints(extracted, [10_000, 20_000]);
    expect(reconstructChunks(chunks).equals(extracted)).toBe(true);
    db.close();
  });

  it('rejects incomplete endpoint plans and unsafe staging', async () => {
    const { root, paths, db, sources } = await fixture();
    expect(() => validateChunkEndpoints('a\nb\n', [1])).toThrow();
    await fs.writeFile(join(root, 'outside.txt'), 'outside');
    await expect(sources.stage({ path: join(root, 'outside.txt'), name: '../escape.txt' })).rejects.toThrow();
    await fs.symlink(join(root, 'outside.txt'), join(paths.inboxRoot, 'link.txt'));
    await expect(sources.stage({ path: join(paths.inboxRoot, 'link.txt') })).rejects.toThrow();
    db.close();
  });

  it('keeps published packets immutable and rejects stale removal consent', async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, 'source.txt'), 'evidence\n');
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    const before = await fs.readFile(join(result.packetPath, 'extracted.md'));
    const preview = sources.removalPreview(result.sourceId);
    db.run('INSERT INTO source_dependencies (source_id, page_id, chunk_id, relation) VALUES (?, NULL, ?, ?)', [result.sourceId, result.manifest.chunks[0]?.chunkId, 'citation']);
    await expect(sources.removeConfirmed(result.sourceId, preview.confirmationId)).rejects.toThrow(/stale/i);
    expect((await fs.readFile(join(result.packetPath, 'extracted.md'))).equals(before)).toBe(true);
    db.close();
  });
});

describe('wiki mechanics', () => {
  it('keeps a host page ID across guarded rename', async () => {
    const { db, wiki } = await fixture();
    const created = await wiki.create({ path: 'notes/one.md', title: 'One', body: '# One\n\nText.' });
    const renamed = await wiki.rename(created.page.pageId, 'notes/two.md');
    expect(renamed.pageId).toBe(created.page.pageId);
    expect((await wiki.get(created.page.pageId)).relativePath).toBe('notes/two.md');
    db.close();
  });

  it('detects direct drift and exposes exactly two restore choices', async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: 'drift.md', body: 'authored' });
    await fs.appendFile(join(paths.wikiRoot, 'drift.md'), '\nunsupported edit');
    const report = await wiki.inspectDrift(created.page.pageId);
    expect(report.drifted).toBe(true);
    expect(report.choices).toEqual(['record-issue', 'restore']);
    await wiki.resolveDrift(created.page.pageId, 'restore');
    expect((await wiki.inspectDrift(created.page.pageId)).drifted).toBe(false);
    db.close();
  });

  it('reports, resolves, and reopens an issue after eligible guarded work', async () => {
    const { db, wiki } = await fixture();
    const page = await wiki.create({ path: 'issue.md', body: 'text' });
    const issue = await wiki.report({ pageId: page.page.pageId, description: 'unclear' });
    await expect(wiki.patchIssue(issue.issueId, { status: 'resolved' })).rejects.toThrow();
    const resolved = await wiki.patchIssue(issue.issueId, { status: 'resolved', guardedEdit: true, cardUpdated: true, qmdRefreshed: true, lintPassed: true, doctorPassed: true, logRefreshed: true, committed: true });
    expect(resolved.status).toBe('resolved');
    expect((await wiki.patchIssue(issue.issueId, { status: 'open' })).status).toBe('reopened');
    db.close();
  });

  it('scopes semantic qmd search to wiki and keeps exact reads separate', async () => {
    const { db, wiki } = await fixture();
    let seenScope = '';
    const semantic = new WikiService(db, wiki.paths, { qmd: { search: (_query, options) => { seenScope = options?.scope ?? ''; return [{ path: 'notes.md' }]; } } });
    await semantic.create({ path: 'notes.md', body: 'semantic text' });
    expect(await semantic.semanticSearch('semantic')).toHaveLength(1);
    expect(seenScope).toBe('wiki/**/*.md');
    expect((await semantic.readExact('notes.md')).toString()).toContain('semantic text');
    await expect(semantic.readExact('../sources/secret.md')).rejects.toThrow();
    db.close();
  });

  it('rejects executable HTML rather than rendering imported markup', async () => {
    const { db, wiki } = await fixture();
    expect(isExecutableHtml('<script>alert(1)</script>')).toBe(true);
    await expect(wiki.create({ path: 'unsafe.md', body: '<script>alert(1)</script>' })).rejects.toThrow();
    db.close();
  });
});
