import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import YAML from 'yaml';
import {validationInput,git,regular} from './validation-input.mjs';
import {assertRepositoryInstructions,discoverWorkflowFiles,scanWorkflows} from '../packages/runner/dist/index.js';
const workspace=resolve(process.env.VALIDATION_WORKSPACE??'target');
try {
const {input,scope,files}=await validationInput(workspace);
if(scope.governance.selected){
  git(workspace,['-c','core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol','diff','--check',input.base,input.head]);
  for(const path of files.filter(p=>/\.(?:json|ya?ml)$/.test(p))){
    const text=await readFile(await regular(workspace,path),'utf8');
    if(path.endsWith('.json'))JSON.parse(text);else YAML.parse(text);
  }
  await assertRepositoryInstructions(workspace,await readFile(new URL('../templates/repository/AGENTS.md',import.meta.url)));
  console.log(JSON.stringify(await scanWorkflows(workspace,await discoverWorkflowFiles(workspace,true)),null,2));
}else console.log('governance: not-applicable (complete trusted diff)');
}catch(error){console.error(error.message);process.exitCode=1;}
