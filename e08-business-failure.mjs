// Synthetic business failure: no package, deployment, Release or external write.
import {createHash} from 'node:crypto';
import {prepareBuildDispatch} from './candidate/packages/runner/dist/index.js';
const repository=process.env.GITHUB_REPOSITORY,repositoryId=Number(process.env.GITHUB_REPOSITORY_ID),runId=Number(process.env.GITHUB_RUN_ID),attempt=Number(process.env.GITHUB_RUN_ATTEMPT);
if(repository!=='splrad/steward-e08-controller'||repositoryId!==1440689456||process.env.GITHUB_SHA!==process.env.SOURCE||process.env.GITHUB_ACTOR_ID!=='350673636')throw Error('E08_SCOPE');
const read=async path=>{const r=await fetch(`https://api.github.com/repos/${repository}/${path}`,{headers:{authorization:`Bearer ${process.env.GH_TOKEN}`,accept:'application/vnd.github+json','x-github-api-version':'2026-03-10'}});if(r.status!==200)throw Error('E08_READ');return r.json();};
const run=await read(`actions/runs/${runId}`),page=await read(`actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
if(page.jobs.length!==page.total_count||run.run_attempt!==attempt||run.head_sha!==process.env.SOURCE)throw Error('E08_NATIVE_SOURCE');
const jobs=page.jobs.filter(j=>j.name==='synthetic-business'&&j.status==='in_progress');
if(jobs.length!==1)throw Error('E08_JOB');
const job=jobs[0],steps=job.steps.filter(s=>s.name==='business-synthetic'&&s.status==='in_progress');
if(steps.length!==1)throw Error('E08_STEP');
const step=steps[0],source=process.env.SOURCE,cycle={id:process.env.CYCLE,prNumber:105,sourceSha:source,controllerSha:process.env.CONTROLLER,deliveryConfigSha:source,
 units:[{id:'app',version:'1.0.0',tag:'v1.0.0',releaseId:null,assets:[],notesDigest:null,manifestDigest:null}],requiredChannels:[],dispatches:[],publications:[],channelFacts:[],executionEvidence:[],completionObservations:[],completedEvidencePath:null,repairOf:null,approvedRepairDecision:null};
const request=prepareBuildDispatch({repository,repositoryId,appBotId:350673636,cycle},run.workflow_id,run.created_at),startedAt=new Date().toISOString();
if(request.operationKey!==process.env.OPERATION_KEY)throw Error('E08_REQUEST');
const invocationKey=createHash('sha256').update(JSON.stringify([repositoryId,cycle.id,run.workflow_id,runId,attempt,'build',job.id,step.number,'app',null,request.inputDigest])).digest('hex');
const result={schemaVersion:1,sourceSha:source,executionSha:source,stepNumber:step.number,reasonCode:'RESULT',objects:[],
 execution:{repositoryId,cycleId:cycle.id,workflowId:run.workflow_id,runId,runAttempt:attempt,entry:'build',jobId:job.id,unitId:'app',channelId:null,invocationKey,inputDigest:request.inputDigest,
  startedAt,businessStartedProven:true,nativeEvidencePath:`evidence/executions/${invocationKey}.json`,outcome:null,completedAt:null,objectEvidencePaths:[],observedAt:startedAt}};
console.log('BUSINESS_STARTED '+JSON.stringify(result));
result.execution.outcome='BUSINESS_FAILED';result.execution.completedAt=new Date().toISOString();result.execution.observedAt=result.execution.completedAt;
console.log('STEWARD_RESULT '+JSON.stringify(result));process.exitCode=1;
