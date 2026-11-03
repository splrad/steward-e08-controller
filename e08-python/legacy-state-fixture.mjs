import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {isolatedBuildEnvironment,stateRecordOwner} from './native/index.js';

// Immutable, audited public E08 fixture only. These paths never acquire a writer.
export const fixtureRepository='splrad/steward-e08-product';
export const fixtureRepositoryId=1440689534;
export const fixtureHead='0ecadd80d88bd96cffac5f2e8f93e94179dc8d74';
const first='cd1660334e5fd6f08dbb90c4f65af4898db4911c';
const files=Object.freeze({
  'README.md':Object.freeze({blob:'4190e3e6d0d12ebdb50937da3bc1941bca3d3874',size:104,sha256:'9f9001b938220bce2667f8ce163969ffb422551e40b31650a09fd49cda6b550e'}),
  'native-sequence.txt':Object.freeze({blob:'e2c590747e4d4c6a810506dd01e8aa81456ec9d1',size:3,sha256:'65be7a95a3a5b68952c6ee7d6d7429270e8b24f632656ba2bf161885dcdbf6b3'}),
});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=reason=>{throw Error('E08_LEGACY_STATE: '+reason);};
export function isFixtureTarget(request) {
  return request.repositoryId===fixtureRepositoryId&&request.remote===`https://github.com/${fixtureRepository}.git`
    &&request.defaultBranch==='main'&&(!request.repository||request.repository===fixtureRepository)
    &&(!request.targetRef||request.targetRef==='steward/release-state');
}
/** Read-only exception for carrying the two exact blobs; canonical paths still use the original decoder. */
export async function auditedLegacyFiles(request,head,read) {
  if(!isFixtureTarget(request))return null;
  if(!/^[a-f0-9]{40}$/.test(head??''))fail('state head required');
  const lines=(await read('rev-list','--reverse','--topo-order','--parents',head)).toString('utf8').trim().split('\n');
  if(lines.length<2||lines[0]!==first||lines[1]!==`${fixtureHead} ${first}`)fail('original full parent chain');
  for(let index=0;index<lines.length;index++) {
    const [commit,...parents]=lines[index].split(' ');
    if(!/^[a-f0-9]{40}$/.test(commit)||index>0&&(parents.length!==1||parents[0]!==lines[index-1].split(' ')[0]))fail('linear preserved history');
    const raw=(await read('ls-tree','-r','-z','--full-tree',commit)).toString('utf8');
    const entries=new Map();
    for(const line of raw.split('\0').filter(Boolean)) {
      const match=/^(100644) blob ([a-f0-9]{40})\t([^\r\n]+)$/.exec(line);
      if(!match)fail('regular exact tree');
      const [,mode,blob,path]=match;
      if(entries.has(path))fail('duplicate path');
      entries.set(path,{mode,blob});
      if(Object.hasOwn(files,path)) {
        const expected=files[path],bytes=await read('cat-file','blob',blob);
        if(blob!==expected.blob||bytes.length!==expected.size||hash(bytes)!==expected.sha256)fail('original bytes changed');
      } else {
        if(index<2)fail('unexpected original path');
        stateRecordOwner('steward/release-state',path);
      }
    }
    const required=index===0?['README.md']:Object.keys(files);
    if(required.some(path=>!entries.has(path))||index<2&&entries.size!==required.length)fail('original file inventory');
    if(index>1&&!entries.has('state.json'))fail('canonical state disappeared');
  }
  if(lines.at(-1).split(' ')[0]!==head)fail('head identity');
  return new Map(Object.entries(files).map(([path,value])=>[path,{sha256:value.sha256,value:null}]));
}
export async function auditFixtureSnapshot(request,head,{initial=false}={}) {
  if(!isFixtureTarget(request)||initial&&head!==fixtureHead)fail('initial fixture identity');
  const home=await mkdtemp(join(tmpdir(),'e08-legacy-audit-'));
  try {
    const read=async(...args)=>(await promisify(execFile)('git',['--no-replace-objects','--no-optional-locks','-c','core.hooksPath=','-c','core.fsmonitor=false',...args],
      {cwd:request.directory,env:isolatedBuildEnvironment(process.env,home),encoding:'buffer',windowsHide:true,timeout:30000,maxBuffer:16*1024*1024})).stdout;
    if((await read('rev-parse','--is-shallow-repository')).toString().trim()!=='false')fail('full history required');
    return await auditedLegacyFiles(request,head,read);
  }finally{await rm(home,{recursive:true,force:true});}
}
export async function allowInitialFixtureState(request,snapshot) {
  if(snapshot.repository||snapshot.cycles.length||snapshot.domainRecords.length||snapshot.repositoryHistory.length||snapshot.history.length)fail('canonical history already exists');
  await auditFixtureSnapshot(request,snapshot.head,{initial:true});
}
