import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeReleaseApp,nativeEvidenceTransport,nativeRunFact,isolatedBuildEnvironment} from './native/index.js';
import {fixtureRepository,fixtureRepositoryId,auditFixtureSnapshot} from './legacy-state-fixture.mjs';

const controller='splrad/steward-e08-controller',controllerId=1440689456,branch='e08-channel-trunk';
const sourceRoot=fileURLToPath(new URL('..',import.meta.url));
const positive=value=>/^[1-9][0-9]*$/.test(value??'')&&Number.isSafeInteger(Number(value));
export function executionContext(env) {
  if(env.GITHUB_REPOSITORY!==controller||env.GITHUB_REPOSITORY_ID!==String(controllerId)||env.GITHUB_REF!==`refs/heads/${branch}`
    ||env.GITHUB_EVENT_NAME!=='workflow_dispatch'||env.GITHUB_WORKFLOW_REF!==`${controller}/.github/workflows/release.yml@refs/heads/${branch}`
    ||!/^[a-f0-9]{40}$/.test(env.GITHUB_WORKFLOW_SHA??'')||env.GITHUB_SHA!==env.GITHUB_WORKFLOW_SHA
    ||!positive(env.GITHUB_RUN_ID)||!positive(env.GITHUB_RUN_ATTEMPT)||!positive(env.E08_ADOPTION_PR))throw Error('E08_CENTRAL_IDENTITY');
  return {runId:Number(env.GITHUB_RUN_ID),runAttempt:Number(env.GITHUB_RUN_ATTEMPT),controllerSha:env.GITHUB_WORKFLOW_SHA,
    defaultBranch:branch,adoptionPr:Number(env.E08_ADOPTION_PR)};
}
export function centralReadOnly(transport) {
  return {request(method,path,...args) {
    if(method!=='GET'||typeof path!=='string'||!path.startsWith(`/repos/${controller}/`)&&path!==`/repos/${controller}`
      ||path.includes('..')||/[\\\0]/.test(path)||/%(?:2e|2f|5c)/i.test(path))throw Error('E08_CENTRAL_READ_ONLY');
    return transport.request(method,path,...args);
  }};
}
async function json(io,path) {
  const response=await io.request('GET',path);if(response.status!==200)throw Error('E08_NATIVE_READ_UNAVAILABLE');
  return JSON.parse(Buffer.from(response.bytes).toString('utf8'));
}
export async function verifyCentral(context,io) {
  const repository=await json(io,`/repos/${controller}`);
  const run=nativeRunFact(await json(io,`/repos/${controller}/actions/runs/${context.runId}/attempts/${context.runAttempt}`));
  const workflow=await json(io,`/repos/${controller}/actions/workflows/${run.workflowId}`);
  if(repository.id!==controllerId||repository.full_name!==controller||repository.default_branch!==branch||repository.archived!==false||repository.disabled!==false
    ||run.id!==context.runId||run.runAttempt!==context.runAttempt||run.repositoryId!==controllerId||run.headRepositoryId!==controllerId
    ||run.headSha!==context.controllerSha||run.headBranch!==branch||run.event!=='workflow_dispatch'||run.status!=='in_progress'
    ||run.path!=='.github/workflows/release.yml'||workflow.id!==run.workflowId||workflow.path!==run.path||workflow.state!=='active')throw Error('E08_NATIVE_CENTRAL_IDENTITY');
  return run;
}
export async function main(env=process.env) {
  const context=executionContext(env),root=await mkdtemp(join(tmpdir(),'e08-python-release-'));
  try {
    const gitEnv=isolatedBuildEnvironment(env,root);
    const head=(await promisify(execFile)('git',['--no-replace-objects','rev-parse','HEAD'],{cwd:sourceRoot,env:gitEnv,encoding:'utf8',windowsHide:true})).stdout.trim();
    if(head!==context.controllerSha)throw Error('E08_CHECKOUT_IDENTITY');
    const centralIo=centralReadOnly(nativeEvidenceTransport(env.STEWARD_CENTRAL_TOKEN));await verifyCentral(context,centralIo);
    const app=await nativeReleaseApp(env.STEWARD_APP_PRIVATE_KEY??'');
    if(app.appBotId!==350673636||app.appBotLogin!=='splrad-e08-release[bot]')throw Error('E08_APP_IDENTITY');
    const {fetchState,serviceReleaseWake}=await import('../.e08-python-runtime/scripts/release-coordinator.mjs');
    const {initializeReleaseAdoption}=await import('../.e08-python-runtime/scripts/release-adoption.mjs');
    const {releaseCommand}=await import('../.e08-python-runtime/scripts/release-record.mjs');
    return await app.forRepository(fixtureRepositoryId,async token=>{
      const repository={id:fixtureRepositoryId,full_name:fixtureRepository,default_branch:'main'};
      const writeDirectory=await mkdtemp(join(root,'writes-'));let state;
      const request={directory:'',writeDirectory,remote:`https://github.com/${fixtureRepository}.git`,repository:fixtureRepository,repositoryId:fixtureRepositoryId,
        defaultBranch:'main',appBotId:app.appBotId,cycleId:null,runId:null,identity:{name:app.appBotLogin,email:`${app.appBotId}+${app.appBotLogin}@users.noreply.github.com`}};
      const refresh=async()=>{
        state=await fetchState(root,repository,token);request.directory=state.directory;
        await auditFixtureSnapshot(request,state.snapshot.head);return state.snapshot;
      };
      await refresh();
      const pull=await json(state.io,`/repos/${fixtureRepository}/pulls/${context.adoptionPr}`);
      if(pull.number!==context.adoptionPr||pull.merged!==true||!/^[a-f0-9]{40}$/.test(pull.merge_commit_sha??''))throw Error('E08_MERGED_ADOPTION_REQUIRED');
      const {cycleId,runId,...adoptionRequest}=request;
      const adoption=await initializeReleaseAdoption({...adoptionRequest,releaseAdoption:{sourceSha:pull.merge_commit_sha,prNumber:context.adoptionPr}},{token,io:state.io,centralIo});
      if(!['APPLIED','UNCHANGED'].includes(adoption.status))throw Error('E08_ADOPTION_UNCONFIRMED');
      const result=await serviceReleaseWake(request,refresh,async(command,input)=>command==='candidate'
        ?app.forCandidateRepository(fixtureRepositoryId,(candidateToken,candidateReadToken)=>releaseCommand(command,{...input,directory:request.directory},
          {token:candidateToken,io:state.io,centralIo,candidateReadToken,controllerSha:context.controllerSha,controllerDirectory:sourceRoot}))
        :releaseCommand(command,{...input,directory:request.directory},{token,io:state.io,centralIo,controllerDirectory:sourceRoot,
          centralInvocation:{runId:context.runId,runAttempt:context.runAttempt,controllerSha:context.controllerSha,defaultBranch:branch}}));
      const snapshot=await refresh();
      return {schemaVersion:1,scope:'E08 Python fixture only',contentSdk:'E08_FIXED_NO_MODEL',context,repository:fixtureRepository,repositoryId:fixtureRepositoryId,
        adoption,result,stateHead:snapshot.head,revision:snapshot.repository.revision,activeCycleId:snapshot.repository.activeCycleId,
        candidate:snapshot.repository.candidate,cycleIds:snapshot.cycles.map(record=>record.value.id)};
    });
  }finally{await rm(root,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.length!==2)throw Error('E08_WORKER_ARGUMENTS');
  try {
    const result=await main();await mkdir(join(sourceRoot,'e08-results'),{recursive:true});
    await writeFile(join(sourceRoot,'e08-results/release-wake.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify({status:result.result.status,reason:result.result.reason??null,stateHead:result.stateHead,activeCycleId:result.activeCycleId,contentSdk:result.contentSdk}));
    if(['UNKNOWN','CONFLICT','BLOCKED','FAILED'].includes(result.result.status))process.exitCode=1;
  }catch(error){console.error((error instanceof Error&&/^(?:E08|RELEASE|CANDIDATE|CONTENT)_[A-Z_]+$/.test(error.message))?error.message:'E08_NATIVE_WAKE_UNAVAILABLE');process.exitCode=1;}
}
