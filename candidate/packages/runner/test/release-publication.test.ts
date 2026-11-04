import {expect,it} from 'vitest';
import {inspectPublications,invokePublication,type PublicationFile} from '../src/release-publication.js';
import {evidenceFixture,S,C,D,START,NOW,digest} from './native-evidence-fixture.js';
import {inspectNativeCycle,type EvidenceStore,type ArchiveFile,type EvidenceTransport} from '../src/native-release-evidence.js';
function fixture() {
  const f=evidenceFixture();f.context.cycle.dispatches=[];
  const unit=f.context.cycle.units[0]!,bytes=Buffer.from('frozen');Object.assign(unit,{manifestDigest:digest('manifest'),notesDigest:digest('notes'),
    assets:[{id:'app',path:'app.zip',size:bytes.length,sha256:digest(bytes)}]});
  const run:any={id:900,repository:{id:1296724484},head_repository:{id:1296724484},workflow_id:20,path:'.github/workflows/release.yml',event:'schedule',head_sha:C,
    head_branch:'main',actor:{id:81},triggering_actor:{id:81},run_attempt:1,status:'in_progress',conclusion:null,created_at:START,updated_at:NOW,display_title:'Release'};
  const job:any={id:901,run_id:900,run_attempt:1,head_sha:C,name:'release-coordinator',status:'in_progress',conclusion:null,started_at:START,completed_at:null,
    steps:[{number:3,name:'business-release-coordinator',started_at:START,completed_at:null,conclusion:null}]};
  const calls:string[]=[],files:ArchiveFile[]=[],history:PublicationFile[]=[];let exists=false,readFailure=false;
  const centralIo:EvidenceTransport={async request(method,path) {
    calls.push(method+' '+path);if(method!=='GET')throw Error('central credentials are read only');
    if(path==='/repos/splrad/steward')return f.response({id:1296724484,full_name:'splrad/steward',default_branch:'main',archived:false,disabled:false});
    if(path.endsWith('/actions/workflows/20'))return f.response({id:20,path:run.path});
    if(path.endsWith('/jobs?per_page=100'))return f.response({total_count:1,jobs:[job]});
    if(path.includes('/actions/runs/900'))return f.response(run);
    throw Error('unexpected central path');
  }};
  const productIo:EvidenceTransport={anonymous:()=>productIo,async request(method,path) {
    calls.push(method+' '+path);if(readFailure)return f.response({},503);
    if(path==='/repos/example/product')return f.response({id:1,full_name:'example/product',private:false,archived:false,disabled:false});
    if(path.includes('/releases/assets/51'))return {status:200,headers:new Headers(),bytes};
    if(path.includes('/releases/50/assets'))return f.response([{id:51,name:'app.zip',size:bytes.length}]);
    if(path.includes('/commits/'))return f.response({sha:S});
    if(path.endsWith('/releases?per_page=100'))return f.response([]);
    if(path.includes('/releases/tags/')||path.endsWith('/releases/50'))return exists?f.response({id:50,tag_name:unit.tag,author:{id:42},body:'notes',draft:false,immutable:true}):f.response({},404);
    throw Error('unexpected product path');
  }};
  const store:EvidenceStore={async archive(next){calls.push('ARCHIVE_READBACK');files.push(...next);for(const file of next)history.push({path:file.path,commit:D,value:JSON.parse(file.content)});
    return {status:'APPLIED',head:D,files:[...files],records:[]};}};
  const current={runId:900,runAttempt:1,controllerSha:C,defaultBranch:'main'};
  const terminal=()=>{run.status='completed';run.conclusion='failure';job.status='completed';job.conclusion='failure';job.completed_at=NOW;job.steps[0].completed_at=NOW;job.steps[0].conclusion='failure';};
  const currentFacts=async()=>{const p=await inspectPublications(f.context,history,productIo,centralIo,NOW);return {unknownEvidence:p.missing,inFlightWaveKeys:p.native.attempts.filter(a=>a.status!=='completed').map(a=>a.runId),outcomes:p.native.attempts.flatMap(a=>a.invocations.map(i=>i.evidence.outcome))};};
  return {...f,productIo,centralIo,files,history,calls,store,current,run,job,terminal,currentFacts,setExists:()=>{exists=true;},setReadFailure:()=>{readFailure=true;}};
}
it('adopts a private start before the first write, ignores a lost response when the actual immutable bytes exist',async()=>{
  const f=fixture();let writes=0;
  const result=await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{
    expect(f.calls.at(-1)).not.toBe('BUSINESS_WRITE');expect(f.files[0]!.path).toContain('evidence/publication/');
    f.calls.push('BUSINESS_WRITE');writes++;f.setExists();throw Error('lost response');},NOW,()=>NOW);
  expect(result.publishInvoked).toBe(true);expect(writes).toBe(1);expect(f.calls.indexOf('ARCHIVE_READBACK')).toBeLessThan(f.calls.indexOf('BUSINESS_WRITE'));
  f.terminal();expect(await f.currentFacts()).toMatchObject({unknownEvidence:[]});
  expect(f.files[0]!.content).toContain('"businessStartedProven":true');
});
it.each(['UNKNOWN','UNCHANGED','missing-readback'])('does not write business after %s start adoption',async mode=>{
  const f=fixture();let writes=0;f.store.archive=async files=>({status:mode==='missing-readback'?'APPLIED':mode,head:D,records:[],files:mode==='missing-readback'?[]:files});
  const result=await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{writes++;},NOW,()=>NOW);
  expect(result.publishInvoked).toBe(false);expect(writes).toBe(0);
});
it('an interrupted native terminal entry counts exactly once and an in-flight entry waits',async()=>{
  const f=fixture();await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{throw Error('interrupted');},NOW,()=>NOW);
  const flying=await f.currentFacts();expect(flying.inFlightWaveKeys).toHaveLength(1);
  f.terminal();expect(await f.currentFacts()).toMatchObject({});
  const repeated=await invokePublication(f.context,f.current,f.history,f.store,f.productIo,f.centralIo,async()=>{throw Error('must not repeat');},NOW,()=>NOW);
  expect(repeated.reason).toBe('PUBLICATION_ALREADY_INVOKED');
});
it('unknown object reads remain UNKNOWN and wrong native sources cannot publish',async()=>{
  const f=fixture();await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{},NOW,()=>NOW);f.terminal();f.setReadFailure();
  expect((await f.currentFacts()).outcomes).toContain('UNKNOWN');
  const g=fixture();g.run.head_sha=S;await expect(invokePublication(g.context,g.current,[],g.store,g.productIo,g.centralIo,async()=>{},NOW,()=>NOW)).rejects.toThrow('current central source');
});
it('readback of a changing native step blocks the business write',async()=>{
  const f=fixture(),original=f.store.archive;f.store.archive=async files=>{const result=await original(files);f.terminal();return result;};let calls=0;
  expect((await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{calls++;},NOW,()=>NOW)).reason).toBe('PUBLICATION_SOURCE_CHANGED');expect(calls).toBe(0);
});
it('retains product and central failure facts without a combined failure budget',async()=>{
  const f=fixture();await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{},NOW,()=>NOW);f.terminal();
  const publication=await inspectPublications(f.context,f.history,f.productIo,f.centralIo,NOW),product=evidenceFixture(2);
  const result=await inspectNativeCycle(product.context,[],product.io,NOW,{complete:true,observations:[],publication});
  expect(result.readObservation.disposition).toBe('COMPLETE');
});
it.each([410,403])('central HTTP %i uses only complete original coverage and never treats access loss as expiry',async status=>{
  const f=fixture();await invokePublication(f.context,f.current,[],f.store,f.productIo,f.centralIo,async()=>{},NOW,()=>NOW);f.terminal();
  const terminal=await inspectPublications(f.context,f.history,f.productIo,f.centralIo,'2026-10-26T00:03:00.000Z');await f.store.archive(terminal.files);
  const original=f.centralIo.request;f.centralIo.request=async(method,path,limit,body)=>path.endsWith('/actions/runs/900')?f.response({},status):original(method,path,limit,body);
  const recovered=await inspectPublications(f.context,f.history,f.productIo,f.centralIo,'2026-11-26T00:00:00.000Z');
  expect(recovered.native.runs[0]?.availability).toBe(status===410?'expired':undefined);
});
