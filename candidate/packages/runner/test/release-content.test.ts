import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { planContentBatches, resumeContentBatches, assembleUnitNotes, contentWireInput, type ContentSource, type ContentRuntime, type ContentCache, type ContentWork } from '../src/release-content.js';
import { splitContentText, verifyContentCoverage, validateContentResult, validateContentInput, releaseAffectedUnitIds, type ContentInput, type ContentItem } from '../../core/src/release-content.js';

const digest = (v: string) => createHash('sha256').update(v).digest('hex');
const input = (): ContentInput => ({ schemaVersion: 1, repositoryId: 1, candidateId: digest('candidate'), baseSha: 'a'.repeat(40), controllerSha: 'b'.repeat(40),
  configDigest: digest('config'), sourceManifestDigest: digest('manifest'), units: [{ id: 'app', path: '.', version: '1.1.0', tag: 'v1.1.0' }],
  boundaries: [{ unitId: 'app', kind: 'full-tree', sha: null, reference: null }], batches: [] });
function source(n: number, stage: 'CONTEXT' | 'DIFF' = 'DIFF'): ContentSource {
  return { id: digest(`${n}`), unitId: 'app', path: `${n}.ts`, previousPath: null, status: 'A:after', oid: 'c'.repeat(40), mode: '100644', byteLength: 6,
    encoding: 'utf8', sha256: digest('示例'), start: 0, end: 6, text: '示例', stage };
}
const item = (sourceIds: string[]): ContentItem => ({ sourceIds, visibility: 'USER', section: 'changes', statementZh: '增加使用说明，适用于当前版本。', qualification: 'SOURCE_CONFIRMED' });
function runtime() {
  let time = Date.parse('2026-10-27T00:00:00Z'), calls = 0, editing = false;
  const saves: ContentWork[] = [], requests: string[] = [];
  const port: ContentRuntime = {
    now: () => new Date(time).toISOString(), editing: async () => editing, preflight: async () => 'READY',
    save: async (work, _cache) => { validateContentInput(work.input); saves.push(structuredClone(work)); },
    call: async text => {
      calls++; requests.push(text); const payload = JSON.parse(text);
      return { text: JSON.stringify(payload.stage === 'COMPOSE' ? { paragraphs: payload.items.map((i: ContentItem) => ({ sourceIds: i.sourceIds, section: i.section, textZh: i.statementZh, qualification: i.qualification })) }
        : { items: payload.sources.map((s: ContentSource) => item([s.id])) }), model: 'offline-fixture', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  return { port, saves, requests, calls: () => calls, advance: (ms: number) => { time += ms; }, edit: () => { editing = true; } };
}
it('retains continuous UTF-8 bytes for large Unicode text without truncation', () => {
  const text = '中文🙂\n'.repeat(10000), pieces = splitContentText(text, 101);
  expect(pieces.map(p => p.text).join('')).toBe(text); verifyContentCoverage(Buffer.byteLength(text), pieces);
  expect(pieces.every(p => Buffer.byteLength(p.text) <= 101)).toBe(true);
  expect(() => verifyContentCoverage(Buffer.byteLength(text), pieces.slice(1))).toThrow('CONTENT_BYTE_GAP');
});
it('requires closed Chinese output, exact sources and accurate test certainty', () => {
  const id = source(1).id;
  expect(() => validateContentResult('DIFF', JSON.stringify({ items: [item([id])], nextAction: 'write' }), [id])).toThrow('CONTENT_OUTPUT_SCHEMA');
  expect(() => validateContentResult('DIFF', JSON.stringify({ items: [item([source(2).id])] }), [id])).toThrow('CONTENT_SOURCE_UNKNOWN');
  expect(() => validateContentResult('DIFF', JSON.stringify({ items: [{ ...item([id]), qualification: 'TEST_CONFIRMED' }] }), [id])).toThrow('CONTENT_TEST_EVIDENCE_REQUIRED');
  expect(() => validateContentResult('DIFF', JSON.stringify({ items: [item([id])] }), [id, source(2).id])).toThrow('CONTENT_SOURCE_COVERAGE');
});
it('runs CONTEXT before DIFF and COMPOSE, persists SENT before calls and assembles seven sections', async () => {
  const work = await planContentBatches(input(), [source(1, 'CONTEXT'), source(2)]), cache = {}, r = runtime();
  expect(await resumeContentBatches(work, cache, r.port)).toEqual({ status: 'READY', calls: 3 });
  expect(r.requests.map(s => JSON.parse(s).stage)).toEqual(['CONTEXT', 'DIFF', 'COMPOSE']);
  expect(JSON.parse(r.requests[1]!).background).toHaveLength(1);
  expect(r.saves.filter(w => w.input.batches.some(b => b.status === 'RUNNING')).length).toBe(3);
  const notes = assembleUnitNotes(work)[0]!; expect(notes.content.match(/^## /gm)).toHaveLength(7); expect(notes.path).toBe('.release-notes/app.md');
  expect(await resumeContentBatches(work, cache, r.port)).toEqual({ status: 'READY', calls: 0 });
  const next = await planContentBatches({ ...input(), baseSha: 'd'.repeat(40) }, [source(1, 'CONTEXT'), source(2)]);
  expect(await resumeContentBatches(next, cache, r.port)).toEqual({ status: 'READY', calls: 0 });
});
it('retains unknown attempts and retry delays across a base change, stops at three', async () => {
  let work = await planContentBatches(input(), [source(1)]); const cache: ContentCache = {}, r = runtime();
  r.port.call = async () => { throw new Error('lost network response'); };
  expect((await resumeContentBatches(work, cache, r.port)).calls).toBe(1);
  expect(work.input.batches[0]!.attempts[0]!.status).toBe('UNKNOWN');
  work = await planContentBatches({ ...input(), baseSha: 'd'.repeat(40) }, [source(1)]);
  expect((await resumeContentBatches(work, cache, r.port)).calls).toBe(0);
  r.advance(60_000); expect((await resumeContentBatches(work, cache, r.port)).calls).toBe(1);
  r.advance(300_000); expect(await resumeContentBatches(work, cache, r.port)).toEqual({ status: 'FAILED', calls: 1 });
  const another = await planContentBatches({ ...input(), baseSha: 'e'.repeat(40) }, [source(1)]);
  expect(await resumeContentBatches(another, cache, r.port)).toEqual({ status: 'FAILED', calls: 0 });
});
it('a restart with SENT consumes one attempt; editing lets the active response archive only', async () => {
  const work = await planContentBatches(input(), [source(1, 'CONTEXT'), source(2)]), cache: ContentCache = {}, r = runtime();
  const original = r.port.call; r.port.call = async text => { const result = await original(text); r.edit(); return result; };
  expect(await resumeContentBatches(work, cache, r.port)).toEqual({ status: 'EDITING', calls: 1 });
  expect(work.input.batches[0]!.status).toBe('READY'); expect(work.input.batches[1]!.attempts).toHaveLength(0);
  const pending = work.input.batches[1]!; pending.status = 'RUNNING'; pending.attempts = [{ ordinal: 1, startedAt: r.port.now(), status: 'SENT', model: 'offline', usage: null, errorCode: null }];
  await resumeContentBatches(work, cache, r.port); expect(pending.attempts[0]!.status).toBe('UNKNOWN');
});
it('capacity splits only the fixed ordered sources and retains parent attempts', async () => {
  const work = await planContentBatches(input(), [source(1), source(2), source(3)]), cache = {}, r = runtime(), normal = r.port.call;
  let first = true; r.port.call = async text => { if (first) { first = false; throw new Error('CONTENT_CAPACITY'); } return normal(text); };
  expect((await resumeContentBatches(work, cache, r.port)).status).toBe('READY');
  const parent = work.input.batches[0]!; expect(parent.status).toBe('SUPERSEDED'); expect(parent.attempts).toHaveLength(1); expect(parent.childIds).toHaveLength(2);
  const childIds = work.input.batches.filter(b => b.parentId === parent.id).flatMap(b => b.sourceIds);
  expect([...childIds].sort()).toEqual(parent.sourceIds); expect(Object.values(work.payloads).every(p => Buffer.byteLength(contentWireInput(p)) <= 24 * 1024)).toBe(true);
  const next = await planContentBatches({ ...input(), baseSha: 'd'.repeat(40) }, [source(1), source(2), source(3)]);
  expect(await resumeContentBatches(next, cache, r.port)).toEqual({ status: 'READY', calls: 0 });
  expect(next.input.batches[0]!.attempts).toHaveLength(1);
});
it('preflight authentication and quota waits spend no model calls', async () => {
  for (const status of ['WAIT_AUTH', 'WAIT_QUOTA'] as const) {
    const work = await planContentBatches(input(), [source(1)]), r = runtime(); r.port.preflight = async () => status;
    expect(await resumeContentBatches(work, {}, r.port)).toEqual({ status, calls: 0 }); expect(work.input.batches[0]!.attempts).toHaveLength(0);
  }
});
it('limits one wake to ten calls and eighteen minutes without dropping remaining work', async () => {
  const sources = Array.from({ length: 40 }, (_, i) => ({ ...source(i), text: '中'.repeat(2000) }));
  const work = await planContentBatches(input(), sources), r = runtime();
  expect(await resumeContentBatches(work, {}, r.port)).toEqual({ status: 'WAIT', calls: 10 });
  const second = await planContentBatches(input(), sources), clocked = runtime(), normal = clocked.port.call;
  clocked.port.call = async text => { clocked.advance(18 * 60_000); return normal(text); };
  expect(await resumeContentBatches(second, {}, clocked.port)).toEqual({ status: 'WAIT', calls: 1 });
});
it('propagates shared roots and workspace dependencies while composing each unit separately', async () => {
  const units=[{id:'app',path:'packages/app'},{id:'lib',path:'packages/lib'},{id:'other',path:'packages/other'}];
  expect(releaseAffectedUnitIds('packages/lib/api.ts',units,{app:['lib']})).toEqual(['app','lib']);
  expect(releaseAffectedUnitIds('README.md',units,{app:['lib']})).toEqual(['app','lib','other']);
  const modelInput={...input(),units:[input().units[0]!,{id:'lib',path:'lib',version:'2.0.0',tag:'lib-v2.0.0'}],
    boundaries:[...input().boundaries,{unitId:'lib',kind:'full-tree',sha:null,reference:null}]};
  const work=await planContentBatches(modelInput,[source(1),{...source(2),unitId:'lib'}]),r=runtime();
  expect((await resumeContentBatches(work,{},r.port)).status).toBe('READY');
  expect(r.requests.map(text=>JSON.parse(text)).every(p=>p.unitIds.length===1)).toBe(true);
  expect(work.input.batches.filter(b=>b.stage==='COMPOSE').map(b=>b.unitIds)).toEqual([['app'],['lib']]);
});
