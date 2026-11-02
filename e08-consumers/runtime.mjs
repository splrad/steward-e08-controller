// E08 isolated native consumer entry. Production functions are imported with recorded identity bindings.
import {readFile,writeFile,mkdir,mkdtemp} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {stripTypeScriptTypes} from 'node:module';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const tree=process.cwd(),mode=process.argv[2],env=process.env;
const hash=value=>createHash('sha256').update(value).digest('hex');
const check=(value,code)=>{if(!value)throw Error(code);};
check(['bootstrap','templates','candidate','quality'].includes(mode),'CONSUMER_MODE');
check(env.GITHUB_REPOSITORY==='splrad/steward-e08-controller'&&env.GITHUB_REPOSITORY_ID==='1440689456'
  &&env.GITHUB_REF==='refs/heads/e08-channel-trunk'&&env.GITHUB_EVENT_NAME==='workflow_dispatch','CONSUMER_ENTRY');
const output=resolve('consumer-evidence');await mkdir(output,{recursive:true});
const bound=await mkdtemp(join(tree,'.e08-bound-')),root=await mkdtemp(join(tmpdir(),'e08-consumer-'));
const evidence={mode,runId:Number(env.GITHUB_RUN_ID),runAttempt:Number(env.GITHUB_RUN_ATTEMPT),controllerSha:env.GITHUB_SHA,
  observedAt:new Date().toISOString(),bindings:[],minted:[],revocations:[],results:[],modelCalls:0};
