import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Read the actual repository carrier against the complete trusted template. Never rewrites files. */
export async function assertRepositoryInstructions(workspace:string, expected:Buffer):Promise<void> {
  const body=expected.toString('utf8');
  if(!expected.equals(Buffer.from(body))||body.startsWith('\uFEFF')||body.includes('\r')||!body.endsWith('\n')||body.endsWith('\n\n')||!body.includes('## Code Review Rules'))
    throw Error('INSTRUCTIONS_TEMPLATE_INVALID');
  for(const path of ['AGENTS.md','AGENTS.override.md','.github/copilot-instructions.md','.github/instructions/runtime.instructions.md']) {
    let current=workspace,present=true;
    const parts=path.split('/');
    for(const [index,part] of parts.entries()) {
      current=join(current,part);let metadata;
      try{metadata=await lstat(current);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){present=false;break;}throw error;}
      if(metadata.isSymbolicLink()||(index<parts.length-1?!metadata.isDirectory():!metadata.isFile()))throw Error('INSTRUCTIONS_PATH_TYPE: '+path);
    }
    if(path==='AGENTS.md') {
      if(!present||!(await readFile(current)).equals(expected))throw Error('INSTRUCTIONS_BYTES_DIFFER: AGENTS.md');
    }else if(present)throw Error('INSTRUCTIONS_CARRIER_REQUIRES_MIGRATION: '+path);
  }
}
