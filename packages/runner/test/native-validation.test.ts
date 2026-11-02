import {expect,it,vi} from 'vitest';
import {readFile,writeFile,mkdtemp,mkdir,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {registerOfflineFixtureRoot} from './offline-fixtures.js';
const script=(name:string)=>import(pathToFileURL(resolve('scripts/'+name+'.mjs')).href);
const S='a'.repeat(40),H='b'.repeat(40);
const input=(changes:any[])=>({repositoryId:1,base:S,head:H,workflowSha:S,complete:true,changes});
it('selects documentation alone but includes semantic instructions, locks, shared code and unknown paths conservatively',async()=>{
  const {selectValidationScope:select}=await script('select-validation-scope');
  expect(Object.fromEntries(Object.entries(select(input([{status:'M',paths:['docs/guide.md']}]))).map(([k,v]:any)=>[k,v.selected]))).toEqual({source:false,dependency:false,docs:true,governance:false});
  for(const path of ['AGENTS.md','templates/repository/AGENTS.md','scripts/select-validation-scope.mjs','schema/input.json','package-lock.json','new-language.unknown']){
    const result=select(input([{status:'M',paths:[path]}]));expect(result.source.selected).toBe(true);expect(result.governance.selected).toBe(true);
  }
  expect(select(input([{status:'R100',paths:['package-lock.json','docs/old.md']}])).dependency.selected).toBe(true);
});
it.each([null,{complete:false},input([{status:'R100',paths:['only']}]),input([{status:'M',paths:['../secret']}]),input([{status:'X',paths:['file']}])])('incomplete or unsafe diff cannot produce not-applicable: %j',async value=>{
  const {selectValidationScope}=await script('select-validation-scope');expect(()=>selectValidationScope(value)).toThrow('INCOMPLETE');
});
it('parses complete NUL-delimited Git renames with spaces and rejects truncation/invalid UTF8',async()=>{
  const {parseNameStatus}=await script('validation-input');
  expect(parseNameStatus(Buffer.from('R100\0old name.md\0new name.md\0D\0deleted.png\0'))).toEqual([{status:'R100',paths:['old name.md','new name.md']},{status:'D',paths:['deleted.png']}]);
  for(const bytes of [Buffer.from('M\0file'),Buffer.from('R100\0old\0'),Buffer.from([255,0])])expect(()=>parseNameStatus(bytes)).toThrow();
});
it('accepts zero-padded Git similarity scores and rejects scores outside 0..100 at both input boundaries',async()=>{
  const {parseNameStatus}=await script('validation-input'),{selectValidationScope}=await script('select-validation-scope');
  for(const status of ['R000','R050','R099','C001','C100']){
    const changes=parseNameStatus(Buffer.from(`${status}\0old/pyproject.toml\0new/pyproject.toml\0`));
    expect(changes).toEqual([{status,paths:['old/pyproject.toml','new/pyproject.toml']}]);
    expect(selectValidationScope(input(changes)).dependency.selected).toBe(true);
  }
  for(const status of ['R101','C999','R0100','R-01','R']){
    expect(()=>parseNameStatus(Buffer.from(`${status}\0old\0new\0`))).toThrow('DIFF_STATUS');
    expect(()=>selectValidationScope(input([{status,paths:['old','new']}]))).toThrow('INCOMPLETE');
  }
});
it('reads real complete Git base/head and detects stale base, wrong checkout and missing source',async()=>{
  const {validationInput}=await script('validation-input'),root=await mkdtemp(join(tmpdir(),'validation-git-'));registerOfflineFixtureRoot(root);
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  try{
    git('init','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    const contents=Array.from({length:64},(_,i)=>`unique line ${i}\n`).join('');
    await writeFile(join(root,'old name.md'),contents);git('add','.');git('commit','--signoff','--no-gpg-sign','-m','base');const base=git('rev-parse','HEAD');git('update-ref','refs/remotes/origin/main',base);
    await rename(join(root,'old name.md'),join(root,'new name.md'));await writeFile(join(root,'new name.md'),contents.replace('unique line 63','edited last line'));git('add','.');git('commit','--signoff','--no-gpg-sign','-m','rename');const head=git('rev-parse','HEAD');
    const event=join(root,'event.json');await writeFile(event,JSON.stringify({repository:{id:1,full_name:'splrad/fixture'},pull_request:{base:{repo:{id:1},ref:'main',sha:base},head:{sha:head}}}));
    const env={GITHUB_EVENT_PATH:event,GITHUB_EVENT_NAME:'pull_request',GITHUB_REPOSITORY_ID:'1',GITHUB_REPOSITORY:'splrad/fixture',WORKFLOW_REPOSITORY:'splrad/steward',WORKFLOW_PATH:'.github/workflows/pr-validation-native.yml',WORKFLOW_SHA:S};
    expect((await validationInput(root,env)).input.changes).toEqual([{status:expect.stringMatching(/^R0[5-9][0-9]$/),paths:['old name.md','new name.md']}]);
    await expect(validationInput(root,{...env,WORKFLOW_REPOSITORY:'fork/steward'})).rejects.toThrow('TRUSTED_SOURCE');
    git('update-ref','refs/remotes/origin/main',head);await expect(validationInput(root,env)).rejects.toThrow('BASE_MOVED');
    git('update-ref','refs/remotes/origin/main',base);git('checkout',base);await expect(validationInput(root,env)).rejects.toThrow('CHECKOUT');
    git('checkout',head);const payload=JSON.parse(await readFile(event,'utf8'));payload.pull_request.base.sha=S;await writeFile(event,JSON.stringify(payload));await expect(validationInput(root,env)).rejects.toThrow();
  }finally{await rm(root,{recursive:true,force:true});}
},30000);
it('summary rejects failed, cancelled, missing and unexpectedly skipped required jobs',async()=>{
  const {validationSummary}=await script('validation-summary');
  const jobs=Object.fromEntries(['scope','source-linux','source-windows','governance','dependency','docs'].map(k=>[k,{result:'success'}])) as any;
  jobs.scope.outputs={source:'false',dependency:'false',docs:'true',governance:'false'};
  expect(validationSummary(jobs)).toContain('docs: success');
  for(const result of ['failure','cancelled','skipped',undefined]){const copy=structuredClone(jobs);copy.docs.result=result;expect(()=>validationSummary(copy)).toThrow('REQUIRED_JOB_INCOMPLETE');}
  delete jobs.scope.outputs.docs;expect(()=>validationSummary(jobs)).toThrow('SCOPE_MISSING');
});
it('selects changed docs and current references to deleted/moved image targets without a historical external crawl',async()=>{
  const {documentInputs}=await script('validation-docs'),root=await mkdtemp(join(tmpdir(),'doc-inputs-'));
  try{await mkdir(join(root,'docs'));await writeFile(join(root,'docs/new.md'),'# new\n');await writeFile(join(root,'docs/ref.md'),'![image](../old.png)\n');await writeFile(join(root,'docs/unrelated.md'),'# other\n');
    expect(await documentInputs(root,['docs/new.md','docs/ref.md','docs/unrelated.md'],[{status:'D',paths:['old.png']},{status:'M',paths:['docs/new.md']}])).toEqual(['docs/new.md','docs/ref.md']);
  }finally{await rm(root,{recursive:true,force:true});}
});
it.each(['success','network-failure','check-failure','load-failure','already-owned'])('network execution requires native nft check/load and always cleans its own table: %s',async mode=>{
  const {guardedNetworkCheck}=await script('validation-docs'),calls:string[]=[],run=vi.fn(async()=>{if(mode==='network-failure')throw Error('NETWORK');return 'ok';});
  const nft=async(args:string[])=>{calls.push(args.join(' '));if(args.includes('tables'))return {nftables:mode==='already-owned'?[{table:{family:'inet',name:'splrad_linkcheck'}}]:[]};
    if(mode==='check-failure'&&args.includes('--check')||mode==='load-failure'&&args[0]==='--file')throw Error('FIREWALL');return {nftables:[]};};
  const operation=guardedNetworkCheck(run,nft,'trusted.nft',async()=>{});
  if(mode==='success')expect(await operation).toBe('ok');else await expect(operation).rejects.toThrow();
  if(['success','network-failure'].includes(mode)){expect(run).toHaveBeenCalledTimes(1);expect(calls.at(-1)).toBe('delete table inet splrad_linkcheck');}
  else expect(run).not.toHaveBeenCalled();expect(calls.join('\n')).not.toContain('flush');
});
it('lists external 404/410 repairs separately from authentication, throttling, server failures and timeouts',async()=>{
  const {externalResults}=await script('validation-docs');
  const rows=[404,410,401,403,429,503].map(code=>({url:`https://test.invalid/${code}`,status:{code}}));
  const result=externalResults({total:8,error_map:{'doc.md':rows},timeout_map:{'doc.md':[{url:'https://test.invalid/timeout',status:{text:'Timeout'}}]},success_map:{'doc.md':[{url:'https://test.invalid/ok',status:{code:200}}]}});
  expect(result.map((r:any)=>r.status)).toEqual(['REPAIR_REQUIRED','REPAIR_REQUIRED','UNKNOWN','UNKNOWN','UNKNOWN','UNKNOWN','UNKNOWN','OK']);
  expect(result[0]).toMatchObject({document:'doc.md',url:'https://test.invalid/404',nativeStatus:{code:404}});
});
