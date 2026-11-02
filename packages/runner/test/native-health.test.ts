import {expect,it} from 'vitest';
import {readFile,writeFile,mkdtemp,rm,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import YAML from 'yaml';
import {permitOfflineCommand} from './offline-fixtures.js';

// Execute the actual workflow shell, with every gh request captured and confined
// to this fixture. The fake native service persists writes before losing replies.
const service=String.raw`
import fs from 'node:fs';
const [file,mode,...args]=process.argv.slice(2),now=JSON.parse(fs.readFileSync('state.json','utf8')).observedAt;
const path=args.find(x=>x.startsWith('repos/')||x.startsWith('users/'));
const method=args[args.indexOf('--method')+1];
const input=args.includes('--input')?fs.readFileSync(0,'utf8'):'';
fs.appendFileSync('requests.jsonl',JSON.stringify({method,path,input})+'\n');
let state=JSON.parse(fs.readFileSync('state.json','utf8'));
const save=()=>fs.writeFileSync('state.json',JSON.stringify(state));
const out=x=>{process.stdout.write(JSON.stringify(x));process.exit(0);};
const lost=()=>{save();process.exit(1);};
const self=file==='release.yml'?10:20,other=self===10?20:10;
const repo={id:1296724484,full_name:'splrad/steward',default_branch:'main',archived:false,disabled:false};
const run=id=>({id,repository:{id:repo.id},head_repository:{id:repo.id},workflow_id:other,head_branch:'main',event:'schedule',run_attempt:2,created_at:mode==='old-rerun'?new Date(Date.parse(now)-29*3600_000).toISOString():now,run_started_at:now});
const job=(id,name,conclusion,attempt=1)=>({id,name,run_attempt:attempt,status:'completed',conclusion,started_at:now});
const paged=(field,items)=>{const data={total_count:items.length,[field]:items};out(args.includes('--slurp')?[data]:data);};
if(mode==='authentication' && path==='repos/splrad/steward')process.exit(1);
if(path==='repos/splrad/steward')out(repo);
if(path==='repos/splrad/steward/actions/runs/1')out({...run(1),workflow_id:self,run_attempt:2});
if(path.startsWith('users/'))out({id:41898282,type:'Bot'});
if(path.includes('/actions/workflows/') && !path.includes('/runs') && !path.endsWith('/dispatches') && !path.endsWith('/enable')) {
  const target=path.endsWith('release.yml')?10:path.endsWith('update-dependencies.yml')?20:Number(path.split('/').at(-1));
  out({id:target,path:'.github/workflows/'+(target===10?'release.yml':'update-dependencies.yml'),state:target===other&&mode==='manual-disable'?'disabled_manually':target===other&&mode==='inactivity'&&!state.enabled?'disabled_inactivity':'active'});
}
if(path.endsWith('/enable')){state.enabled=true;lost();}
if(path.includes('/actions/workflows/')&&path.includes('/runs')) {
  const query=new URL(path,'https://api.github.com').searchParams;
  if(mode==='pagination-failure')process.exit(1);
  if(mode==='missing-run-fields')paged('workflow_runs',[{id:2}]);
  if(query.has('status')){
    if(mode==='active-query-failure')process.exit(1);
    if(mode==='active-saturated')out([{total_count:1000,workflow_runs:Array.from({length:1000},(_,i)=>run(i+100))}]);
    if(mode==='old-requested'&&query.get('status')==='requested')paged('workflow_runs',[{...run(90),created_at:'2020-01-01T00:00:00Z'}]);paged('workflow_runs',[]);
  }
  if(mode==='old-rerun'&&Date.parse(query.get('created').split('..')[0])>Date.parse(run(2).created_at))paged('workflow_runs',[]);
  if(mode==='overdue'||mode==='old-requested'||mode==='dispatch-unknown'||mode==='dispatch-lost') {
    if(state.dispatched&&mode==='dispatch-lost')paged('workflow_runs',[{...run(9),event:'workflow_dispatch',actor:{id:41898282}}]);
    paged('workflow_runs',[]);
  }
  if(mode==='saturated') {
    const [lo,hi]=query.get('created').split('..').map(Date.parse);
    if(hi-lo>60*60*1000)out({total_count:1000,workflow_runs:[]});
    paged('workflow_runs',[run(2)]);
  }
  if(mode==='single-second-saturated')out({total_count:1000,workflow_runs:[]});
  if(mode==='duplicate-pages'||mode==='contradictory-pages') {
    if(!args.includes('--slurp'))out({total_count:1,workflow_runs:[run(2)]});
    out([{total_count:1,workflow_runs:[run(2)]},{total_count:1,workflow_runs:[mode==='contradictory-pages'?{...run(2),head_branch:'foreign'}:run(2)]}]);
  }
  paged('workflow_runs',[run(2)]);
}
if(path.includes('/actions/runs/')&&path.includes('/jobs')) {
  if(mode==='missing-job-fields')paged('jobs',[{id:21,name:'release-coordinator'}]);
  if(mode==='missing-business')paged('jobs',[job(22,'automation-health','success',2)]);
  const failing=mode==='business-failure', jobs=other===10?[job(21,'release-coordinator',failing?'failure':'success')]:[
    {...job(21,'targets','success'),steps:[{name:'update-targets-empty',conclusion:failing?'skipped':'success'},{name:'update-targets-found',conclusion:failing?'success':'skipped'}]},
    ...(failing?[{...job(23,'update (a)','failure'),started_at:new Date(Date.now()-1000).toISOString()},job(24,'update (b)','success')]:[])];
  if(mode==='running-business')Object.assign(jobs[0],{status:'in_progress',conclusion:null});
  paged('jobs',[...jobs,job(22,'automation-health','failure',2)]);
}
if(path.endsWith('/dispatches')){state.dispatched=true;lost();}
if(path.endsWith('/issues')&&method==='POST'){
  state.issue={id:70,number:7,state:'open',user:{id:41898282},updated_at:now,...JSON.parse(input)};lost();
}
if(path.includes('/issues?'))out([state.issue?[state.issue]:[]]);
if(path.endsWith('/issues/7')) {
  if(method==='PATCH'){Object.assign(state.issue,JSON.parse(input));lost();}out(state.issue);
}
if(path.includes('/issues/7/comments')) {
  if(method==='POST'){state.comments.push({id:80+state.comments.length,user:{id:41898282},...JSON.parse(input)});lost();}out([state.comments]);
}
throw Error('Unregistered fixture request '+method+' '+path);
`;

for(const file of ['release.yml','update-dependencies.yml']) {
  it.skipIf(process.platform==='win32').each(['healthy','business-failure','manual-disable','inactivity','authentication',
    'pagination-failure','duplicate-pages','contradictory-pages','saturated','single-second-saturated','old-requested','dispatch-unknown','dispatch-lost',
    'active-query-failure','active-saturated','missing-business','old-rerun','missing-run-fields','missing-job-fields','running-business'])(`${file}: native health %s`,async mode=>{
    const workflow=YAML.parse(await readFile('.github/workflows/'+file,'utf8'));
    const script=workflow.jobs['automation-health'].steps[0].run;
    const root=await mkdtemp(join(tmpdir(),'native-health-exit-'));
    try {
      await writeFile(join(root,'service.mjs'),service);
      const initialState={comments:[],observedAt:new Date().toISOString()};
      await writeFile(join(root,'state.json'),JSON.stringify(initialState));
      const args=['-c',`gh() { node service.mjs '${file}' '${mode}' "$@"; }\n`+script];permitOfflineCommand('bash',args);
      const run=()=>spawnSync('bash',args,{cwd:root,env:{...process.env,GH_TOKEN:'offline',DEFAULT_BRANCH:'main',CURRENT_RUN_ID:'1',CURRENT_ATTEMPT:'2'},encoding:'utf8',timeout:60_000});
      const first=run();
      const failed=['authentication','pagination-failure','contradictory-pages','single-second-saturated','active-query-failure','active-saturated','missing-run-fields','missing-job-fields'].includes(mode);
      expect(first.error).toBeUndefined();
      if(failed)expect(first.status,first.stderr).toBeGreaterThan(0);else expect(first.status,first.stderr).toBe(0);
      const requests=async()=> (await readFile(join(root,'requests.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
      let calls=await requests();const writes=()=>calls.filter(x=>x.method!=='GET');
      if(failed)expect(writes()).toEqual([]);
      if(['healthy','duplicate-pages','saturated'].includes(mode))expect(writes()).toEqual([]);
      if(mode==='old-requested') {
        expect(calls.filter(x=>x.path.includes('status=')).every(x=>!x.path.includes('created='))).toBe(true);
        expect(calls.some(x=>x.path.endsWith('/dispatches'))).toBe(false);
      }
      if(mode==='inactivity')expect(calls.filter(x=>x.path.endsWith('/enable'))).toHaveLength(1);
      if(mode==='manual-disable')expect(calls.some(x=>x.path.endsWith('/enable')||x.path.endsWith('/dispatches'))).toBe(false);
      if(mode==='business-failure')expect(JSON.parse(await readFile(join(root,'state.json'),'utf8')).issue.body).toContain('BUSINESS_ENTRY_FAILED');
      if(mode==='missing-business') {
        expect(JSON.parse(await readFile(join(root,'state.json'),'utf8')).issue.body).toContain('BUSINESS_EVIDENCE_UNKNOWN');
        expect(calls.some(x=>x.path.endsWith('/dispatches'))).toBe(false);
      }
      if(mode==='old-rerun')expect(calls.filter(x=>x.path.endsWith('/dispatches'))).toHaveLength(1);
      if(mode==='running-business') {
        expect(JSON.parse(await readFile(join(root,'state.json'),'utf8')).issue.body).toContain('OBSERVING');
        expect(calls.some(x=>x.path.endsWith('/dispatches'))).toBe(false);
      }
      // A second process must read the native adopted issue/comment/send result,
      // with no repeat notification or unknown wake. No health.json is written.
      if(['business-failure','manual-disable','dispatch-unknown'].includes(mode)) {
        const count=writes().length,second=run();expect(second.status,second.stderr).toBe(0);calls=await requests();expect(writes()).toHaveLength(count);
      }
      if(mode==='dispatch-lost') {
        const second=run();expect(second.status,second.stderr).toBe(0);calls=await requests();
        expect(calls.filter(x=>x.path.endsWith('/dispatches'))).toHaveLength(1);
        expect(calls.filter(x=>x.path.endsWith('/issues')&&x.method==='POST')).toHaveLength(1);
        expect(JSON.parse(await readFile(join(root,'state.json'),'utf8')).issue.state).toBe('closed');
      }
      expect(calls.some(x=>x.path.includes('/rerun')||x.path.includes('/git/'))).toBe(false);
      expect(first.stdout).toBe('');
      if(process.env.STEWARD_OFFLINE_EVIDENCE) {
        await mkdir(process.env.STEWARD_OFFLINE_EVIDENCE,{recursive:true});
        await writeFile(join(process.env.STEWARD_OFFLINE_EVIDENCE,file+'-'+mode+'.json'),JSON.stringify({file,mode,
          scriptSha256:createHash('sha256').update(script).digest('hex'),firstStatus:first.status,requests:calls,
          initialState,finalState:JSON.parse(await readFile(join(root,'state.json'),'utf8')),assertions:'PASS'},null,2)+'\n');
      }
    } finally {await rm(root,{recursive:true,force:true});}
  },120_000);
}
