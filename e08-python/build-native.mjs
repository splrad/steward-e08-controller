// E08 identity bindings only. Product behavior comes from the reviewed source tree.
import {readFile,writeFile,mkdir,rm,readdir} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root=resolve('.'),compiled=join(root,'.e08-python-build');
const verify=process.argv[2]==='--verify';
if(process.argv.length>(verify?3:2))throw Error('ARGUMENTS');
const inside=path=>{const value=relative(root,resolve(path));return value!==''&&!value.startsWith('..')&&!isAbsolute(value);};
if(!inside(compiled))throw Error('COMPILED_TARGET');
await mkdir(compiled);
const hash=value=>createHash('sha256').update(value).digest('hex');
const definitions=[
 ['packages/runner/src/release-pipeline.js',[
  ['splrad-steward','splrad-e08-release'],['splrad/steward','splrad/steward-e08-controller']]],
 ['packages/runner/src/native-release-evidence.js',[
  ['splrad/steward','splrad/steward-e08-controller'],['splrad\\/steward\\/','splrad\\/steward-e08-controller\\/']]],
 ['packages/runner/src/native-release-cli.js',[
  ['splrad-steward','splrad-e08-release']]],
 ['packages/github/src/app-auth.js',[
  ['4243096','5553347'],['301115370','350673636'],['Iv23liuSr0qd4WLJdZhH','Iv23liu2OIRtzR11gmWk'],['splrad-steward-release','splrad-e08-release']]],
];
try {
 await promisify(execFile)(process.execPath,['node_modules/typescript/bin/tsc','--outDir',compiled,'--noEmit','false','--declaration','false','--sourceMap','false'],{cwd:root,windowsHide:true,timeout:120000});
 const bindings=[];
 for(const [file,pairs] of definitions){
  const target=join(compiled,file),original=await readFile(target,'utf8');let text=original;
  const replacements=[];
  for(const [from,to] of pairs){const count=text.split(from).length-1;if(!count)throw Error('BINDING_MISSING '+file+' '+from);text=text.replaceAll(from,to);replacements.push({from,to,count});}
  await writeFile(target,text);bindings.push({file,sourceSha256:hash(await readFile(join(root,file.replace(/\.js$/,'.ts')))),compiledBeforeSha256:hash(original),compiledAfterSha256:hash(text),replacements});
 }
 const require=createRequire(import.meta.url),ncc=require('@vercel/ncc');
 const result=await ncc(join(compiled,'packages/runner/src/index.js'),{minify:true,quiet:true});
 const dest=join(root,'e08-python/native');if(!inside(dest))throw Error('OUTPUT_TARGET');
 await mkdir(dest,{recursive:true});
 if(!verify&&(await readdir(dest)).length)throw Error('OUTPUT_ALREADY_EXISTS');
 const output={ 'index.js':Buffer.from(result.code) };
 for(const [name,asset] of Object.entries(result.assets)){
  const path=join(dest,name);if(!inside(path)||relative(dest,path).startsWith('..'))throw Error('ASSET_TARGET');
  let content=asset.source;if(name.endsWith('.hbs')){const text=String(content).trimEnd();content=text?text+'\n':'';}
  output[name]=Buffer.from(content);
 }
 if(verify&&JSON.stringify((await readdir(dest)).sort())!==JSON.stringify(Object.keys(output).sort()))throw Error('OUTPUT_INVENTORY');
 const files=[];for(const name of Object.keys(output).sort()){
  const bytes=output[name],path=join(dest,name);
  if(verify){if(!(await readFile(path)).equals(bytes))throw Error('OUTPUT_BYTES '+name);}
  else {await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,bytes,{flag:'wx'});}
  files.push({name,bytes:bytes.length,sha256:hash(bytes)});
 }
 const manifest=JSON.stringify({schemaVersion:1,scope:'Only existing E08 controller/product/App identities; no permission or behavior substitution',bindings,files},null,2)+'\n';
 const manifestPath=join(root,'e08-python/native-binding.json');
 if(verify){if(await readFile(manifestPath,'utf8')!==manifest)throw Error('MANIFEST_BYTES');}
 else await writeFile(manifestPath,manifest,{flag:'wx'});
 console.log(JSON.stringify({verify,bindings:bindings.length,files:files.length,bundleSha256:hash(result.code)}));
}finally{if(!inside(compiled))throw Error('CLEANUP_TARGET');await rm(compiled,{recursive:true,force:true});}
