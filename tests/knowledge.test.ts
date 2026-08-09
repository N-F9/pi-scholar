import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/database.js';
import { ScholarApplication } from '../src/application.js';
import { initVault } from '../src/vault.js';
import { SourceService, reconstructChunks, validateChunkEndpoints } from '../src/sources.js';
import { runChild } from '../src/external/process.js';
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

  it('prepares immutable work artifacts and publishes only the bound claim', async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, 'prepared.txt'), 'one\ntwo\n');
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const prepared = await sources.prepareClaim(claim);
    expect(prepared).toMatchObject({
      claimId: claim.claimId,
      kind: 'text',
      digest: claim.snapshot.digest,
      atoms: [
        { index: 0, startByte: 0, endByte: 4, byteLength: 4 },
        { index: 1, startByte: 4, endByte: 8, byteLength: 4 },
      ],
    });
    expect(prepared).not.toHaveProperty('bytes');
    expect(prepared.snapshotPath).toMatch(/^\.pi-scholar\/work\//);
    expect((await fs.readFile(join(paths.vaultRoot, prepared.extractedPath))).toString()).toBe('one\ntwo\n');
    const result = await sources.publishPreparedClaim({ prepared, preparedId: prepared.preparedId, claimId: prepared.claimId, digest: prepared.digest, endpoints: [2] });
    const retry = await sources.publishPreparedClaim({ prepared, preparedId: prepared.preparedId, claimId: prepared.claimId, digest: prepared.digest, endpoints: [2] });
    expect(retry).toBe(result);
    expect(db.get<{ source_id: string }>('SELECT source_id FROM sources WHERE source_id = ?', [result.sourceId])?.source_id).toBe(result.sourceId);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM source_files WHERE source_id = ?', [result.sourceId])?.count).toBe(1);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM source_chunks WHERE source_id = ?', [result.sourceId])?.count).toBe(1);
    expect(result.manifest.extractedDigest).toBe(result.manifest.extractionDigest);
    expect(await fs.readdir(paths.inboxRoot)).toHaveLength(0);
    db.close();
  });

  it('rolls back a newly renamed packet when durable source recording fails', async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, 'rollback.txt'), 'rollback\n');
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const prepared = await sources.prepareClaim(claim);
    db.close();
    await expect(sources.publishPreparedClaim({ prepared, preparedId: prepared.preparedId, claimId: prepared.claimId, digest: prepared.digest })).rejects.toThrow();
    expect(await fs.readdir(paths.sourcesRoot)).toHaveLength(0);
    expect(await fs.readdir(paths.inboxRoot)).toEqual(['rollback.txt']);
    await sources.cleanupPrepared(prepared.preparedId);
  });

  it('strips URL secrets from staged and published provenance while fetching the full URL transiently', async () => {
    const { paths, db } = await fixture();
    let fetchedUrl = '';
    const sources = new SourceService(db, paths, {
      fetchUrl: async (url) => {
        fetchedUrl = url;
        return { bytes: Buffer.from('remote\n'), mediaType: 'text/plain', name: 'remote.txt' };
      },
    });
    await sources.stage({ url: 'https://user:secret@example.com/path/remote.txt?token=abc#fragment' });
    expect(fetchedUrl).toContain('user:secret@example.com/path/remote.txt?token=abc#fragment');
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    expect(result.manifest.sourceUri).toBe('https://example.com/path/remote.txt');
    expect(JSON.stringify(result.manifest)).not.toMatch(/secret|token|fragment/iu);
    expect(db.get<Record<string, unknown>>('SELECT source_uri FROM sources WHERE source_id = ?', [result.sourceId])?.source_uri).toBe('https://example.com/path/remote.txt');
    db.close();
  });

  it('rejects private URL destinations and caps fetched streams before staging', async () => {
    const privateFixture = await fixture();
    await expect(privateFixture.sources.stage({ url: 'http://127.0.0.1/private.txt' })).rejects.toThrow(/private|special/iu);
    privateFixture.db.close();
    const capped = await fixture();
    const oversized = new Uint8Array(100 * 1024 * 1024 + 1);
    const sources = new SourceService(capped.db, capped.paths, { fetchUrl: async () => ({ bytes: oversized }) });
    await expect(sources.stage({ url: 'https://example.com/large.txt' })).rejects.toThrow(/100 MiB/iu);
    capped.db.close();
  });

  it('uses a unique exclusive work directory for concurrent prepares', async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, 'concurrent.txt'), 'same\n');
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const prepared = await Promise.all([sources.prepareClaim(claim), sources.prepareClaim(claim)]);
    expect(prepared[0]?.preparedId).not.toBe(prepared[1]?.preparedId);
    expect(await fs.stat(join(paths.workRoot, `admission-${prepared[0]?.preparedId}`))).toBeTruthy();
    expect(await fs.stat(join(paths.workRoot, `admission-${prepared[1]?.preparedId}`))).toBeTruthy();
    await Promise.all(prepared.map((item) => sources.cleanupPrepared(item.preparedId)));
    db.close();
  });

  it('rejects prepared metadata and attachment tampering before publication', async () => {
    const { paths, db } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, 'document.pdf'), 'document\n');
    const sources = new SourceService(db, paths, {
      docling: async () => ({ extracted: 'converted\n', attachments: [{ path: 'figure.bin', bytes: 'original' }] }),
    });
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const prepared = await sources.prepareClaim(claim);
    const root = join(paths.workRoot, `admission-${prepared.preparedId}`);
    const metadataPath = join(root, '.pi-scholar-prepared.json');
    const metadata = JSON.parse((await fs.readFile(metadataPath)).toString()) as Record<string, unknown>;
    metadata.displayName = 'tampered';
    await fs.writeFile(metadataPath, JSON.stringify(metadata));
    await expect(sources.publishPreparedClaim({ prepared, preparedId: prepared.preparedId, claimId: prepared.claimId, digest: prepared.digest })).rejects.toThrow(/identity|retained/iu);
    await sources.cleanupPrepared(prepared.preparedId);
    const preparedAgain = await sources.prepareClaim(claim);
    await fs.writeFile(join(paths.workRoot, `admission-${preparedAgain.preparedId}`, 'attachments', 'figure.bin'), 'tampered');
    await expect(sources.publishPreparedClaim({ prepared: preparedAgain, preparedId: preparedAgain.preparedId, claimId: preparedAgain.claimId, digest: preparedAgain.digest })).rejects.toThrow(/attachment digest/iu);
    await sources.cleanupPrepared(preparedAgain.preparedId);
    db.close();
  });

  it('rejects incoherent source payload kinds and symlinked path ancestors', async () => {
    const { root, paths, db, sources } = await fixture();
    await expect(sources.stage({ url: 'https://example.com/source.txt', kind: 'text' })).rejects.toThrow(/URL source kind/iu);
    await expect(sources.stage({ text: 'pasted', kind: 'document' })).rejects.toThrow(/text source kind/iu);
    await expect(sources.stage({ bytes: new Uint8Array([1]), kind: 'text' })).rejects.toThrow(/bytes source kind/iu);
    const outside = join(root, 'outside.txt');
    await fs.writeFile(outside, 'outside');
    await expect(sources.stage({ path: outside, kind: 'note' })).rejects.toThrow(/path source kind/iu);
    const linkedDirectory = join(root, 'linked-directory');
    await fs.symlink(root, linkedDirectory);
    await expect(sources.stage({ path: join(linkedDirectory, 'outside.txt') })).rejects.toThrow(/symlink ancestor/iu);
    expect(await fs.readdir(paths.inboxRoot)).toHaveLength(0);
    db.close();
  });

  it('stages repository files from Git tracked and unignored paths only', async () => {
    const { root, paths, db } = await fixture();
    const repository = join(root, 'repository');
    await fs.mkdir(repository);
    const git = (args: string[]) => runChild('git', args, { cwd: repository, timeoutMs: 10_000 });
    expect((await git(['init', '--quiet'])).code).toBe(0);
    await fs.writeFile(join(repository, '.gitignore'), 'ignored.txt\n');
    await fs.writeFile(join(repository, 'tracked.txt'), 'tracked\n');
    await fs.writeFile(join(repository, 'ignored.txt'), 'secret\n');
    await fs.mkdir(join(repository, 'nested', '.git'), { recursive: true });
    await fs.writeFile(join(repository, 'nested', '.git', 'internal'), 'internal\n');
    expect((await git(['add', '--', '.gitignore', 'tracked.txt'])).code).toBe(0);
    const sources = new SourceService(db, paths, { gitRevision: () => 'revision' });
    const staged = await sources.stage({ path: repository });
    expect(staged.kind).toBe('repository');
    expect(staged.relativePath).toMatch(/^[0-9a-f-]+\.pi-scholar$/iu);
    expect(staged.metadata).toMatchObject({ requestedKind: 'repository', kind: 'repository', repositoryRevision: 'revision', payload: 'payload' });
    const payload = join(staged.absolutePath, 'payload');
    expect((await fs.readFile(join(payload, 'tracked.txt'))).toString()).toBe('tracked\n');
    await expect(fs.lstat(join(staged.absolutePath, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(join(staged.absolutePath, '.git', 'config'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(join(staged.absolutePath, '.git', 'hooks'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(join(payload, 'ignored.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(join(payload, 'nested', '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    expect(claim.snapshot.revision).toBe('revision');
    expect(claim.snapshot.files.map((file) => file.path)).toEqual(['.gitignore', 'tracked.txt']);
    db.close();
  });

  it('rejects incomplete endpoint plans and unsafe staging', async () => {
    const { root, paths, db, sources } = await fixture();
    expect(() => validateChunkEndpoints('a\nb\n', [1])).toThrow();
    await fs.writeFile(join(root, 'outside.txt'), 'outside');
    await expect(sources.stage({ path: join(root, 'outside.txt'), name: '../escape.txt' })).rejects.toThrow();
    await fs.symlink(join(root, 'outside.txt'), join(paths.inboxRoot, 'link.txt'));
    await expect(sources.stage({ path: join(paths.inboxRoot, 'link.txt') })).rejects.toThrow();
    const controlDirectory = join(root, 'control-directory');
    await fs.mkdir(controlDirectory);
    await fs.writeFile(join(controlDirectory, `bad${String.fromCharCode(10)}name.txt`), 'bad');
    await expect(sources.stage({ path: controlDirectory })).rejects.toThrow(/invalid relative path/iu);
    const unicodeDirectory = join(root, 'unicode-directory');
    const unicodeName = 'résumé-文.txt';
    await fs.mkdir(unicodeDirectory);
    await fs.writeFile(join(unicodeDirectory, unicodeName), 'unicode');
    const staged = await sources.stage({ path: unicodeDirectory });
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    expect(claim.snapshot.files.map((file) => file.path)).toEqual([unicodeName]);
    expect(staged.kind).toBe('directory');
    db.close();
  });

  it('does not recreate a missing inbox during discovery', async () => {
    const { paths, db, sources } = await fixture();
    await fs.rm(paths.inboxRoot, { recursive: true, force: true });
    await expect(sources.discover()).rejects.toThrow(/ENOENT|inbox/iu);
    await expect(fs.lstat(paths.inboxRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    db.close();
  });
  it('rejects tampered retained packets before re-admission', async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, 'tampered.txt'), 'evidence\n');
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const result = await sources.admitClaim(claim);
    await fs.writeFile(join(result.packetPath, 'chunks', '0001.md'), 'tampered\n');
    await expect(sources.admitClaim(claim)).rejects.toThrow(/chunk digest|chunk coverage|reconstruction/iu);
    expect(db.get<{ status: string }>('SELECT status FROM sources WHERE source_id = ?', [result.sourceId])?.status).toBe('published');
    db.close();
  });
  it('reactivates a removed deterministic packet without replacing its history', async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, 'reactivate.txt'), 'evidence\n');
    const [entry] = await sources.discover();
    const claim = await sources.claim(entry);
    const result = await sources.admitClaim(claim);
    const createdAt = db.get<{ created_at: string }>('SELECT created_at FROM sources WHERE source_id = ?', [result.sourceId])?.created_at;
    if (!createdAt) throw new Error('source created_at is missing');
    const preview = sources.removalPreview(result.sourceId);
    await sources.removeConfirmed(result.sourceId, preview.confirmationId);
    db.run('UPDATE sources SET error_code = ?, error_message = ? WHERE source_id = ?', ['ADMISSION_FAILED', 'stale diagnostic', result.sourceId]);
    const reactivated = await sources.admitClaim(claim);
    const row = db.get<{ status: string; error_code: string | null; error_message: string | null; created_at: string; manifest_path: string }>('SELECT status, error_code, error_message, created_at, manifest_path FROM sources WHERE source_id = ?', [result.sourceId]);
    expect(reactivated.sourceId).toBe(result.sourceId);
    expect(row).toMatchObject({ status: 'published', error_code: null, error_message: null, created_at: createdAt, manifest_path: result.packetPath });
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
  it('previews page, card, and open-quiz dependents and restores the packet after a failed removal transaction', async () => {
    const { paths, db, sources, wiki } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, 'source.txt'), 'evidence\n');
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    const chunkId = result.manifest.chunks[0]?.chunkId;
    if (!chunkId) throw new Error('source chunk is missing');
    const page = await wiki.create({ path: 'grounded.md', body: `Grounded at ${chunkId}.\n`, quizWorthiness: 'eligible' });
    const now = new Date().toISOString();
    db.run(
      "INSERT INTO review_cards (card_id, status, prompt, initial_due_at, due_at, fsrs_state, stability, difficulty, reps, lapses, scheduled_days, last_review_at, revision, created_at, updated_at) VALUES (?, 'active', ?, ?, ?, 0, 0, 0, 0, 0, 0, NULL, 1, ?, ?)",
      ['card-removal', 'Explain the evidence', now, now, now, now],
    );
    db.run(
      'INSERT INTO card_bindings (binding_id, card_id, page_id, heading, anchor, start_offset, end_offset, text_digest, revision, active) VALUES (?, ?, ?, ?, ?, 0, 9, ?, 1, 1)',
      ['binding-removal', 'card-removal', page.page.pageId, 'Grounded', '#grounded', 'text-digest'],
    );
    const sheetPath = join(paths.quizzesRoot, '2099', '01', '2099-01-01.md');
    await fs.mkdir(join(paths.quizzesRoot, '2099', '01'), { recursive: true });
    const sheetBefore = Buffer.from('# canonical quiz\n');
    await fs.writeFile(sheetPath, sheetBefore);
    db.run(
      "INSERT INTO quizzes (quiz_id, date, revision, status, sheet_path, generated_at, submitted_at, error_code, error_message) VALUES (?, ?, 1, 'open', ?, ?, NULL, NULL, NULL)",
      ['quiz-removal', '2099-01-01', sheetPath, now],
    );
    db.run(
      'INSERT INTO quiz_questions (question_id, quiz_id, ordinal, kind, prompt, choices_json, answer_key_json, grading_criteria_json, source_refs_json) VALUES (?, ?, 0, ?, ?, NULL, NULL, ?, ?)',
      ['question-removal', 'quiz-removal', 'short-answer', 'Explain', JSON.stringify([{ cardId: 'card-removal', criterion: 'Explain', weight: 1 }]), JSON.stringify([`${page.page.pageId}#%23grounded`])],
    );
    db.run('INSERT INTO question_cards (question_id, card_id, criterion_json, weight) VALUES (?, ?, ?, ?)', ['question-removal', 'card-removal', JSON.stringify('Explain'), 1]);
    const preview = sources.removalPreview(result.sourceId);
    expect(preview.dependents.some((item) => item.page_id === page.page.pageId && item.kind === 'citation')).toBe(true);
    expect(preview.dependents.some((item) => item.card_id === 'card-removal' && item.kind === 'card')).toBe(true);
    expect(preview.dependents.some((item) => item.quiz_id === 'quiz-removal' && item.date === '2099-01-01' && item.kind === 'quiz')).toBe(true);
    const originalRun = db.run.bind(db);
    db.run = ((sql: string, parameters?: readonly unknown[]) => {
      if (sql.startsWith('UPDATE sources SET status')) throw new Error('forced removal failure');
      return originalRun(sql, parameters);
    }) as typeof db.run;
    await expect(sources.removeConfirmed(result.sourceId, preview.confirmationId)).rejects.toThrow('forced removal failure');
    expect((await fs.readFile(join(result.packetPath, 'extracted.md'))).toString()).toBe('evidence\n');
    expect((await fs.readFile(sheetPath)).equals(sheetBefore)).toBe(true);
    expect(db.get<{ status: string }>('SELECT status FROM sources WHERE source_id = ?', [result.sourceId])?.status).toBe('published');
    expect(db.get<{ status: string }>('SELECT status FROM quizzes WHERE quiz_id = ?', ['quiz-removal'])?.status).toBe('open');
    db.close();
  });
  it('restores an active packet from deterministic quarantine before recomputing removal confirmation', async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, 'crash-active.txt'), 'active\n');
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    const preview = sources.removalPreview(result.sourceId);
    const quarantineRoot = join(paths.workRoot, 'quarantine');
    const quarantine = join(quarantineRoot, `${result.sourceId}-${result.manifest.originalDigest.slice(0, 16)}`);
    await fs.mkdir(quarantineRoot, { recursive: true });
    await fs.rename(result.packetPath, quarantine);
    const removed = await sources.removeConfirmed(result.sourceId, preview.confirmationId);
    expect(removed.removed).toBe(true);
    await expect(fs.lstat(result.packetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(quarantine)).rejects.toMatchObject({ code: 'ENOENT' });
    db.close();
  });
  it('cleans a removed source quarantine and makes retries idempotent without reapplying dependents', async () => {
    const { paths, db, sources } = await fixture();
    await fs.writeFile(join(paths.inboxRoot, 'crash-removed.txt'), 'removed\n');
    const [entry] = await sources.discover();
    const result = await sources.admitClaim(await sources.claim(entry));
    const preview = sources.removalPreview(result.sourceId);
    const quarantineRoot = join(paths.workRoot, 'quarantine');
    const quarantine = join(quarantineRoot, `${result.sourceId}-${result.manifest.originalDigest.slice(0, 16)}`);
    await fs.mkdir(quarantineRoot, { recursive: true });
    await fs.rename(result.packetPath, quarantine);
    db.run('UPDATE sources SET status = ? WHERE source_id = ?', ['removed', result.sourceId]);
    const first = await sources.removeConfirmed(result.sourceId, 'ignored-after-commit');
    const second = await sources.removeConfirmed(result.sourceId, preview.confirmationId);
    expect(first.removed).toBe(true);
    expect(second.removed).toBe(true);
    expect(second.dependents).toEqual([]);
    await expect(fs.lstat(quarantine)).rejects.toMatchObject({ code: 'ENOENT' });
    db.close();
  });
});

describe('wiki mechanics', () => {
  it('keeps a host page ID across guarded rename and refreshes projections', async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: 'notes/one.md', title: 'One', body: '# One\n\nText.' });
    const renamed = await wiki.rename(created.page.pageId, 'notes/two.md');
    expect(renamed.pageId).toBe(created.page.pageId);
    expect((await wiki.get(created.page.pageId)).relativePath).toBe('notes/two.md');
    const index = await fs.readFile(join(paths.wikiRoot, 'index.md'), 'utf8');
    const log = await fs.readFile(join(paths.wikiRoot, 'log.md'), 'utf8');
    expect(index).toContain('notes/two.md');
    expect(index).not.toContain('notes/one.md');
    expect(log).toContain('notes/two.md');
    expect(log).not.toContain('notes/one.md');
    db.close();
  });
  it('rejects create over an uncataloged filesystem entry without changing it', async () => {
    const { paths, db, wiki } = await fixture();
    const target = join(paths.wikiRoot, 'untracked.md');
    const before = Buffer.from('untracked content\n');
    await fs.writeFile(target, before);
    await expect(wiki.create({ path: 'untracked.md', body: 'replacement' })).rejects.toThrow(/already exists/u);
    expect((await fs.readFile(target)).equals(before)).toBe(true);
    expect(await wiki.list()).toHaveLength(0);
    db.close();
  });

  it('rejects rename over an uncataloged filesystem entry without changing it', async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: 'notes/source.md', body: 'source' });
    const target = join(paths.wikiRoot, 'notes', 'untracked.md');
    const before = Buffer.from('untracked destination\n');
    await fs.writeFile(target, before);
    await expect(wiki.rename(created.page.pageId, 'notes/untracked.md')).rejects.toThrow(/already exists/u);
    expect((await fs.readFile(target)).equals(before)).toBe(true);
    expect((await wiki.get(created.page.pageId)).relativePath).toBe('notes/source.md');
    db.close();
  });

  it('rolls back a failed create after projection refresh', async () => {
    const { paths, db, wiki } = await fixture();
    await wiki.create({ path: 'stable.md', body: 'stable' });
    const indexPath = join(paths.wikiRoot, 'index.md');
    const logPath = join(paths.wikiRoot, 'log.md');
    const beforeIndex = await fs.readFile(indexPath);
    const beforeLog = await fs.readFile(logPath);
    const target = join(paths.wikiRoot, 'failed-create.md');
    wiki.refreshProjections = async () => { throw new Error('forced projection failure'); };
    await expect(wiki.create({ path: 'failed-create.md', body: 'temporary' })).rejects.toThrow('forced projection failure');
    await expect(fs.access(target)).rejects.toThrow();
    expect((await fs.readFile(indexPath)).equals(beforeIndex)).toBe(true);
    expect((await fs.readFile(logPath)).equals(beforeLog)).toBe(true);
    expect(await wiki.list()).toHaveLength(1);
    db.close();
  });

  it('rolls back a failed update after projection refresh', async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: 'failed-update.md', body: 'original' });
    const pagePath = join(paths.wikiRoot, 'failed-update.md');
    const snapshotPath = join(paths.metadataRoot, 'snapshots', 'wiki', `${created.page.pageId}.md`);
    const indexPath = join(paths.wikiRoot, 'index.md');
    const logPath = join(paths.wikiRoot, 'log.md');
    const beforePage = await fs.readFile(pagePath);
    const beforeSnapshot = await fs.readFile(snapshotPath);
    const beforeIndex = await fs.readFile(indexPath);
    const beforeLog = await fs.readFile(logPath);
    const beforeCatalog = db.get<Record<string, unknown>>('SELECT * FROM pages WHERE page_id = ?', [created.page.pageId]);
    const beforeAuthored = db.get<Record<string, unknown>>('SELECT * FROM authored_snapshots WHERE relative_path = ?', ['failed-update.md']);
    wiki.refreshProjections = async () => { throw new Error('forced projection failure'); };
    await expect(wiki.update(created.page.pageId, { body: 'updated', expectedDigest: created.page.digest })).rejects.toThrow('forced projection failure');
    expect((await fs.readFile(pagePath)).equals(beforePage)).toBe(true);
    expect((await fs.readFile(snapshotPath)).equals(beforeSnapshot)).toBe(true);
    expect((await fs.readFile(indexPath)).equals(beforeIndex)).toBe(true);
    expect((await fs.readFile(logPath)).equals(beforeLog)).toBe(true);
    expect(db.get<Record<string, unknown>>('SELECT * FROM pages WHERE page_id = ?', [created.page.pageId])).toEqual(beforeCatalog);
    expect(db.get<Record<string, unknown>>('SELECT * FROM authored_snapshots WHERE relative_path = ?', ['failed-update.md'])).toEqual(beforeAuthored);
    db.close();
  });

  it('rolls back a failed rename after projection refresh', async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: 'failed-rename.md', body: 'original' });
    const sourcePath = join(paths.wikiRoot, 'failed-rename.md');
    const targetPath = join(paths.wikiRoot, 'renamed-after-failure.md');
    const snapshotPath = join(paths.metadataRoot, 'snapshots', 'wiki', `${created.page.pageId}.md`);
    const indexPath = join(paths.wikiRoot, 'index.md');
    const logPath = join(paths.wikiRoot, 'log.md');
    const beforePage = await fs.readFile(sourcePath);
    const beforeSnapshot = await fs.readFile(snapshotPath);
    const beforeIndex = await fs.readFile(indexPath);
    const beforeLog = await fs.readFile(logPath);
    const beforeCatalog = db.get<Record<string, unknown>>('SELECT * FROM pages WHERE page_id = ?', [created.page.pageId]);
    const beforeAuthored = db.get<Record<string, unknown>>('SELECT * FROM authored_snapshots WHERE relative_path = ?', ['failed-rename.md']);
    wiki.refreshProjections = async () => { throw new Error('forced projection failure'); };
    await expect(wiki.rename(created.page.pageId, 'renamed-after-failure.md')).rejects.toThrow('forced projection failure');
    expect((await fs.readFile(sourcePath)).equals(beforePage)).toBe(true);
    await expect(fs.access(targetPath)).rejects.toThrow();
    expect((await fs.readFile(snapshotPath)).equals(beforeSnapshot)).toBe(true);
    expect((await fs.readFile(indexPath)).equals(beforeIndex)).toBe(true);
    expect((await fs.readFile(logPath)).equals(beforeLog)).toBe(true);
    expect(db.get<Record<string, unknown>>('SELECT * FROM pages WHERE page_id = ?', [created.page.pageId])).toEqual(beforeCatalog);
    expect(db.get<Record<string, unknown>>('SELECT * FROM authored_snapshots WHERE relative_path = ?', ['failed-rename.md'])).toEqual(beforeAuthored);
    db.close();
  });

  it('keeps semantic drift unresolved and excludes it from live lexical search', async () => {
    const { db, wiki } = await fixture();
    const created = await wiki.create({ path: 'semantic-drift.md', body: 'authored text' });
    db.run("UPDATE pages SET status = 'drifted' WHERE page_id = ?", [created.page.pageId]);
    const report = await wiki.inspectDrift(created.page.pageId);
    expect(report.drifted).toBe(true);
    expect(report.page.status).toBe('drifted');
    expect(await wiki.lexicalSearch('authored')).toHaveLength(0);
    await expect(wiki.resolveDrift(created.page.pageId, 'restore')).rejects.toThrow(/semantic drift requires maintenance correction/u);
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

  it('rolls back drift restoration, projections, snapshots, catalog, and issue on failure', async () => {
    const { paths, db, wiki } = await fixture();
    const created = await wiki.create({ path: 'rollback-drift.md', body: 'authored' });
    await fs.appendFile(join(paths.wikiRoot, 'rollback-drift.md'), '\nunsupported edit');
    const pagePath = join(paths.wikiRoot, 'rollback-drift.md');
    const snapshotPath = join(paths.metadataRoot, 'snapshots', 'wiki', `${created.page.pageId}.md`);
    const indexPath = join(paths.wikiRoot, 'index.md');
    const logPath = join(paths.wikiRoot, 'log.md');
    const beforePage = await fs.readFile(pagePath);
    const beforeSnapshot = await fs.readFile(snapshotPath);
    const beforeIndex = await fs.readFile(indexPath);
    const beforeLog = await fs.readFile(logPath);
    const beforeCatalog = db.get<Record<string, unknown>>('SELECT * FROM pages WHERE page_id = ?', [created.page.pageId]);
    const beforeAuthored = db.get<Record<string, unknown>>('SELECT * FROM authored_snapshots WHERE relative_path = ?', ['rollback-drift.md']);
    wiki.refreshProjections = async () => { throw new Error('forced projection failure'); };
    await expect(wiki.resolveDrift(created.page.pageId, 'record-issue')).rejects.toThrow('forced projection failure');
    expect((await fs.readFile(pagePath)).equals(beforePage)).toBe(true);
    expect((await fs.readFile(snapshotPath)).equals(beforeSnapshot)).toBe(true);
    expect((await fs.readFile(indexPath)).equals(beforeIndex)).toBe(true);
    expect((await fs.readFile(logPath)).equals(beforeLog)).toBe(true);
    expect(db.get<Record<string, unknown>>('SELECT * FROM pages WHERE page_id = ?', [created.page.pageId])).toEqual(beforeCatalog);
    expect(db.get<Record<string, unknown>>('SELECT * FROM authored_snapshots WHERE relative_path = ?', ['rollback-drift.md'])).toEqual(beforeAuthored);
    expect(db.all('SELECT * FROM wiki_issues WHERE page_id = ?', [created.page.pageId])).toHaveLength(0);
    db.close();
  });

  it('rejects standalone issue resolution and permits reopening only', async () => {
    const { db, wiki } = await fixture();
    const page = await wiki.create({ path: 'issue.md', body: 'text' });
    const issue = await wiki.report({ pageId: page.page.pageId, description: 'unclear' });
    await expect(wiki.patchIssue(issue.issueId, { status: 'resolved' })).rejects.toThrow();
    const reopened = await wiki.patchIssue(issue.issueId, { status: 'reopened', resolution: 'Needs a composite correction.' });
    expect(reopened.status).toBe('reopened');
    db.close();
  });

  it('resolves an issue only after a corrected page and related card binding pass together', async () => {
    const { db, paths } = await fixture();
    const app = new ScholarApplication({
      paths,
      db,
      adapters: { wiki: { qmd: { search: () => [], index: async () => undefined } } },
      doctor: () => ({ ok: true, checkedAt: new Date().toISOString(), checks: [] }),
      commit: (_paths, subject) => ({ committed: false, subject }),
    });
    try {
      const originalBody = '# Section\n\noriginal\n';
      const correctedSection = '# Section\n\ncorrected\n';
      const page = await app.wiki.create({ path: 'composite.md', body: originalBody, quizWorthiness: 'eligible' });
      const issue = await app.wiki.report({ pageId: page.page.pageId, heading: 'Section', description: 'The section is wrong.' });
      const binding = (anchor: string) => ({
        pageId: page.page.pageId,
        heading: 'Section',
        anchor,
        startOffset: 900,
        endOffset: 901,
        textDigest: 'model-supplied-digest',
        pageDigest: 'model-supplied-page-digest',
        pageRevision: 99,
        sectionText: correctedSection,
      });
      const proposal = (body: string, anchor: string, cardId: string) => ({
        kind: 'resolve-issue' as const,
        issueId: issue.issueId,
        page: { pageId: page.page.pageId, expectedDigest: page.page.digest, body },
        card: { kind: 'create-card' as const, cardId, dueAt: '2030-01-01T00:00:00.000Z', bindings: [binding(anchor)] },
        resolution: 'Corrected the section and refreshed its review card.',
      });
      await expect(app.applyMaintenance(proposal(originalBody, '#section', 'no-op-card'))).rejects.toThrow(/actual page correction/u);
      await expect(app.applyMaintenance(proposal(correctedSection, '#unrelated', 'wrong-section-card'))).rejects.toThrow(/corrected issue section/u);
      expect((await app.wiki.get(page.page.pageId)).content).toContain('original');
      expect((await app.listIssues()).issues.find((item) => item.issueId === issue.issueId)?.status).toBe('open');
      expect(app.scheduler.listCards(false)).toHaveLength(0);

      const applied = await app.applyMaintenance(proposal(correctedSection, '#section', 'corrected-card'));
      expect(applied.issue?.status).toBe('resolved');
      expect((await app.wiki.get(page.page.pageId)).content).toContain('corrected');
      expect((await app.wiki.get(page.page.pageId)).revision).toBe(2);
      expect(app.scheduler.bindings('corrected-card')[0]).toMatchObject({ pageId: page.page.pageId, anchor: '#section', startOffset: 0, endOffset: correctedSection.length });
      const beforeBlockedUpdate = await app.wiki.get(page.page.pageId);
      const bindingBeforeRename = app.scheduler.bindings('corrected-card')[0];
      await expect(app.updateNote(page.page.pageId, { body: '# Section\n\ndirect stale binding candidate\n' })).rejects.toThrow(/active card bindings stale/u);

      await expect(app.applyMaintenance({
        kind: 'update-page',
        pageId: page.page.pageId,
        expectedDigest: beforeBlockedUpdate.digest,
        body: '# Section\n\nstale binding candidate\n',
      })).rejects.toThrow(/active card bindings stale/u);
      expect((await app.wiki.get(page.page.pageId)).content).toContain('corrected');
      const renamed = await app.applyMaintenance({
        kind: 'rename-page',
        pageId: page.page.pageId,
        expectedDigest: beforeBlockedUpdate.digest,
        path: 'composite-renamed.md',
      });
      expect(renamed.page?.relativePath).toBe('composite-renamed.md');
      expect((await app.wiki.get(page.page.pageId)).digest).toBe(beforeBlockedUpdate.digest);
      expect(app.scheduler.bindings('corrected-card')[0]).toEqual(bindingBeforeRename);
    } finally {
      await app.close();
      db.close();
    }
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
  it('accepts exact qmd collection file URIs, skips control docs, and rejects malformed results', async () => {
    const { paths, db } = await fixture();
    const collection = `pi-scholar-${paths.vaultId}`;
    const valid = `qmd://${collection}/notes.md`;
    const invalidResults: unknown[] = [
      { file: `qmd://${collection}/%2e%2e/encoded-secret.md` },
      { file: `qmd://${collection}/../secret.md` },
      { file: `qmd://${collection}/notes%2Fsecret.md` },
      { file: `qmd://pi-scholar-00000000-0000-4000-8000-000000000000/notes.md` },
      { file: `qmd://${collection}/%ZZ.md` },
      { file: `qmd://${collection}/notes.md?token=secret` },
      { file: `qmd://${collection}:4816/notes.md` },
      { path: '../secret.md' },
      {},
      null,
      'notes.md',
    ];
    const semantic = new WikiService(db, paths, { qmd: { search: () => [] } });
    await semantic.create({ path: 'notes.md', body: 'semantic text' });
    for (const invalid of invalidResults) {
      const unsafe = new WikiService(db, paths, { qmd: { search: () => [invalid] } });
      await expect(unsafe.semanticSearch('semantic')).rejects.toThrow();
    }
    const trusted = new WikiService(db, paths, { qmd: { search: () => [{ path: 'index.md' }, { path: 'log.md' }, { file: valid }] } });
    const found = await trusted.semanticSearch('semantic');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ file: valid, path: 'notes.md' });
    const app = new ScholarApplication({ paths, db, wikiService: trusted });
    expect((await app.searchWiki('semantic', { mode: 'semantic' })).pages).toHaveLength(1);
    await app.close();
    db.close();
  });

  it('rejects executable HTML rather than rendering imported markup', async () => {
    const { db, wiki } = await fixture();
    expect(isExecutableHtml('<script>alert(1)</script>')).toBe(true);
    await expect(wiki.create({ path: 'unsafe.md', body: '<script>alert(1)</script>' })).rejects.toThrow();
    db.close();
  });
});
