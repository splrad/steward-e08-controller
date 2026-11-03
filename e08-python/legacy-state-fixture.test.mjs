import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import child from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,writeFile,copyFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {prepareRuntime} from './prepare-runtime.mjs';
import {fixtureHead,fixtureRepository,fixtureRepositoryId,auditFixtureSnapshot} from './legacy-state-fixture.mjs';
import {releaseProtectionFixture} from '../packages/runner/test/fixtures/release-protection.ts';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),roots=[];
const actualExec=child.execFile,exec=promisify(actualExec);
const remoteUrl=`https://github.com/${fixtureRepository}.git`;
let localRemote=null;
// Tests only: route the single fixed fixture Git URL to a temporary bare repository.
// No native HTTP request or other remote is permitted by this harness.
child.execFile=function(command,args,options,callback) {
  if(command!=='git')throw Error('TEST_EXECUTABLE_DENIED');
  const changed=args.map(arg=>arg===remoteUrl?(assert.ok(localRemote),localRemote):arg==='protocol.https.allow=always'?'protocol.file.allow=always':arg);
  if(changed.some(arg=>/^https?:\/\//.test(arg)))throw Error('TEST_NETWORK_DENIED');
  return actualExec.call(this,command,changed,options,callback);
};
child.execFile[promisify.custom]=(command,args,options)=>new Promise((done,reject)=>child.execFile(command,args,options,
  (error,stdout,stderr)=>error?reject(error):done({stdout,stderr})));
syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('TEST_NETWORK_DENIED');};
const runtimeDir=resolve('.e08-python-runtime-test-'+process.pid);
await prepareRuntime(resolve('.'),runtimeDir);roots.push(runtimeDir);
const {initializeReleaseAdoption}=await import(pathToFileURL(join(runtimeDir,'scripts/release-adoption.mjs')).href);
const {writeReleaseRecords,readReleaseRecords}=await import(pathToFileURL(join(runtimeDir,'scripts/release-record.mjs')).href);
after(async()=>{child.execFile=actualExec;syncBuiltinESMExports();for(const root of roots)await rm(root,{recursive:true,force:true});});

async function fixture() {
  const root=await realpath(await mkdtemp(join(tmpdir(),'e08-legacy-test-')));roots.push(root);
  const directory=join(root,'source'),remote=join(root,'remote.git');localRemote=remote;
  await copyFile(resolve('e08-python/legacy-state-fixture.bundle'),join(root,'fixture.bundle'));
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:join(root,'empty-global')};
  const raw=async(...args)=>(await exec('git',['-c','core.hooksPath=','-c','commit.gpgsign=false',...args],{cwd:directory,env,encoding:'buffer',windowsHide:true})).stdout;
  const git=async(...args)=>(await raw(...args)).toString('utf8').trim();
  await exec('git',['clone','--no-checkout',join(root,'fixture.bundle'),directory],{env,windowsHide:true});
  await git('config','user.name','E08 Fixture');await git('config','user.email','fixture@example.invalid');await git('config','core.autocrlf','false');
  await git('update-ref','refs/heads/steward/release-state',fixtureHead);await git('switch','--orphan','main');
  const config={'separate-pull-requests':false,'include-component-in-tag':false,packages:{'.':{'release-type':'python','initial-version':'0.1.0'}}};
  const delivery={schemaVersion:1,repositoryAuthors:[{id:44151430,evidence:'Offline fixture'}],units:[{id:'python',path:'.',notesPath:'.release-notes/python.md',assets:[{id:'wheel',name:'fixture-${version}.whl',mediaType:'application/zip'}],channels:[]}]};
  for(const [path,content] of Object.entries({'release-please-config.json':JSON.stringify(config),'.release-please-manifest.json':'{".":"0.0.0"}',
    '.github/delivery.json':JSON.stringify(delivery),'.github/release-template.md.mustache':'fixture',
    '.github/workflows/steward-release-publish.yml':'name: fixture\n','.github/workflows/steward-release-channels.yml':'name: fixture\n'})) {
    await mkdir(join(directory,path,'..'),{recursive:true});await writeFile(join(directory,path),content);
  }
  await git('add','.');await git('commit','-m','Adopt fixture');const A=await git('rev-parse','HEAD');
  await git('init','--bare',remote);await git('push',remote,'main','steward/release-state');
  const request={directory,writeDirectory:join(root,'writes'),remote:remoteUrl,repository:fixtureRepository,repositoryId:fixtureRepositoryId,
    defaultBranch:'main',appBotId:350673636,identity:{name:'E08 Fixture',email:'fixture@example.invalid'},releaseAdoption:{sourceSha:A,prNumber:7}};
  const pull={number:7,merged:true,merge_commit_sha:A,base:{ref:'main',repo:{id:fixtureRepositoryId}},head:{repo:{id:fixtureRepositoryId}}};
  let denied=false,tagged=false,productionWriter=false;
  const stateHead=async()=>(await git('ls-remote','--heads','--refs',remote,'refs/heads/steward/release-state')).split('\t')[0];
  const io={async request(method,path) {
    assert.equal(method,'GET');const p=new URL(path,'https://api.github.com').pathname;let value,status=200;
    if(p===`/repos/${fixtureRepository}`)value={id:fixtureRepositoryId,full_name:fixtureRepository,default_branch:'main',archived:false,disabled:false};
    else if(p.endsWith('/pulls/7'))value=pull;
    else if(p.endsWith('/commits/main'))value={sha:A};
    else if(p.endsWith('/git/ref/heads/steward/release-state'))value={object:{sha:await stateHead()}};
    else if(p.endsWith('/pulls')||/\/commits\/[^/]+\/pulls$/.test(p))value=[];
    else if(p.endsWith('/tags')||p.endsWith('/releases'))value=tagged?[{id:9}]:[];
    else if(releaseProtectionFixture(p)) {
      value=structuredClone(releaseProtectionFixture(p));
      if(value.bypass_actors)for(const actor of value.bypass_actors)actor.actor_id=productionWriter?4243096:5553347;
      if(denied)status=403;
    }else throw Error('UNKNOWN_FIXTURE_API '+path);
    return {status,bytes:new Uint8Array(Buffer.from(JSON.stringify(value))),headers:new Headers()};
  }};
  const refresh=async()=>{await git('fetch','--no-tags','--no-recurse-submodules',remote,'refs/heads/steward/release-state');await git('update-ref','refs/heads/steward/release-state',await git('rev-parse','FETCH_HEAD'));};
  return {root,request,git,raw,io,A,pull,stateHead,refresh,deny:()=>{denied=true;},tag:()=>{tagged=true;},wrongWriter:()=>{productionWriter=true;}};
}

