// E08 repository/App identity binding; Pages source and deployment guards are unchanged.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const sha=value=>createHash('sha256').update(value).digest('hex');
export async function preparePagesRuntime(root,output) {
  root=resolve(root);output=resolve(output);
  const rel=relative(root,output);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('E08_PAGES_TARGET');
  const records=[],files=[];
  for(const name of ['select-pages-source.mjs','pages-runtime.mjs']) {
    const original=await readFile(join(root,'scripts',name)),replacements=[];
    let text=original.toString('utf8');
    const replace=(from,to,count=1)=>{
      if(text.split(from).length-1!==count)throw Error('E08_PAGES_ANCHOR');
      text=text.replaceAll(from,to);replacements.push({from,to,count});
    };
    replace("'../packages/runner/dist/index.js'",JSON.stringify(pathToFileURL(join(root,'e08-python/native/index.js')).href));
    if(name==='pages-runtime.mjs')replace("repository==='splrad/steward'","repository==='splrad/steward-e08-controller'");
    replace('301115370','350673636');
    files.push({name,text});
    records.push({path:'scripts/'+name,sourceSha256:sha(original),runtimeSha256:sha(text),replacements});
  }
  const bundleSha256=sha(await readFile(join(root,'e08-python/native/index.js')));
  await mkdir(output);await mkdir(join(output,'scripts'));
  for(const file of files)await writeFile(join(output,'scripts',file.name),file.text,{flag:'wx'});
  await writeFile(join(output,'package.json'),'{"type":"module"}\n',{flag:'wx'});
  const result={scope:'E08 controller/App identities only; all Pages source, artifact, permission and deployment checks retained',bundleSha256,records};
  await writeFile(join(output,'runtime-binding.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.length!==2)throw Error('E08_PAGES_ARGUMENTS');
  const root=fileURLToPath(new URL('..',import.meta.url));
  const result=await preparePagesRuntime(root,join(root,'.e08-pages-runtime'));
  console.log(JSON.stringify({status:'PREPARED',files:result.records.length,bundleSha256:result.bundleSha256}));
}
