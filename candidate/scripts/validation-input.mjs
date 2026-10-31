import {execFileSync} from 'node:child_process';
import {readFile,appendFile,writeFile,lstat,realpath} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {selectValidationScope} from './select-validation-scope.mjs';
const check=(ok,code)=>{if(!ok)throw Error('VALIDATION_'+code);};
export function parseNameStatus(bytes) {
  const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  check(!text||text.endsWith('\0'),'DIFF_TERMINATOR');const fields=text?text.slice(0,-1).split('\0'):[],changes=[];
  while(fields.length){const status=fields.shift(),count=/^[RC]\d{1,3}$/.test(status)?2:1;
    check(/^[AMDT]$/.test(status)||/^[RC](?:100|[0-9]{1,2})$/.test(status),'DIFF_STATUS');
    check(fields.length>=count,'DIFF_PATH');changes.push({status,paths:fields.splice(0,count)});}
  return changes;
}
export function git(workspace,args) {
  return execFileSync('git',['--no-replace-objects','-c','core.hooksPath=','-c','credential.helper=',...args],
    {cwd:workspace,encoding:'buffer',maxBuffer:128*1024*1024,timeout:60000,windowsHide:true});
}
export async function regular(workspace,path) {
  const root=await realpath(workspace),file=join(root,path),actual=await realpath(file),info=await lstat(file);
  check(actual.startsWith(root+sep)&&info.isFile()&&!info.isSymbolicLink(),'FILE_BOUNDARY');return file;
}
export async function validationInput(workspace,env=process.env) {
  const event=JSON.parse(await readFile(env.GITHUB_EVENT_PATH,'utf8'));
  check(env.WORKFLOW_REPOSITORY==='splrad/steward'&&env.WORKFLOW_PATH==='.github/workflows/pr-validation-native.yml'
    &&/^[a-f0-9]{40}$/.test(env.WORKFLOW_SHA),'TRUSTED_SOURCE');
  const repositoryId=Number(env.GITHUB_REPOSITORY_ID);
  check(repositoryId===event.repository?.id&&event.repository?.full_name===env.GITHUB_REPOSITORY,'REPOSITORY');
  let base,head;
  if(env.GITHUB_EVENT_NAME==='pull_request'){
    check(event.pull_request?.base?.repo?.id===repositoryId,'PULL_SOURCE');
    base=event.pull_request.base.sha;head=event.pull_request.head.sha;
    const ref=event.pull_request.base.ref;
    git(workspace,['check-ref-format','--branch',ref]);
    check(git(workspace,['rev-parse','--verify',`refs/remotes/origin/${ref}^{commit}`]).toString().trim()===base,'BASE_MOVED');
  }else{check(env.GITHUB_EVENT_NAME==='push'&&event.ref==='refs/heads/main','EVENT');base=event.before;head=event.after;}
  check([base,head].every(v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)&&!/^0+$/.test(v)),'COMMITS');
  for(const value of [base,head])check(git(workspace,['rev-parse','--verify',value+'^{commit}']).toString().trim()===value,'COMMITS');
  check(git(workspace,['rev-parse','HEAD']).toString().trim()===head,'CHECKOUT');
  check(git(workspace,['rev-parse','--is-shallow-repository']).toString().trim()==='false','SHALLOW');
  const changes=parseNameStatus(git(workspace,['diff','--no-ext-diff','--no-textconv','--name-status','-z','-M',base,head]));
  const input={complete:true,repositoryId,base,head,workflowSha:env.WORKFLOW_SHA,changes};
  const scope=selectValidationScope(input),files=git(workspace,['ls-files','-z']).toString('utf8').split('\0').filter(Boolean);
  const node=files.includes('package.json'),dotnet=files.includes('CADFontAutoReplace.slnx')&&files.includes('global.json');
  check(!(node&&dotnet),'AMBIGUOUS_BUILD');
  const mode=node?'node':dotnet?'dotnet':'none';
  check(mode!=='none'||!files.some(p=>/\.(?:[cm]?[jt]sx?|cs|py|go|rs|java|cpp|c)$/.test(p)),'UNSUPPORTED_BUILD');
  return {input,scope,files,mode};
}
export async function main(env=process.env) {
  const workspace=resolve(env.VALIDATION_WORKSPACE??'target'),value=await validationInput(workspace,env);
  if(env.GITHUB_OUTPUT)await appendFile(env.GITHUB_OUTPUT,Object.entries({...Object.fromEntries(Object.entries(value.scope).map(([k,v])=>[k,String(v.selected)])),mode:value.mode,base:value.input.base,head:value.input.head}).map(([k,v])=>`${k}=${v}\n`).join(''));
  if(env.VALIDATION_EVIDENCE)await writeFile(env.VALIDATION_EVIDENCE,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,'```json\n'+JSON.stringify({identity:value.input,scope:value.scope,mode:value.mode},null,2)+'\n```\n');
  return value;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
