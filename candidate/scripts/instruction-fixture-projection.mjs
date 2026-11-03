// E08 controller fixture only: the outer harness and candidate/ are two
// source roots in one repository. Preserve full carrier coverage for both.
import {mkdtemp,readFile,writeFile,mkdir,lstat,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {git} from './validation-input.mjs';
import {assertRepositoryInstructions} from '../packages/runner/dist/index.js';

export async function assertFixtureInstructions(workspace,expected,transition) {
  if(transition.repositoryId!==1440689456||!transition.templateSource)throw Error('INSTRUCTIONS_FIXTURE_IDENTITY');
  const carrier=path=>/(^|\/)(AGENTS(?:\.override)?\.md|\.github\/copilot-instructions\.md)$/.test(path)
    ||/(^|\/)\.github\/instructions\/.*\.instructions\.md$/.test(path);
  const paths=new TextDecoder('utf-8',{fatal:true}).decode(git(workspace,['ls-files','-z'])).split('\0').filter(carrier).sort();
  const allowed=['AGENTS.md','candidate/AGENTS.md','candidate/templates/repository/AGENTS.md','templates/repository/AGENTS.md'];
  if(JSON.stringify(paths)!==JSON.stringify(allowed))throw Error('INSTRUCTIONS_FIXTURE_INVENTORY');
  for(const path of allowed) {
    const parts=path.split('/');let current=workspace;
    for(const [index,part] of parts.entries()) {
      current=join(current,part);const info=await lstat(current);
      if(info.isSymbolicLink()||(index<parts.length-1?!info.isDirectory():!info.isFile()))throw Error('INSTRUCTIONS_FIXTURE_PATH_TYPE');
    }
  }
  await assertRepositoryInstructions(join(workspace,'candidate'),expected,transition);
  const projection=await mkdtemp(join(tmpdir(),'e08-instruction-harness-'));
  try {
    git(projection,['init','--quiet']);
    await mkdir(join(projection,'templates/repository'),{recursive:true});
    for(const path of ['AGENTS.md','templates/repository/AGENTS.md'])await writeFile(join(projection,path),await readFile(join(workspace,path)));
    git(projection,['add','--','AGENTS.md','templates/repository/AGENTS.md']);
    await assertRepositoryInstructions(projection,expected,transition);
  }finally{await rm(projection,{recursive:true,force:true});}
}
