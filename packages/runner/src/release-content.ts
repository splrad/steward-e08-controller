import { createHash } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { freezeReleaseGitInput, type GitReleaseInputOptions } from './release-git-input.js';
import { CONTENT_PROMPT, CONTENT_SECTIONS, sourceId, splitContentText, verifyContentCoverage, validateContentResult,
  validateContentInput, renderUnitContent, releaseAffectedUnitIds, utf8Length, type ContentInput, type ContentBatch, type ContentItem, type ContentParagraph,
  type ContentAttempt, type ContentStage, type Qualification } from '../../core/src/release-content.js';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ContentSource {
  id: string; unitId: string; path: string; previousPath: string | null; status: string; oid: string;
  mode: string; byteLength: number; encoding: string; sha256: string; start: number; end: number;
  text: string; stage: 'CONTEXT' | 'DIFF';
}
export interface ContentPayload { stage: ContentStage; unitIds: string[]; units: ContentInput['units']; sources: ContentSource[]; items: ContentItem[]; background: ContentItem[] }
export interface ContentWork { input: ContentInput; payloads: Record<string, ContentPayload>; results: Record<string, { items: ContentItem[] } | { paragraphs: ContentParagraph[] }>; evidence: { manifests: unknown[]; gaps: unknown[] } }
export interface ContentCacheEntry { inputDigest: string; configDigest: string; attempts: ContentAttempt[]; result: { items: ContentItem[] } | { paragraphs: ContentParagraph[] } | null; split: boolean }
export type ContentCache = Record<string, ContentCacheEntry>;
export function contentWireInput(payload: ContentPayload) { return JSON.stringify({ prompt: CONTENT_PROMPT, ...payload }); }
const ids = (payload: ContentPayload) => [...new Set([...payload.sources.map(s => s.id), ...payload.items.flatMap(i => i.sourceIds)])].sort();
const cacheKey = (inputDigest: string, configDigest: string) => hash([inputDigest, configDigest]);
async function batchFor(input: ContentInput, payload: ContentPayload, parentId: string | null = null): Promise<ContentBatch> {
  if (utf8Length(contentWireInput(payload)) > 24 * 1024) throw new Error('CONTENT_INPUT_LIMIT');
  const inputDigest = hash(payload), sourceIds = ids(payload);
  return { id: hash([input.candidateId, input.configDigest, inputDigest, parentId]), stage: payload.stage, unitIds: payload.unitIds,
    sourceIds, inputDigest, status: 'PENDING', attempts: [], nextCheckAt: null, resultPath: null, errorCode: null, parentId, childIds: [] };
}
/** Stream verified Git objects to private files. No all-source base64 payload or source truncation. */
export async function collectContentInput(options: { directory: string; candidateId: string; configDigest: string; units: GitReleaseInputOptions[];
  allUnits?: { id: string; path: string }[]; dependencies?: Record<string, string[]> }) {
  if (!options.units.length) throw new Error('CONTENT_UNITS_REQUIRED');
  await mkdir(options.directory, { recursive: true });
  const sources: ContentSource[] = [], manifests = [], gaps: { unitId: string; path: string; oid: string | null; reason: string }[] = [];
  for (const unit of options.units) {
    const objectDirectory = join(options.directory, unit.unit.id); await mkdir(objectDirectory, { recursive: true });
    const collected = await freezeReleaseGitInput({ ...unit, retainObjectChunk: async chunk => {
      const file = await open(join(objectDirectory, chunk.oid), chunk.start === 0 ? 'w' : 'r+');
      try { await file.write(chunk.bytes, 0, chunk.bytes.length, chunk.start); } finally { await file.close(); }
    } });
    manifests.push(collected.input); gaps.push(...collected.input.gaps.map(gap => ({ unitId: unit.unit.id, ...gap })));
    const references: { path: string; previousPath: string | null; status: string; oid: string; mode: string; stage: 'CONTEXT' | 'DIFF' }[] = [];
    for (const context of collected.input.context) if (context.oid) references.push({ path: context.path, previousPath: null, status: 'CONTEXT', oid: context.oid, mode: '100644', stage: 'CONTEXT' });
    for (const change of collected.input.changes) {
      if (change.before) references.push({ path: change.previousPath ?? change.path, previousPath: change.previousPath, status: `${change.status}:before`, ...change.before, stage: 'DIFF' });
      if (change.after) references.push({ path: change.path, previousPath: change.previousPath, status: `${change.status}:after`, ...change.after, stage: 'DIFF' });
    }
    // Commit messages include direct, reverted and unconventional changes; no PR-shaped filtering.
    for (const commit of collected.input.commits) references.push({ path: `.git-commit/${commit.sha}`, previousPath: null, status: 'COMMIT', oid: commit.sha, mode: 'commit', stage: 'DIFF' });
    const seen = new Set<string>();
    for (const ref of references) {
      if (ref.stage === 'DIFF' && !releaseAffectedUnitIds(ref.path, options.allUnits ?? options.units.map(u => u.unit), options.dependencies ?? {}).includes(unit.unit.id)) continue;
      const key = JSON.stringify([ref.path, ref.oid, ref.stage]); if (seen.has(key)) continue; seen.add(key);
      const object = collected.input.objects.find(o => o.oid === ref.oid);
      if (!object || object.lfsPointer || ref.mode === '120000' || ref.mode === '160000') continue;
      const handle = await open(join(objectDirectory, ref.oid), 'r');
      const intervals: { start: number; end: number }[] = [];
      try {
        const prefix = Buffer.alloc(Math.min(4, object.size)); await handle.read(prefix, 0, prefix.length, 0);
        const encoding = object.encoding === 'utf8' ? 'utf-8'
          : prefix[0] === 0xff && prefix[1] === 0xfe && !(prefix[2] === 0 && prefix[3] === 0) ? 'utf-16le'
            : prefix[0] === 0xfe && prefix[1] === 0xff ? 'utf-16be' : null;
        if (!encoding) continue;
        const decoder = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }); let byteStart = 0;
        const firstSource = sources.length;
        // A streaming decoder carries split code points between object reads.
        for (let position = 0; position < object.size || position === 0; position += 8192) {
          const buffer = Buffer.alloc(Math.min(8192, object.size - position));
          if (buffer.length) { const read = await handle.read(buffer, 0, buffer.length, position); if (read.bytesRead !== buffer.length) throw new Error('CONTENT_OBJECT_TRUNCATED'); }
          const text = decoder.decode(buffer, { stream: position + buffer.length < object.size });
          for (const chunk of splitContentText(text, 6 * 1024)) {
            if (!chunk.text && object.size > 0) continue;
            const start = byteStart, end = start + utf8Length(chunk.text); byteStart = end; intervals.push({ start, end });
            sources.push({ ...ref, id: await sourceId(collected.input.repositoryId, unit.unit.id, ref.path, ref.oid, start, end),
              unitId: unit.unit.id, byteLength: object.size, encoding: encoding === 'utf-8' ? 'utf8' : `${encoding}-to-utf8`, sha256: object.sha256, start, end, text: chunk.text });
          }
          if (!object.size) break;
        }
        if (encoding === 'utf-8') verifyContentCoverage(object.size, intervals);
        else {
          verifyContentCoverage(byteStart, intervals);
          for (let i = firstSource; i < sources.length; i++) sources[i]!.byteLength = byteStart;
          // The raw Git manifest keeps original byte length/OID/SHA256; payload
          // intervals describe the explicitly labelled UTF-8 conversion.
          for (let i = gaps.length - 1; i >= 0; i--) if (gaps[i]!.unitId === unit.unit.id && gaps[i]!.oid === ref.oid && gaps[i]!.reason === 'binary-semantics-unread') gaps.splice(i, 1);
        }
      } finally { await handle.close(); }
    }
  }
  const first = options.units[0]!;
  if (options.units.some(u => JSON.stringify(u.identity) !== JSON.stringify(first.identity))) throw new Error('CONTENT_IDENTITY_MISMATCH');
  const input: ContentInput = { schemaVersion: 1, repositoryId: first.identity.repositoryId, candidateId: options.candidateId,
    baseSha: first.identity.targetSha, controllerSha: first.identity.controllerSha, units: options.units.map(u => u.unit),
    boundaries: options.units.map(u => ({ unitId: u.unit.id, kind: u.boundary.kind, sha: u.boundary.kind === 'full-tree' ? null : u.boundary.sha,
      reference: u.boundary.kind === 'full-tree' ? null : u.boundary.reference })), sourceManifestDigest: hash(manifests), configDigest: options.configDigest, batches: [] };
  for (const gap of gaps) {
    const oid = gap.oid ?? '0'.repeat(40), text = `来源缺口：${gap.reason}。文件内容未作语义读取，相关影响尚未核实。`;
    sources.push({ id: await sourceId(input.repositoryId, gap.unitId, gap.path, oid, 0, 0), unitId: gap.unitId, path: gap.path, previousPath: null,
      status: 'GAP', oid, mode: 'unread', byteLength: 0, encoding: 'gap', sha256: hash(gap), start: 0, end: 0, text, stage: 'DIFF' });
  }
  return { input, sources, gaps, manifests };
}
async function groupPayloads(work: ContentWork, stage: ContentStage, sources: ContentSource[], items: ContentItem[], background: ContentItem[] = [], composeUnit?: string) {
  const values = stage === 'COMPOSE' ? items : sources;
  let payload: ContentPayload = { stage, unitIds: [], units: work.input.units, sources: [], items: [], background: [...background] };
  const add = async () => {
    if (!ids(payload).length) return;
    const batch = await batchFor(work.input, payload); work.input.batches.push(batch); work.payloads[batch.id] = payload;
  };
  for (const value of values) {
    const next: ContentPayload = stage === 'COMPOSE' ? { ...payload, items: [...payload.items, value as ContentItem] }
      : { ...payload, sources: [...payload.sources, value as ContentSource] };
    next.unitIds = stage === 'COMPOSE' ? [...payload.unitIds] : [...new Set(next.sources.map(s => s.unitId))].sort();
    if (stage === 'COMPOSE') next.unitIds = [composeUnit!];
    if (utf8Length(contentWireInput(next)) > 24 * 1024 || stage !== 'COMPOSE' && payload.sources.length > 0 && payload.sources[0]!.unitId !== (value as ContentSource).unitId) {
      await add(); payload = { stage, unitIds: stage === 'COMPOSE' ? [composeUnit!] : [(value as ContentSource).unitId], units: work.input.units, sources: stage === 'COMPOSE' ? [] : [value as ContentSource], items: stage === 'COMPOSE' ? [value as ContentItem] : [], background: [...background] };
      if (utf8Length(contentWireInput(payload)) > 24 * 1024) throw new Error('CONTENT_SINGLE_SOURCE_LIMIT');
    } else payload = next;
  }
  await add();
}
export async function planContentBatches(input: ContentInput, sources: ContentSource[], evidence: ContentWork['evidence'] = { manifests: [], gaps: [] }): Promise<ContentWork> {
  const work: ContentWork = { input: structuredClone(input), payloads: {}, results: {}, evidence };
  if (input.batches.length) throw new Error('CONTENT_PLAN_ALREADY_EXISTS');
  const ordered = [...sources].sort((a, b) => {
    const x = JSON.stringify([a.unitId, a.path, a.status]), y = JSON.stringify([b.unitId, b.path, b.status]);
    return x < y ? -1 : x > y ? 1 : a.start - b.start;
  });
  await groupPayloads(work, 'CONTEXT', ordered.filter(s => s.stage === 'CONTEXT'), []);
  await groupPayloads(work, 'DIFF', ordered.filter(s => s.stage === 'DIFF'), []);
  validateContentInput(work.input); return work;
}
export interface ContentRuntime {
  now(): string;
  editing(): Promise<boolean>;
  preflight(): Promise<'READY' | 'WAIT_AUTH' | 'WAIT_QUOTA'>;
  /** The child accepts only curated data and its separately selected Copilot credential. */
  call(input: string): Promise<{ text: string; model: string; usage: { inputTokens: number; outputTokens: number } | null }>;
  /** Atomic generation + candidate-wide cache transaction, including SENT before a call. */
  save(work: ContentWork, cache: ContentCache): Promise<void>;
}
function ready(work: ContentWork, stage: ContentStage) { return work.input.batches.filter(b => b.stage === stage).every(b => b.status === 'READY' || b.status === 'SUPERSEDED'); }
function itemsFor(work: ContentWork, stage: ContentStage) {
  return work.input.batches.filter(b => b.stage === stage && b.status === 'READY').flatMap(b => (work.results[b.id] as { items: ContentItem[] }).items);
}
/** Finite, durable batch ledger. Response loss consumes an attempt across wakes and generations. */
export async function resumeContentBatches(work: ContentWork, cache: ContentCache, runtime: ContentRuntime) {
  validateContentInput(work.input);
  const started = Date.parse(runtime.now()); let calls = 0;
  for (const batch of work.input.batches) if (batch.status === 'RUNNING') {
    const attempt = batch.attempts.at(-1); if (attempt?.status === 'SENT') attempt.status = 'UNKNOWN';
    batch.status = batch.attempts.length >= 3 ? 'FAILED' : 'RETRY_WAIT'; batch.errorCode = 'RESPONSE_UNKNOWN';
    batch.nextCheckAt = new Date(Date.parse(attempt!.startedAt) + (batch.attempts.length === 1 ? 60_000 : 300_000)).toISOString();
    const entry = cache[cacheKey(batch.inputDigest, work.input.configDigest)]; if (entry) entry.attempts = structuredClone(batch.attempts);
  }
  await runtime.save(work, cache);
  while (calls < 10 && Date.parse(runtime.now()) - started < 18 * 60_000) {
    if (await runtime.editing()) return { status: 'EDITING', calls };
    if (ready(work, 'CONTEXT') && ready(work, 'DIFF') && !work.input.batches.some(b => b.stage === 'COMPOSE')) {
      const items = [...itemsFor(work, 'CONTEXT'), ...itemsFor(work, 'DIFF')].filter(i => i.visibility !== 'INTERNAL')
        .sort((a, b) => CONTENT_SECTIONS.indexOf(a.section) - CONTENT_SECTIONS.indexOf(b.section) || a.sourceIds.join(',').localeCompare(b.sourceIds.join(',')));
      if (items.length) {
        for (const unit of work.input.units) {
          const sources = new Set(Object.values(work.payloads).flatMap(p => p.sources.filter(s => s.unitId === unit.id).map(s => s.id)));
          const selected = items.filter(item => item.sourceIds.every(id => sources.has(id)));
          if (selected.length) await groupPayloads(work, 'COMPOSE', [], selected, [], unit.id);
        }
      }
      else return { status: 'READY', calls };
      await runtime.save(work, cache);
    }
    const batch = work.input.batches.find(b => !['READY', 'FAILED', 'SUPERSEDED'].includes(b.status)
      && (!b.nextCheckAt || Date.parse(b.nextCheckAt) <= Date.parse(runtime.now()))
      && (b.stage === 'CONTEXT' || ready(work, 'CONTEXT')) && (b.stage !== 'COMPOSE' || ready(work, 'DIFF')));
    if (!batch) return { status: work.input.batches.some(b => b.status === 'FAILED') ? 'FAILED' : work.input.batches.every(b => ['READY', 'SUPERSEDED'].includes(b.status)) ? 'READY' : 'WAIT', calls };
    const payload = work.payloads[batch.id]!;
    if (batch.stage === 'DIFF' && !batch.attempts.length && !payload.background.length) {
      const relevantPaths = new Set(payload.sources.map(s => s.path));
      const relevantIds = new Set(Object.values(work.payloads).flatMap(p => p.sources.filter(s => relevantPaths.has(s.path)).map(s => s.id)));
      const context = itemsFor(work, 'CONTEXT').sort((a, b) => Number(b.sourceIds.some(id => relevantIds.has(id))) - Number(a.sourceIds.some(id => relevantIds.has(id))) || a.sourceIds.join(',').localeCompare(b.sourceIds.join(',')));
      for (const item of context) if (utf8Length(JSON.stringify([...payload.background, item])) <= 4096
        && utf8Length(contentWireInput({ ...payload, background: [...payload.background, item] })) <= 24 * 1024) payload.background.push(item);
      batch.inputDigest = hash(payload);
      const oldId = batch.id; batch.id = (await batchFor(work.input, payload, batch.parentId)).id;
      if (oldId !== batch.id) { delete work.payloads[oldId]; work.payloads[batch.id] = payload; }
    }
    const key = cacheKey(batch.inputDigest, work.input.configDigest);
    const entry = cache[key] ??= { inputDigest: batch.inputDigest, configDigest: work.input.configDigest, attempts: [], result: null, split: false };
    const split = async () => {
      const values = payload.stage === 'COMPOSE' ? payload.items : payload.sources;
      if (values.length < 2) throw new Error('CONTENT_SPLIT_INVALID');
      for (const slice of [values.slice(0, Math.ceil(values.length / 2)), values.slice(Math.ceil(values.length / 2))]) {
        const childPayload = { ...payload, background: [...payload.background], sources: payload.stage === 'COMPOSE' ? [] : slice as ContentSource[], items: payload.stage === 'COMPOSE' ? slice as ContentItem[] : [] };
        const child = await batchFor(work.input, childPayload, batch.id); work.input.batches.push(child); work.payloads[child.id] = childPayload; batch.childIds.push(child.id);
      }
      batch.status = 'SUPERSEDED'; entry.split = true;
    };
    if (entry.split) {
      batch.attempts = structuredClone(entry.attempts); await split(); await runtime.save(work, cache); continue;
    }
    if (entry.attempts.length > batch.attempts.length) {
      batch.attempts = structuredClone(entry.attempts);
      const last = batch.attempts.at(-1)!;
      if (last.status === 'SENT') { last.status = 'UNKNOWN'; last.errorCode = 'RESPONSE_UNKNOWN'; }
      if (!entry.result) {
        batch.nextCheckAt = new Date(Date.parse(last.startedAt) + (batch.attempts.length === 1 ? 60_000 : 300_000)).toISOString();
        batch.status = batch.attempts.length >= 3 ? 'FAILED' : 'RETRY_WAIT';
        entry.attempts = structuredClone(batch.attempts); await runtime.save(work, cache);
        if (batch.status === 'FAILED' || Date.parse(batch.nextCheckAt) > Date.parse(runtime.now())) continue;
      }
    }
    if (entry.result) {
      work.results[batch.id] = validateContentResult(batch.stage, JSON.stringify(entry.result), batch.sourceIds);
      batch.status = 'READY'; batch.resultPath = `results/${batch.id}.json`; await runtime.save(work, cache); continue;
    }
    if (batch.attempts.length >= 3) { batch.status = 'FAILED'; batch.errorCode = 'CONTENT_ATTEMPTS_EXHAUSTED'; await runtime.save(work, cache); continue; }
    const preflight = await runtime.preflight();
    if (preflight !== 'READY') { batch.status = preflight; await runtime.save(work, cache); return { status: preflight, calls }; }
    if (await runtime.editing()) return { status: 'EDITING', calls };
    const attempt: ContentAttempt = { ordinal: batch.attempts.length + 1, startedAt: runtime.now(), status: 'SENT', model: 'server-selected', usage: null, errorCode: null };
    batch.attempts.push(attempt); batch.status = 'RUNNING'; entry.attempts = structuredClone(batch.attempts);
    await runtime.save(work, cache); calls++;
    try {
      const response = await runtime.call(contentWireInput(payload));
      attempt.status = 'RETURNED'; attempt.model = response.model; attempt.usage = response.usage;
      const qualifications = new Map<string, Qualification>();
      for (const item of payload.items) for (const id of item.sourceIds) if (!qualifications.has(id) || item.qualification === 'UNVERIFIED') qualifications.set(id, item.qualification);
      const result = validateContentResult(batch.stage, response.text, batch.sourceIds, [], qualifications);
      if ('items' in result) {
        const gaps = new Set(payload.sources.filter(s => s.encoding === 'gap').map(s => s.id));
        if (result.items.some(item => item.sourceIds.some(id => gaps.has(id)) && (item.visibility !== 'UNRESOLVED' || item.qualification !== 'UNVERIFIED')))
          throw new Error('CONTENT_GAP_QUALIFICATION');
      }
      work.results[batch.id] = result; entry.result = result; batch.resultPath = `results/${batch.id}.json`; batch.status = 'READY'; batch.errorCode = null; batch.nextCheckAt = null;
    } catch (error) {
      const rawCode = error instanceof Error ? error.message : '';
      const code = /^(?:CONTENT_[A-Z_]+|WAIT_AUTH|WAIT_QUOTA|RESPONSE_UNKNOWN)$/.test(rawCode) ? rawCode : 'RESPONSE_UNKNOWN';
      attempt.status = code === 'RESPONSE_UNKNOWN' ? 'UNKNOWN' : 'REJECTED'; attempt.errorCode = code; batch.errorCode = code;
      const values = payload.stage === 'COMPOSE' ? payload.items : payload.sources;
      if (['CONTENT_OUTPUT_LIMIT', 'CONTENT_CAPACITY'].includes(code) && values.length > 1) {
        await split();
      } else {
        batch.status = batch.attempts.length >= 3 || code === 'CONTENT_OUTPUT_LIMIT' || code === 'CONTENT_CAPACITY' ? 'FAILED'
          : code === 'WAIT_AUTH' || code === 'WAIT_QUOTA' ? code : 'RETRY_WAIT';
        const retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
        const delay = Math.max(batch.attempts.length === 1 ? 60_000 : 300_000,
          Number.isFinite(retryAfterMs) && retryAfterMs! >= 0 ? retryAfterMs! : 0);
        batch.nextCheckAt = new Date(Date.parse(runtime.now()) + delay).toISOString();
      }
    }
    entry.attempts = structuredClone(batch.attempts);
    await runtime.save(work, cache);
  }
  return { status: 'WAIT', calls };
}
export function assembleUnitNotes(work: ContentWork) {
  if (!work.input.batches.every(b => ['READY', 'SUPERSEDED'].includes(b.status))) throw new Error('CONTENT_NOT_READY');
  const paragraphs = work.input.batches.filter(b => b.stage === 'COMPOSE' && b.status === 'READY')
    .flatMap(b => (work.results[b.id] as { paragraphs: ContentParagraph[] }).paragraphs);
  return work.input.units.map(unit => {
    const sources = new Set(Object.values(work.payloads).flatMap(p => p.sources.filter(s => s.unitId === unit.id).map(s => s.id)));
    return { path: `.release-notes/${unit.id}.md`, mode: '100644' as const, content: renderUnitContent(paragraphs.filter(p => p.sourceIds.some(id => sources.has(id)))) };
  });
}
