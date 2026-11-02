import { decodeBuildJson } from './build-manifest.js';
import { sha256Hex } from './fingerprint.js';
import { validateCandidateFiles } from './release-candidate.js';
import { validateContentInput, validateContentResult } from './release-content.js';

export interface CandidateArchiveChunk {
  schemaVersion: 1; repositoryId: number; candidateId: string;
  documentKind: 'session' | 'content' | 'cache' | 'generated' | 'adoption' | 'native-input' | 'content-result' | 'content-payload' | 'content-evidence' | 'cache-entry';
  documentDigest: string; index: number; count: number; content: string;
}
const exact = (value: any, keys: string[]) => { if (!value || typeof value !== 'object' || Array.isArray(value)
  || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('CANDIDATE_RECORD_FIELDS'); };
/** Closed UTF-8 archive fragments. Complete typed documents are verified after digest-bound assembly. */
export function decodeCandidateArchive(bytes: Uint8Array, repositoryId: number): CandidateArchiveChunk {
  const record = decodeBuildJson(bytes) as CandidateArchiveChunk;
  exact(record, ['schemaVersion', 'repositoryId', 'candidateId', 'documentKind', 'documentDigest', 'index', 'count', 'content']);
  if (record.schemaVersion !== 1 || record.repositoryId !== repositoryId || !/^[a-f0-9]{64}$/.test(record.candidateId)
    || !['session', 'content', 'cache', 'generated', 'adoption', 'native-input', 'content-result', 'content-payload', 'content-evidence', 'cache-entry'].includes(record.documentKind) || !/^[a-f0-9]{64}$/.test(record.documentDigest)
    || !Number.isSafeInteger(record.count) || record.count < 1 || !Number.isSafeInteger(record.index) || record.index < 0 || record.index >= record.count
    || typeof record.content !== 'string' || new TextEncoder().encode(record.content).length > 256 * 1024) throw new Error('CANDIDATE_ARCHIVE_INVALID');
  return record;
}
function snapshot(value: any) {
  exact(value, ['schemaVersion', 'baseSha', 'files', 'units', 'configDigest', 'sourceDigest']);
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(value.baseSha) || !/^[a-f0-9]{64}$/.test(value.configDigest)
    || !/^[a-f0-9]{64}$/.test(value.sourceDigest) || !Array.isArray(value.files) || !Array.isArray(value.units)) throw new Error('CANDIDATE_SNAPSHOT_INVALID');
  validateCandidateFiles(value.files);
  for (const file of value.files) exact(file, ['path', 'mode', 'content']);
  for (const unit of value.units) { exact(unit, ['id', 'path', 'version', 'tag']); if (Object.values(unit).some(v => typeof v !== 'string' || !v)) throw new Error('CANDIDATE_UNIT_INVALID'); }
}
export async function decodeCandidateDocument(chunks: CandidateArchiveChunk[]): Promise<any> {
  if (!chunks.length) throw new Error('CANDIDATE_ARCHIVE_MISSING');
  const first = chunks[0]!, ordered = [...chunks].sort((a, b) => a.index - b.index);
  if (first.count !== chunks.length || ordered.some((c, i) => c.index !== i || c.count !== first.count || c.documentDigest !== first.documentDigest
    || c.documentKind !== first.documentKind || c.repositoryId !== first.repositoryId || c.candidateId !== first.candidateId)) throw new Error('CANDIDATE_ARCHIVE_COVERAGE');
  const text = ordered.map(c => c.content).join('');
  if (await sha256Hex(text) !== first.documentDigest) throw new Error('CANDIDATE_ARCHIVE_DIGEST');
  const value = JSON.parse(text);
  if (first.documentKind === 'generated') snapshot(value);
  else if (first.documentKind === 'content') {
    exact(value, ['input', 'payloadPaths', 'evidencePath']); validateContentInput(value.input);
    if (value.input.repositoryId !== first.repositoryId || value.input.candidateId !== first.candidateId) throw new Error('CONTENT_ARCHIVE_IDENTITY');
    for (const batch of value.input.batches) {
      if (typeof value.payloadPaths[batch.id] !== 'string' || !value.payloadPaths[batch.id].startsWith(`content/${first.candidateId}/`)) throw new Error('CONTENT_PAYLOAD_PATH');
    }
    if (typeof value.evidencePath !== 'string' || !value.evidencePath.startsWith(`content/${first.candidateId}/`)) throw new Error('CONTENT_EVIDENCE_PATH');
  } else if (first.documentKind === 'content-payload') {
    exact(value, ['stage', 'unitIds', 'units', 'sources', 'items', 'background']);
    if (!['CONTEXT', 'DIFF', 'COMPOSE'].includes(value.stage) || !Array.isArray(value.sources) || !Array.isArray(value.items) || !Array.isArray(value.background)) throw new Error('CONTENT_PAYLOAD_INVALID');
  } else if (first.documentKind === 'content-evidence') {
    exact(value, ['manifests', 'gaps']);
    if (!Array.isArray(value.manifests) || !Array.isArray(value.gaps)) throw new Error('CONTENT_EVIDENCE_INVALID');
  } else if (first.documentKind === 'cache') {
    exact(value, ['entries']);
    if (!Array.isArray(value.entries)) throw new Error('CONTENT_CACHE_INVALID');
    for (const entry of value.entries) {
      exact(entry, ['key', 'path', 'digest']);
      if (!/^[a-f0-9]{64}$/.test(entry.key) || !/^[a-f0-9]{64}$/.test(entry.digest) || !entry.path.startsWith(`content/${first.candidateId}/cache/`)) throw new Error('CONTENT_CACHE_INVALID');
    }
  } else if (first.documentKind === 'cache-entry') {
      const entry = value;
      exact(entry, ['inputDigest', 'configDigest', 'attempts', 'result', 'split']);
      if (!/^[a-f0-9]{64}$/.test(entry.inputDigest) || !/^[a-f0-9]{64}$/.test(entry.configDigest)
        || !Array.isArray(entry.attempts) || entry.attempts.length > 3 || typeof entry.split !== 'boolean') throw new Error('CONTENT_CACHE_INVALID');
  } else if (first.documentKind === 'session') {
    exact(value, ['generated', 'pending', 'identity', 'conflict', 'preview', 'adoption']);
    if (value.generated) snapshot(value.generated);
    if (value.pending) {
      exact(value.pending, ['write', 'generated']); snapshot(value.pending.generated);
      const write = value.pending.write; exact(write, ['expectedHead', 'baseSha', 'proposedCommit', 'generatedDigest', 'objects']);
      if (write.expectedHead !== null && !/^[a-f0-9]{40}$/.test(write.expectedHead) || !/^[a-f0-9]{40}$/.test(write.baseSha)
        || !/^[a-f0-9]{40}$/.test(write.proposedCommit) || !/^[a-f0-9]{64}$/.test(write.generatedDigest) || !Array.isArray(write.objects)) throw new Error('CANDIDATE_PENDING_INVALID');
      for (const object of write.objects) { exact(object, ['oid', 'type', 'bytes']); if (!/^[a-f0-9]{40}$/.test(object.oid) || !['blob', 'tree', 'commit'].includes(object.type) || typeof object.bytes !== 'string') throw new Error('CANDIDATE_OBJECT_INVALID'); }
    }
    if (value.conflict) { exact(value.conflict, ['head', 'generated', 'paths']); snapshot(value.conflict.generated); }
    if (value.identity) {
      exact(value.identity, ['authorsDigest', 'sourceDigest', 'actors', 'contributors', 'units']);
      if (!/^[a-f0-9]{64}$/.test(value.identity.authorsDigest) || !/^[a-f0-9]{64}$/.test(value.identity.sourceDigest)
        || !Array.isArray(value.identity.actors) || !Array.isArray(value.identity.units)) throw new Error('CANDIDATE_IDENTITY_INVALID');
      for (const unit of value.identity.units) { exact(unit, ['id', 'actors', 'contributors']); if (!Array.isArray(unit.actors)) throw new Error('CANDIDATE_IDENTITY_INVALID'); }
    }
    if (value.preview !== null && typeof value.preview !== 'string') throw new Error('CANDIDATE_PREVIEW_INVALID');
    if (value.adoption) exact(value.adoption, ['humanHead', 'generatedBase', 'differences']);
  } else if (first.documentKind === 'content-result') {
    exact(value, ['stage', 'sourceIds', 'result']);
    if (!['CONTEXT', 'DIFF', 'COMPOSE'].includes(value.stage) || !Array.isArray(value.sourceIds)) throw new Error('CONTENT_RESULT_INVALID');
    validateContentResult(value.stage, JSON.stringify(value.result), value.sourceIds);
  } else if (first.documentKind === 'native-input') {
    exact(value, ['facts', 'protections']);
    exact(value.protections, ['branch', 'tags']);
    exact(value.facts, ['baseSha', 'defaultBranch', 'config', 'manifest', 'commitCount', 'releases', 'tags', 'boundaries', 'releaseInventoryComplete', 'protectionsEvidencePath']);
    if (!validNativeInput(value.facts)) throw new Error('CANDIDATE_NATIVE_INPUT_INVALID');
  } else {
    exact(value, ['humanHead', 'generatedBase', 'differences']); validateCandidateFiles(value.differences);
  }
  return value;
}
function validNativeInput(value: any) {
  return /^[a-f0-9]{40}$/.test(value.baseSha) && typeof value.config === 'string' && typeof value.manifest === 'string'
    && Number.isSafeInteger(value.commitCount) && value.commitCount > 0 && value.releaseInventoryComplete === true
    && Array.isArray(value.releases) && Array.isArray(value.tags) && Array.isArray(value.boundaries);
}