test('initial native adoption preserves exact historical blobs, retries, and ordinary writer carries them unchanged',async()=>{
  const f=await fixture();assert.equal((await auditFixtureSnapshot(f.request,fixtureHead,{initial:true})).size,2);
  const result=await initializeReleaseAdoption(f.request,{io:f.io});assert.equal(result.status,'APPLIED');await f.refresh();
  const snapshot=await readReleaseRecords({directory:f.request.directory,targetRef:'steward/release-state',repositoryId:fixtureRepositoryId});
  assert.equal(snapshot.repository.schemaVersion,3);assert.equal(snapshot.repository.revision,0);assert.equal(snapshot.repository.candidate,null);
  assert.deepEqual(snapshot.cycles,[]);assert.equal(snapshot.repository.activeCycleId,null);
  assert.equal(await f.git('rev-parse',`${result.head}^`),fixtureHead);
  for(const path of ['README.md','native-sequence.txt'])assert.deepEqual(await f.raw('show',`${result.head}:${path}`),await f.raw('show',`${fixtureHead}:${path}`));
  assert.equal((await initializeReleaseAdoption(f.request,{io:f.io})).status,'UNCHANGED');assert.equal(await f.stateHead(),result.head);
  const before=await f.raw('show',`${result.head}:state.json`),content=JSON.stringify({...snapshot.repository,revision:1})+'\n';
  const write={directory:join(f.root,'ordinary'),remote:remoteUrl,repositoryId:fixtureRepositoryId,defaultBranch:'main',targetRef:'steward/release-state',writer:'release',expectedHead:result.head,
    allowedPaths:['state.json'],changes:[{path:'state.json',content,sha256:hash(content),previousSha256:hash(before)}],identity:f.request.identity};
  const next=await writeReleaseRecords(write);assert.equal(next.status,'APPLIED');await f.refresh();
  for(const path of ['README.md','native-sequence.txt'])assert.deepEqual(await f.raw('show',`${next.head}:${path}`),await f.raw('show',`${fixtureHead}:${path}`));
  await assert.rejects(writeReleaseRecords({...write,directory:join(f.root,'forbidden'),expectedHead:next.head,allowedPaths:['README.md'],changes:[{path:'README.md',content:'changed',sha256:hash('changed'),previousSha256:hash(await f.raw('show',`${fixtureHead}:README.md`))}]}));
  assert.equal(await f.stateHead(),next.head);
});
for(const mode of ['unmerged','wrong-A','protection','tags','production-writer','wrong-repository'])test('rejects '+mode+' before initialization',async()=>{
  const f=await fixture();if(mode==='unmerged')f.pull.merged=false;if(mode==='wrong-A')f.pull.merge_commit_sha='a'.repeat(40);
  if(mode==='protection')f.deny();if(mode==='tags')f.tag();if(mode==='production-writer')f.wrongWriter();
  if(mode==='wrong-repository')f.request.repositoryId=1;
  const reasons={unmerged:/merged adoption PR/,'wrong-A':/merged adoption PR/,protection:/writer protection read unavailable/,tags:/unrecorded release obligations/,'production-writer':/single App writer required/,'wrong-repository':/repository identity/};
  await assert.rejects(initializeReleaseAdoption(f.request,{io:f.io}),reasons[mode]);assert.equal(await f.stateHead(),fixtureHead);
});
for(const mode of ['bytes','missing','extra','canonical','executable'])test('rejects changed or hidden history: '+mode,async()=>{
  const f=await fixture();await f.git('switch','steward/release-state');
  if(mode==='bytes')await writeFile(join(f.request.directory,'README.md'),'changed');
  if(mode==='missing')await f.git('rm','README.md');
  if(mode==='extra')await writeFile(join(f.request.directory,'unowned.txt'),'extra');
  if(mode==='canonical')await writeFile(join(f.request.directory,'state.json'),'{broken');
  if(mode==='executable')await f.git('update-index','--chmod=+x','native-sequence.txt');
  else await f.git('add','-A');
  await f.git('commit','-m','Unexpected historical transition');
  if(mode==='canonical'){await f.git('rm','state.json');await f.git('commit','-m','Hide canonical record');}
  await f.git('push',localRemote,'steward/release-state');const changed=await f.stateHead();
  await assert.rejects(initializeReleaseAdoption(f.request,{io:f.io}),/E08_LEGACY_STATE:/);assert.equal(await f.stateHead(),changed);
});
test('ordinary native writer rejects a legacy tamper that was later restored after adoption',async()=>{
  const f=await fixture();await initializeReleaseAdoption(f.request,{io:f.io});await f.refresh();await f.git('switch','steward/release-state');
  const original=await f.raw('show',`${fixtureHead}:README.md`);
  await writeFile(join(f.request.directory,'README.md'),'tampered after adoption');await f.git('add','README.md');await f.git('commit','-m','Tamper fixture');
  await writeFile(join(f.request.directory,'README.md'),original);await f.git('add','README.md');await f.git('commit','-m','Restore visible bytes');
  await f.git('push',localRemote,'steward/release-state');const changed=await f.stateHead();
  const before=await f.raw('show',`${changed}:state.json`),content=JSON.stringify({...JSON.parse(before),revision:1})+'\n';
  await assert.rejects(auditFixtureSnapshot(f.request,changed),/E08_LEGACY_STATE: original bytes changed/);
  await assert.rejects(writeReleaseRecords({directory:join(f.root,'later-write'),remote:remoteUrl,repositoryId:fixtureRepositoryId,defaultBranch:'main',
    targetRef:'steward/release-state',writer:'release',expectedHead:changed,allowedPaths:['state.json'],
    changes:[{path:'state.json',content,sha256:hash(content),previousSha256:hash(before)}],identity:f.request.identity}),/RELEASE_RECORD: validation or local operation failed/);
  assert.equal(await f.stateHead(),changed);
});
