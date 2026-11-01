import {expect,it,vi} from 'vitest';
import {mkdtemp,readFile,writeFile,mkdir,rm,cp,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {assertRepositoryInstructions} from '../src/repository-instructions.js';
import {main} from '../src/index.js';

const expected=()=>readFile('templates/repository/AGENTS.md');
it.each(['missing','edited','crlf','bom','no-newline','extra-newline','directory','link','override','copilot','runtime'])('rejects incomplete or competing instruction carrier: %s',async kind=>{
  const root=await mkdtemp(join(tmpdir(),'repository-instructions-'));
  try {
    const bytes=await expected(),path=join(root,'AGENTS.md');
    if(kind==='directory')await mkdir(path);
    else if(kind==='link')await symlink(root,path,process.platform==='win32'?'junction':'dir');
    else if(kind!=='missing')await writeFile(path,kind==='edited'?Buffer.from('Changed\n'):kind==='crlf'?Buffer.from(bytes.toString().replaceAll('\n','\r\n')):
      kind==='bom'?Buffer.concat([Buffer.from([239,187,191]),bytes]):kind==='no-newline'?bytes.subarray(0,-1):kind==='extra-newline'?Buffer.concat([bytes,Buffer.from('\n')]):bytes);
    if(['override','copilot','runtime'].includes(kind)) {
      const extra=kind==='override'?'AGENTS.override.md':kind==='copilot'?'.github/copilot-instructions.md':'.github/instructions/runtime.instructions.md';
      await mkdir(join(root,'.github/instructions'),{recursive:true});await writeFile(join(root,extra),'Human text\n');
    }
    await expect(assertRepositoryInstructions(root,bytes)).rejects.toThrow('INSTRUCTIONS_');
    if(kind==='runtime')expect(await readFile(join(root,'.github/instructions/runtime.instructions.md'),'utf8')).toBe('Human text\n');
  }finally{await rm(root,{recursive:true,force:true});}
});
it.each(['managed-sync','render-review-instructions'])('retired %s cannot reach credentials or transport',async command=>{
  const network=vi.fn(()=>{throw Error('No transport');});vi.stubGlobal('fetch',network);vi.stubEnv('STEWARD_APP_PRIVATE_KEY','');
  try{await expect(main([command])).rejects.toThrow('未知命令');expect(network).not.toHaveBeenCalled();}
  finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
});
