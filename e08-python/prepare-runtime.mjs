import {readFile,writeFile,mkdir,readdir,copyFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';

const hash=value=>createHash('sha256').update(value).digest('hex');
export async function prepareRuntime(root,output) {
  root=resolve(root);output=resolve(output);
  const rel=relative(root,output);if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('E08_RUNTIME_TARGET');
  await mkdir(output);await mkdir(join(output,'scripts'));await mkdir(join(output,'e08-python'));
  const records=[];
  const bundle=pathToFileURL(join(root,'e08-python/native/index.js')).href;
  for(const entry of await readdir(join(root,'scripts'),{withFileTypes:true})) {
    if(!entry.isFile())continue;
    const file=join(root,'scripts',entry.name),original=await readFile(file);
    if(!entry.name.endsWith('.mjs')){await copyFile(file,join(output,'scripts',entry.name));continue;}
    let text=original.toString('utf8').replaceAll('\r\n','\n');const replacements=[];
    const replace=(from,to,count=1)=>{const actual=text.split(from).length-1;if(actual!==count)throw Error('E08_RUNTIME_ANCHOR '+entry.name+' '+from);text=text.replaceAll(from,to);replacements.push({from,to,count});};
    for(const quote of ["'",'"']) {
      const from=quote+'../packages/runner/dist/index.js'+quote,count=text.split(from).length-1;
      if(count)replace(from,JSON.stringify(bundle),count);
    }
    if(entry.name==='release-record.mjs') {
      text="import {auditedLegacyFiles} from '../e08-python/legacy-state-fixture.mjs';\n"+text;
      replace('rule.bypass_actors[0].actor_id!==4243096','rule.bypass_actors[0].actor_id!==5553347');
      replace('const files=new Map(),names=new Set();if(commit===null)return files;',
        'const files=new Map(),names=new Set();if(commit===null)return files;\n      const retained=await auditedLegacyFiles(request,commit,required);');
      replace('const [, ,oid,path]=match;\n        stateRecordOwner(request.targetRef,path);',
        'const [, ,oid,path]=match;\n        if(retained?.has(path)){files.set(path,retained.get(path));continue;}\n        stateRecordOwner(request.targetRef,path);');
    }
    if(entry.name==='release-adoption.mjs') {
      text="import {allowInitialFixtureState,auditFixtureSnapshot} from '../e08-python/legacy-state-fixture.mjs';\n"+text;
      replace("if(snapshot.head!==JSON.parse(Buffer.from(response.bytes).toString('utf8')).object?.sha||!snapshot.repository)fail('state source unknown');",
        "if(snapshot.head!==JSON.parse(Buffer.from(response.bytes).toString('utf8')).object?.sha)fail('state source unknown');\n      if(!snapshot.repository)await allowInitialFixtureState(request,snapshot);");
      replace('if(snapshot.repository.schemaVersion===3)', 'if(snapshot.repository?.schemaVersion===3)');
      replace('if(!snapshot) {\n      const releases=', 'if(!snapshot?.repository) {\n      const releases=');
      replace("const prior=snapshot?(await promisify(execFile)","const prior=snapshot?.repository?(await promisify(execFile)");
      replace("return {status:written.status,head:written.head,releaseAdoption:repository.releaseAdoption,migrated:!!previous};",
        "await auditFixtureSnapshot({...request,directory},back.head);\n    return {status:written.status,head:written.head,releaseAdoption:repository.releaseAdoption,migrated:!!previous};");
      replace("nativePythonSourceVersion(fileURLToPath(new URL('..',import.meta.url)),",`nativePythonSourceVersion(${JSON.stringify(root)},`);
    }
    if(entry.name==='release-candidate.mjs') {
      text="import {fixedContentSdk} from '../e08-python/fixed-content-sdk.mjs';\n"+text;
      replace("const sdk = language ?? copilotReleaseClient(controllerDirectory, copilotToken ?? '');","const sdk = language ?? fixedContentSdk();");
      replace("resolve(controllerDirectory, 'scripts/release-please-candidate.mjs')",JSON.stringify(join(output,'scripts/release-please-candidate.mjs')));
    }
    await writeFile(join(output,'scripts',entry.name),text,{flag:'wx'});
    records.push({file:'scripts/'+entry.name,sourceSha256:hash(original),runtimeSha256:hash(text),replacements});
  }
  const adapter=await readFile(join(root,'e08-python/legacy-state-fixture.mjs'),'utf8');
  await writeFile(join(output,'e08-python/legacy-state-fixture.mjs'),adapter.replace("'./native/index.js'",JSON.stringify(bundle)),{flag:'wx'});
  const sdk=await readFile(join(root,'e08-python/fixed-content-sdk.mjs'));
  await writeFile(join(output,'e08-python/fixed-content-sdk.mjs'),sdk,{flag:'wx'});
  await writeFile(join(output,'package.json'),' {"type":"module"}\n',{flag:'wx'});
  // Node resolves libraries from the source checkout's ancestor node_modules.
  const manifest={schemaVersion:1,scope:'E08 immutable legacy-file carry and fixed content SDK; canonical writes, RP and GitHub evidence retain native contracts',bundleSha256:hash(await readFile(join(root,'e08-python/native/index.js'))),adapterSha256:hash(adapter),contentSdkSha256:hash(sdk),records};
  await writeFile(join(output,'runtime-binding.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  if(process.argv.length!==2)throw Error('E08_RUNTIME_ARGUMENTS');
  const root=fileURLToPath(new URL('..',import.meta.url));
  const result=await prepareRuntime(root,join(root,'.e08-python-runtime'));
  console.log(JSON.stringify({status:'PREPARED',files:result.records.length,bundleSha256:result.bundleSha256}));
}