const tokens=[];let qualityResponseLost=false;
const transport=async(input,init)=>{
  const url=new URL(String(input)),method=init?.method??'GET';
  check(url.origin==='https://api.github.com','CONSUMER_HOST');
  const response=await fetch(input,init);
  if(method==='POST'&&url.pathname.endsWith('/access_tokens')){
    const value=await response.clone().json();
    evidence.minted.push({requested:JSON.parse(init.body),status:response.status,granted:value.permissions});
    if(value.token)tokens.push(value.token);
  }
  if(mode==='quality'&&!qualityResponseLost&&method==='POST'&&url.pathname==='/repos/splrad/steward-e08-bootstrap/check-runs'
    &&JSON.parse(init.body??'{}').name==='SPLRAD Quality 中文说明'&&response.ok){
    qualityResponseLost=true;evidence.acceptedCheckResponseLost=true;await response.body?.cancel();throw Error('E08_ACCEPTED_CHECK_RESPONSE_LOST');
  }
  return response;
};
const fileUrl=path=>pathToFileURL(resolve(tree,path)).href;
async function bind(path,replacements=[],typescript=false){
  const original=await readFile(resolve(tree,path),'utf8');let text=original;
  for(const [a,b] of replacements){check(text.includes(a),'BINDING_MISSING');text=text.replaceAll(a,b);}
  text=text.replace(/(from\s+|import\s*)'((?:\.\.?\/)[^']+)'/g,(_all,prefix,spec)=>prefix+"'"+pathToFileURL(resolve(tree,dirname(path),spec)).href+"'");
  if(typescript)text=stripTypeScriptTypes(text,{mode:'strip'});
  const target=join(bound,path.replaceAll('/','_').replace(/\.(ts|mjs)$/,'')+'.mjs');
  await writeFile(target,text,{flag:'wx'});
  evidence.bindings.push({source:path,sourceSha256:hash(original),boundSha256:hash(text),replacements});
  return pathToFileURL(target).href;
}
try{
const runner=await import(fileUrl('packages/runner/dist/index.js'));
const identities=[['4243096','5553347'],['301115370','350673636'],['splrad-steward[bot]','splrad-e08-release[bot]']];
const record=await bind('scripts/release-record.mjs',[['actor_id!==4243096','actor_id!==5553347']]);
const quality=await bind('scripts/quality-language-summary.mjs',[...identities,["'./release-record.mjs'","'"+record+"'"]]);
const auth=await bind('packages/github/src/app-auth.ts',[...identities.slice(0,2),['Iv23liuSr0qd4WLJdZhH','Iv23liu2OIRtzR11gmWk'],
  ["import { GITHUB_API_VERSION } from './api-version.js';","const GITHUB_API_VERSION='2026-03-10';"]],true);
const repository={id:1440689606,full_name:'splrad/steward-e08-bootstrap',default_branch:'main'};
  if(mode==='bootstrap'){
    const bootstrap=await bind('scripts/repository-bootstrap.mjs',[
      ['splrad/steward','splrad/steward-e08-controller'],['1296724484','1440689456'],['4243096','5553347'],
      ["'./release-record.mjs'","'"+record+"'"],["'./quality-language-summary.mjs'","'"+quality+"'"]]);
    for(let pass=1;pass<=2;pass++){
      const counts=await (await import(bootstrap)).main(transport);
      evidence.results.push({pass,counts,sample:'Existing repository continuation; prior empty-repository windows retained'});
      check(!process.exitCode&&counts.repositories===3&&counts.existing===3&&counts.ready===0&&counts.failed===0,'BOOTSTRAP_CONSUMER_FAILED');
    }
  }else{
    const app=await (await import(auth)).nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY,transport);
    const repositories=await app.discover();check(repositories.length===3&&repositories.some(r=>r.id===repository.id),'INSTALLATION_SCOPE');
    evidence.discovered=repositories.map(r=>({id:r.id,repository:r.full_name}));
    if(mode==='templates'){
      const {templateWake,deliverRepositoryTemplate}=await import(fileUrl('scripts/template-delivery.mjs'));
      const uv=await runner.resolvePolicyTool('uv'),selection=join(root,'selection.json');
      await promisify(execFile)(uv,['run','--project','tools/template','--frozen','--no-sync','python','tools/template/copier_bridge.py','select',
        '--central',tree,'--template-sha',env.GITHUB_SHA,'--output',selection],{env:runner.isolatedBuildEnvironment(env,join(root,'selection-profile')),timeout:120000});
      const {templateSha,tag}=JSON.parse(await readFile(selection,'utf8'));evidence.template={templateSha,tag};
      for(let pass=1;pass<=2;pass++){
        const counts=await templateWake({discover:async()=>repositories.filter(r=>r.id===repository.id),deliver:r=>app.forTemplateRepository(r.id,async(writeToken,readToken)=>{
          const result=await deliverRepositoryTemplate({repository:r.full_name,repositoryId:r.id,defaultBranch:r.default_branch,
            runId:Number(env.GITHUB_RUN_ID),workflowSha:env.GITHUB_SHA,templateSha,bot:{id:app.appBotId,login:app.appBotLogin}},
            {writeToken,readToken,centralReadToken:env.GITHUB_TOKEN},{root});
          evidence.results.push({pass,...result});return result;
        })});evidence.results.push({pass,counts});check(!counts.failed&&!counts.deferred,'TEMPLATE_CONSUMER_FAILED');
      }
    }else if(mode==='candidate'){
      const candidate=await bind('scripts/release-candidate.mjs',[["'./release-record.mjs'","'"+record+"'"]]);
      const directory=join(root,'target');await mkdir(directory);
      const clean=runner.isolatedBuildEnvironment(env,join(root,'candidate-profile'));
      let readCredential='';
      const git=async(...args)=>(await promisify(execFile)('git',['--no-replace-objects','-c','core.hooksPath=','-c','credential.helper=',...args],{cwd:directory,
        env:{...clean,...(readCredential?{GIT_CONFIG_COUNT:'1',GIT_CONFIG_KEY_0:'http.https://github.com/'+repository.full_name+'.git.extraheader',
          GIT_CONFIG_VALUE_0:'AUTHORIZATION: basic '+Buffer.from('x-access-token:'+readCredential).toString('base64')}:{})},timeout:90000})).stdout.trim();
      await git('init','--initial-branch=main');await git('remote','add','origin','https://github.com/'+repository.full_name+'.git');
      const request={directory,writeDirectory:join(root,'candidate-writes'),remote:'https://github.com/'+repository.full_name+'.git',repository:repository.full_name,
        repositoryId:repository.id,defaultBranch:'main',appBotId:app.appBotId,identity:{name:app.appBotLogin,email:app.appBotId+'+'+app.appBotLogin+'@users.noreply.github.com'}};
      const stateSnapshot=async()=>{
        await git('fetch','--no-tags',request.remote,'refs/heads/steward/release-state');
        const head=await git('rev-parse','FETCH_HEAD');
        await git('update-ref','refs/heads/steward/release-state',head);
        const state=await (await import(record)).readReleaseRecords({directory,targetRef:'steward/release-state',repositoryId:repository.id});
        check(state.head===head&&Boolean(state.repository.activeCycleId),'CANDIDATE_ACTIVE_CYCLE_REQUIRED');
        return {head,cycleId:state.repository.activeCycleId,stateDigest:hash(await git('show',head+':state.json')),
          cycleDigest:hash(await git('show',head+':cycles/'+state.repository.activeCycleId+'.json'))};
      };
      let before;
      const language={preflight:async()=>{throw Error('MODEL_PREFLIGHT_NOT_EXPECTED');},call:async()=>{evidence.modelCalls++;throw Error('MODEL_CALL_NOT_EXPECTED');}};
      for(let pass=1;pass<=2;pass++){
        await app.forCandidateRepository(repository.id,async(token,readToken)=>{
          readCredential=readToken;
          try{
            if(!before){before=await stateSnapshot();evidence.candidateBefore=before;}
            const result=await awaitCandidate(token,readToken),after=await stateSnapshot();evidence.results.push({pass,...result,state:after});
            check(result.status==='WAIT'&&result.reason==='ACTIVE_CYCLE','CANDIDATE_CONSUMER_RESULT');
            check(JSON.stringify(after)===JSON.stringify(before),'CANDIDATE_CYCLE_CHANGED');
          }finally{readCredential='';}
        });
      }
      async function awaitCandidate(token,readToken){return (await import(candidate)).nativeReleaseCandidate(request,{token,readToken,
        controllerSha:env.GITHUB_SHA,controllerDirectory:tree,language,fetcher:transport,temporaryRoot:root});}
      check(evidence.modelCalls===0,'PENDING_CYCLE_MODEL_CALL');
    }else{
      const {qualityNativeIO,openQualityStore}=await import(quality);
      await app.forQualityRepository(repository.id,async token=>{
        const io=qualityNativeIO(repository.full_name,token,transport),prs=await runner.qualityPages(io,`/repos/${repository.full_name}/pulls?state=open`);
        check(prs.length>0,'QUALITY_OPEN_PR_REQUIRED');
        const pr=prs.find(p=>p.head.ref==='steward/managed-sync')??prs[0];evidence.qualityPull={number:pr.number,head:pr.head.sha};
        const ownChecks=await runner.qualityPages(io,`/repos/${repository.full_name}/commits/${pr.head.sha}/check-runs?filter=all`,'check_runs');
        check(!ownChecks.some(c=>c.app?.id===5553347&&c.name==='SPLRAD Quality 中文说明'),'QUALITY_FRESH_HEAD_REQUIRED');
        evidence.qualitySample='Fresh PR head for accepted Check-create response loss; second pass reuses persisted cache';
        // Synthetic input is created only in the authorized test repository. Native collection and output use production functions.
        const sourceName='E08 Quality Source Fixture',externalId='e08-quality-source:'+pr.number+':'+pr.head.sha;
        const lookup=async()=> (await runner.qualityPages(io,`/repos/${repository.full_name}/commits/${pr.head.sha}/check-runs?filter=all`,'check_runs'))
          .filter(c=>c.app?.id===5553347&&c.name===sourceName&&c.external_id===externalId);
        let checks=await lookup();check(checks.length<=1,'QUALITY_FIXTURE_DUPLICATE');
        if(!checks.length){
          const response=await transport(`https://api.github.com/repos/${repository.full_name}/check-runs`,{method:'POST',
            headers:{authorization:'Bearer '+token,'content-type':'application/json','x-github-api-version':'2026-03-10'},
            body:JSON.stringify({name:sourceName,head_sha:pr.head.sha,external_id:externalId,status:'completed',conclusion:'neutral',
              output:{title:sourceName,summary:'Synthetic source for E08 native consumer acceptance.',annotations:[{path:'README.md',start_line:1,end_line:1,annotation_level:'notice',
                title:'E08 synthetic finding',message:'This synthetic finding tests the Chinese summary cache and native Check readback. Its impact is limited to E08 isolation. Preserve the source record and verify the owned Check and cache.'}]}})});
          check(response.status===201,'QUALITY_FIXTURE_CREATE');await response.body?.cancel();checks=await lookup();
        }
        check(checks.length===1&&checks[0].pull_requests.some(p=>p.number===pr.number&&p.base?.repo?.id===repository.id),'QUALITY_FIXTURE_PR_BINDING');
        evidence.qualitySource={id:checks[0].id,head:pr.head.sha,appId:5553347,kind:'native Check with explicit synthetic annotation'};
        const language={preflight:async()=>({status:'READY'}),call:async items=>{
          evidence.modelCalls++;
          check(items.every(item=>item.sourceCommentId.startsWith('annotation:'+checks[0].id+':')),'QUALITY_FIXTURE_SOURCE_ONLY');
          return {items:items.map(({bodyMarkdown,...item})=>({...item,problemZh:'这是用于验证中文说明缓存和原生 Check 回读的合成发现。',impactZh:'影响仅限 E08 隔离验收。',
            suggestionZh:'保留源记录，并核对自身 Check 与缓存的回读结果。'})),model:'e08-fixed-translation-fixture',usage:{inputTokens:0,outputTokens:0}};
        }};
        let firstPassCalls=null;
        for(let pass=1;pass<=2;pass++){
          const state=await openQualityStore(root,repository,token,io,5553375);
          const result=await runner.serviceQualityPullRequest({repository:repository.full_name,repositoryId:repository.id,pullRequestNumber:pr.number,
            head:pr.head.sha,appId:5553347,configVersion:'e08-native-independent-v1'},[{kind:'annotation',id:5553347,login:'splrad-e08-release'}],
            state.cache(pr.number),io,state.forPull(pr.number),language,{remaining:10,deadline:Date.now()+12*60000});
          evidence.results.push({pass,total:result.total,complete:result.complete,pending:result.pending,modelCalls:evidence.modelCalls});
          if(pass===1)firstPassCalls=evidence.modelCalls;
          check(result.total===1&&result.complete===1&&result.pending===0&&firstPassCalls===1&&evidence.modelCalls===firstPassCalls&&qualityResponseLost,'QUALITY_REPLAY');
        }
      });
    }
  }
  evidence.status='PASS';
}catch(error){evidence.status='FAIL';evidence.error=/^[A-Z][A-Z0-9_: -]+$/.test(error.message)?error.message:'CONSUMER_UNAVAILABLE';process.exitCode=1;}
finally{
  for(const token of tokens){
    const headers={authorization:'Bearer '+token,'x-github-api-version':'2026-03-10'};
    let response=await fetch('https://api.github.com/installation/repositories',{headers});await response.body?.cancel();
    const result={status:response.status};
    if(response.status!==401){response=await fetch('https://api.github.com/installation/token',{method:'DELETE',headers});result.revokeStatus=response.status;await response.body?.cancel();
      response=await fetch('https://api.github.com/installation/repositories',{headers});result.finalStatus=response.status;await response.body?.cancel();}
    evidence.revocations.push(result);if((result.finalStatus??result.status)!==401){evidence.status='FAIL';process.exitCode=1;}
  }
  await writeFile(join(output,mode+'.json'),JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({mode,status:evidence.status,results:evidence.results,error:evidence.error}));
}
