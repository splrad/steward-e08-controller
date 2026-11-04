import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';

// Execute the actual candidate consumer branch with only its external ports replaced.
// Native Git/generation coverage remains in release-candidate-native.test.ts.
const source=await readFile(new URL('./runtime.mjs',import.meta.url),'utf8');
const start="    }else if(mode==='candidate'){",end='    }else{';
const offset=source.indexOf(start);assert.ok(offset>=0);
const body=source.slice(offset+start.length,source.indexOf(end,offset+start.length));
const execute=new (Object.getPrototypeOf(async function(){}).constructor)(
  'bind','record','join','root','mkdir','runner','env','promisify','execFile','repository','app','hash','check','fileUrl','evidence','transport','tree',body);
const moduleUrl=text=>'data:text/javascript,'+encodeURIComponent(text);
let sequence=0;
async function run(change={}){
  const record=moduleUrl(`// ${sequence++}\nexport let state;export function set(value){state=value;}export async function readReleaseRecords(){return state;}`);
  const store=await import(record),oldCycle='pr-1-'+ 'a'.repeat(40),paths=[];
  let calls=0,snapshots=0,head='before',cycle='old-cycle-bytes';
  let candidate=change.existing?{id:'already-active'}:null;
  const evidence={results:[],modelCalls:0};
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const execFile=(_file,args,_options,callback)=>{
    const op=args[5],rest=args.slice(6);let stdout='';
    if(op==='rev-parse'){
      snapshots++;store.set({head,repository:{activeCycleId:change.noCycle?null:(calls?'different-pointer':oldCycle),candidate}});stdout=head;
    }else if(op==='show'){
      paths.push(rest[0]);stdout=rest[0].endsWith(':state.json')?JSON.stringify({head,candidate}):cycle;
    }
    callback(null,{stdout,stderr:''});
  };
  const transport=async(_request,{language})=>{
    calls++;
    if(calls===1||change.repeatSdk){
      assert.equal(await language.preflight(),'READY');
      const response=await language.call(JSON.stringify({stage:'DRAFT',sources:[{id:'b'.repeat(64)}],items:[]}));
      assert.equal(response.model,'E08_FIXED_NO_MODEL');
    }
    head='state-'+calls;
    candidate={id:'new-candidate',prNumber:change.otherPr&&calls===2?3:2,branch:change.otherBranch&&calls===2?'different':'steward/release-candidate',publishedHead:'c'.repeat(40)};
    if(change.cycleChanged)cycle='old-cycle-bytes\n';
    return change.result??{status:'READY',prNumber:candidate.prNumber,head:candidate.publishedHead};
  };
  const app={appBotId:1,appBotLogin:'fixture',forCandidateRepository:async(_id,fn)=>fn('write','read')};
  await execute(async()=>moduleUrl('export async function nativeReleaseCandidate(request,options){return options.fetcher(request,options)}'),
    record,join,'fixture-root',async()=>{}, {isolatedBuildEnvironment:()=>({})},{GITHUB_SHA:'d'.repeat(40)},promisify,execFile,
    {id:1,full_name:'fixture/product'},app,hash,(value,code)=>{if(!value)throw Error(code);},
    path=>new URL('../'+path,import.meta.url).href,
    evidence,transport,'fixture-tree');
  assert.equal(calls,2);assert.equal(snapshots,3);
  assert.ok(paths.filter(p=>p.includes(':cycles/')).every(p=>p.endsWith(':cycles/'+oldCycle+'.json')));
  assert.equal(evidence.fixtureCalls,1);assert.equal(evidence.modelCalls,0);
  assert.notEqual(evidence.results[0].state.head,evidence.results[1].state.head);
}
test('READY replay permits state writes, pins the old cycle and reuses the existing fixed SDK cache',()=>run());
for(const [name,change,error] of [
  ['missing registered cycle',{noCycle:true},'CANDIDATE_FIXTURE_REGISTERED_CYCLE_REQUIRED'],
  ['existing candidate',{existing:true},'CANDIDATE_FIXTURE_NO_CANDIDATE_REQUIRED'],
  ['no releasable source',{result:{status:'WAIT',reason:'UNCHANGED'}},'CANDIDATE_FIXTURE_RELEASABLE_SOURCE_REQUIRED'],
  ['obsolete global lock',{result:{status:'WAIT',reason:'ACTIVE_CYCLE'}},'CANDIDATE_CONSUMER_RESULT'],
  ['old cycle changed',{cycleChanged:true},'CANDIDATE_CYCLE_CHANGED'],
  ['different PR on replay',{otherPr:true},'CANDIDATE_REPLAY_CHANGED'],
  ['different branch on replay',{otherBranch:true},'CANDIDATE_REPLAY_CHANGED'],
  ['SDK called again on replay',{repeatSdk:true},'CANDIDATE_REPLAY_CHANGED'],
])test('rejects '+name,()=>assert.rejects(run(change),new RegExp(error)));
