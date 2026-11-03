import { afterEach, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { registerOfflineFixtureRoot } from './offline-fixtures.js';
import { isolatedBuildEnvironment } from '../src/build-environment.js';
import { generateCandidate } from '../src/release-candidate-update.js';
import { GitHub } from 'release-please/build/src/github.js';
import { FileNotFoundError } from 'release-please/build/src/errors/index.js';
import { setLogger } from 'release-please/build/src/util/logger.js';
import { releaseProtectionFixture } from './fixtures/release-protection.js';

// This scenario includes many durable state commits and five independent wakes, including merged-source handoff.
// Individual production Git operations retain their existing 30/60/90 second bounds.
vi.setConfig({ testTimeout: process.platform === 'win32' ? 480_000 : 160_000 });
setLogger({ debug() {}, info() {}, warn() {}, error() {}, trace() {} });
const { nativeReleaseCandidate } = await import(pathToFileURL(resolve('scripts/release-candidate.mjs')).href);
const { readReleaseRecords } = await import(pathToFileURL(resolve('scripts/release-record.mjs')).href);
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('runs the native candidate adapter through protected state, real Git, upstream generation, fake SDK and same-PR editing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'candidate-native-test-')); roots.push(root); registerOfflineFixtureRoot(root);
  const directory = join(root, 'source'), remote = join(root, 'remote.git'); await mkdir(directory);
  const env = isolatedBuildEnvironment(process.env, root), identity = { name: 'Fixture', email: 'fixture@example.invalid' };
  const git = async (...args: string[]) => (await promisify(execFile)('git', args, { cwd: directory, env, encoding: 'utf8', windowsHide: true })).stdout.trim();
  await git('init', '--initial-branch=main'); await git('config', 'user.name', identity.name); await git('config', 'user.email', identity.email);
  await mkdir(join(directory, '.github'));
  const config = { 'separate-pull-requests': false, 'include-component-in-tag': false, packages: { '.': { 'release-type': 'simple', 'version-file': 'VERSION' } } };
  const delivery = { schemaVersion: 1, units: [{ id: 'app', path: '.', notesPath: '.release-notes/app.md',
    assets: [{ id: 'app', name: 'app-${version}.zip', mediaType: 'application/zip' }], channels: [] }], repositoryAuthors: [{ id: 7, evidence: 'offline explicit authorship record' }] };
  for (const [path, text] of Object.entries({ 'README.md': '# 应用\n\n公开使用说明。\n', 'VERSION': '0.0.0\n', 'release-please-config.json': JSON.stringify(config),
    '.release-please-manifest.json': '{".":"0.0.0"}', '.github/delivery.json': JSON.stringify(delivery), 'code.txt': '功能实现\n' })) await writeFile(join(directory, path), text);
  await git('add', '.'); await git('commit', '--signoff', '-m', 'feat: initial product'); const B = await git('rev-parse', 'HEAD');
  await git('init', '--bare', remote); await git('push', '--porcelain', remote, 'HEAD:refs/heads/main');
  await git('switch', '--orphan', 'steward/release-state');
  const repository = { schemaVersion: 3, releaseAdoption:{sourceSha:'a'.repeat(40),prNumber:1}, repositoryId: 1, defaultBranch: 'main', revision: 0, lastObservedDefaultSha: B, lastCompletedCycleId: null,
    activeCycleId: null, candidate: null, nextCheckAt: null, lastProgressAt: null, lastErrorCode: null };
  await writeFile(join(directory, 'state.json'), JSON.stringify(repository) + '\n'); await git('add', '--', 'state.json'); await git('commit', '--signoff', '-m', 'Initial state');
  await git('push', '--porcelain', remote, 'HEAD:refs/heads/steward/release-state'); await git('switch', 'main');
  const requests: { method: string; path: string; body: any }[] = [], comments: any[] = []; let pr: any = null, modelCalls = 0;
  const head = async (branch: string) => { try { return await git('-C', remote, 'rev-parse', '--verify', `refs/heads/${branch}`); } catch { return null; } };
  const fetcher = (async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', path = decodeURIComponent(url.pathname), body = init?.body ? JSON.parse(String(init.body)) : null;
    requests.push({ method, path, body }); expect(url.origin).toBe('https://api.github.com'); let value: any;
    if (method === 'GET' && (path.includes('/git/ref/heads/') || path.endsWith('/pulls')))
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer fixture-read');
    if (path.includes('/git/ref/heads/')) { const branch = path.split('/git/ref/heads/')[1]!, sha = await head(branch); if (!sha) return new Response('{}', { status: 404 }); value = { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } }; }
    else if (path.endsWith('/rules/branches/main')) value = [{ type: 'non_fast_forward' }, { type: 'deletion' }];
    else if (releaseProtectionFixture(path)) value = releaseProtectionFixture(path);
    else if (path.endsWith('/rulesets/6')) value = { id: 6, target: 'tag', enforcement: 'active', conditions: { ref_name: { include: ['~ALL'], exclude: [] } }, rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] };
    else if (path.endsWith('/rulesets')) value = [{ id: 6, target: 'tag', enforcement: 'active' }];
    else if (path.endsWith('/releases') || path.endsWith('/tags')) value = [];
    else if (path.endsWith('/actions/workflows')) {
      // Private workflow inventory needs Actions read, held only by the trusted parent credential.
      if (new Headers(init?.headers).get('authorization') !== 'Bearer fixture-write')
        return new Response('{}', { status: 403 });
      value = { total_count: 0, workflows: [] };
    }
    else if (path.endsWith('/pulls') && method === 'POST') {
      pr = { number: 9, head: { repo: { id: 1 }, ref: body.head, sha: await head(body.head) }, base: { ref: 'main', repo: { id: 1 } }, state: 'open', merged_at: null, labels: [], title: body.title, body: body.body };
      throw new Error('accepted create response lost');
    } else if (path.endsWith('/pulls')) { if (pr) pr.head.sha = await head(pr.head.ref); value = pr && (url.searchParams.get('state') !== 'open' || pr.state === 'open') ? [pr] : []; }
    else if (path.endsWith('/pulls/9')) value = pr;
    else if (path.endsWith('/issues/9/events')) value = [{ id: 12, event: 'merged', url: 'https://api.github.com/repos/fixture/product/issues/events/12',
      commit_id: await head('main'), commit_url: `https://api.github.com/repos/fixture/product/commits/${await head('main')}`, actor: { id: 7 }, created_at: '2026-10-27T00:00:01Z' }];
    else if (/\/commits\/[a-f0-9]{40}$/.test(path)) value = { sha: path.split('/').at(-1), author: { id: 42, login: 'contributor' }, committer: { id: 7, login: 'author' } };
    else if (path.startsWith('/users/')) { const login = path.split('/').at(-1)!; value = { id: login === 'author' ? 7 : 42, login, type: 'User', html_url: `https://github.com/${login}`, avatar_url: `https://avatars.githubusercontent.com/u/${login === 'author' ? 7 : 42}` }; }
    else if (path.endsWith('/issues/9/comments') && method === 'GET') value = comments;
    else if (path.endsWith('/issues/9/comments') && method === 'POST') { value = { id: 1, user: { id: 301115370 }, body: body.body }; comments.push(value); }
    else if (path.endsWith('/issues/comments/1') && method === 'PATCH') { comments[0].body = body.body; value = comments[0]; }
    else throw new Error('Unregistered native candidate fixture: ' + method + ' ' + path);
    return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const generator = async (request: any) => {
    const client = Object.assign(Object.create(GitHub.prototype), {
      repository: { owner: 'fixture', repo: 'product', defaultBranch: 'main' }, logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
      getFileJson: async (path: string) => JSON.parse(await git('show', `${B}:${path}`)),
      getFileContentsOnBranch: async (path: string) => { let content; try { content = await git('show', `${B}:${path}`); } catch { throw new FileNotFoundError(path); }
        return { content: Buffer.from(content).toString('base64'), parsedContent: content, sha: 'b'.repeat(40), mode: '100644' }; },
      mergeCommitIterator: async function* () { yield { sha: B, message: 'feat: initial product', files: ['code.txt'] }; },
      releaseIterator: async function* () {}, tagIterator: async function* () {}, pullRequestIterator: async function* () {},
    });
    return generateCandidate(B, { configPath: 'release-please-config.json', manifestPath: '.release-please-manifest.json', units: request.units, readFacts: async () => request.facts, createReadClient: async () => client });
  };
  const language = { preflight: async () => 'READY', call: async (text: string) => {
    modelCalls++; const input = JSON.parse(text);
    return { text: JSON.stringify(input.stage === 'COMPOSE' ? { paragraphs: input.items.map((i: any) => ({ sourceIds: i.sourceIds, section: i.section, textZh: i.statementZh, qualification: i.qualification })) }
      : { items: input.sources.map((s: any) => ({ sourceIds: [s.id], visibility: s.encoding === 'gap' ? 'UNRESOLVED' : 'USER', section: 'changes', statementZh: '本次提供功能实现及使用资料。', qualification: s.encoding === 'gap' ? 'UNVERIFIED' : 'SOURCE_CONFIRMED' })) }), model: 'offline-fixture', usage: { inputTokens: 100, outputTokens: 50 } };
  } };
  const request = { directory, writeDirectory: join(root, 'writes'), remote, repository: 'fixture/product', repositoryId: 1, defaultBranch: 'main', appBotId: 301115370, identity };
  await mkdir(request.writeDirectory);
  const options = { token: 'fixture-write', readToken: 'fixture-read', controllerSha: 'f'.repeat(40), fetcher, generator, language, temporaryRoot: root, now: () => '2026-10-27T00:00:00Z' };
  const refresh = async () => { await git('fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/heads/steward/release-state'); await git('update-ref', 'refs/heads/steward/release-state', await git('rev-parse', 'FETCH_HEAD')); };
  expect(await nativeReleaseCandidate(request, options)).toMatchObject({ status: 'READY', prNumber: 9 });
  const firstHead = await head('steward/release-candidate'), firstCalls = modelCalls; expect(firstCalls).toBeGreaterThan(0); await refresh();
  const identityCalls = requests.filter(r => /\/commits\/|\/users\//.test(r.path)).length;
  pr.title = '人工修改标题'; pr.body = '人工修改正文'; pr.labels = [{ name: 'release:editing' }];
  expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'edit-writes') }, options)).toMatchObject({ reason: 'EDITING', head: firstHead });
  expect(modelCalls).toBe(firstCalls); expect(await head('steward/release-candidate')).toBe(firstHead); await refresh();
  const state = await readReleaseRecords({ directory, targetRef: 'steward/release-state', repositoryId: 1 });
  expect(state.repository.candidate.editingAckHead).toBe(firstHead); expect(state.repository.candidate.prNumber).toBe(9);
  await git('fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/heads/steward/release-candidate');
  await git('switch', '-c', 'reviewed-notes', 'FETCH_HEAD');
  const reviewedNotes = (await git('show', 'HEAD:.release-notes/app.md')).replace('## 概述', '## 概述\n\n人工审核说明。').replace(/\n/g, '\r\n') + '\r\n';
  await writeFile(join(directory, '.release-notes/app.md'), reviewedNotes);
  await git('add', '--', '.release-notes/app.md'); await git('commit', '--signoff', '-m', 'docs: review candidate notes');
  const humanHead = await git('rev-parse', 'HEAD'); await git('push', '--porcelain', remote, 'HEAD:refs/heads/steward/release-candidate');
  pr.head.sha = humanHead; await git('switch', 'main');
  pr.labels = []; pr.state = 'closed';
  expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'closed-writes') }, options)).toMatchObject({ reason: 'CLOSED_PR' });
  pr.state = 'open';
  expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'reopened-writes') }, options)).toMatchObject({ status: 'READY', prNumber: 9 });
  expect(await head('steward/release-candidate')).toBe(humanHead); expect(modelCalls).toBe(firstCalls);
  expect(await git('show', `${humanHead}:.release-notes/app.md`)).toBe(reviewedNotes.trim());
  expect(requests.filter(r => /\/commits\/|\/users\//.test(r.path))).toHaveLength(identityCalls);
  expect(comments[0].body).toContain('github.com&#x2F;contributor'); expect(comments[0].body).not.toContain('github.com&#x2F;author');
  expect(pr.title).toBe('人工修改标题'); expect(pr.body).toBe('人工修改正文');
  expect(requests.filter(r => r.method === 'POST' && r.path.endsWith('/pulls'))).toHaveLength(1);
  expect(requests.filter(r => r.method === 'PATCH').every(r => r.path.endsWith('/issues/comments/1'))).toBe(true);
  await refresh();
  await git('fetch', '--no-tags', '--no-recurse-submodules', remote, 'refs/heads/steward/release-candidate');
  await git('merge', '--ff-only', 'FETCH_HEAD'); await git('push', '--porcelain', remote, 'HEAD:refs/heads/main');
  const S = await git('rev-parse', 'HEAD'); pr.state = 'closed'; pr.merged = true; pr.merged_at = '2026-10-27T00:00:00Z';
  pr.url = 'https://api.github.com/repos/fixture/product/pulls/9'; pr.base.repo.full_name = 'fixture/product';
  const readsBeforeMerge = requests.length;
  expect(await nativeReleaseCandidate({ ...request, writeDirectory: join(root, 'merge-writes') }, options)).toMatchObject({ status: 'CYCLE_READY', sourceSha: S, cycleId: `pr-9-${S}` });
  expect(modelCalls).toBe(firstCalls); await refresh();
  const merged = await readReleaseRecords({ directory, targetRef: 'steward/release-state', repositoryId: 1 });
  expect(merged.repository.activeCycleId).toBe(`pr-9-${S}`);
  expect(merged.cycles[0].value.units[0]).toMatchObject({ releaseId: null, manifestDigest: null });
  expect(requests.slice(readsBeforeMerge).some(r => r.method !== 'GET' || /\/(?:releases|tags)$/.test(r.path))).toBe(false);
});
