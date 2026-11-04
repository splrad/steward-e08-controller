import {test} from 'node:test';
import {readFile,rm,access,mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join,relative} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import {preparePagesRuntime} from './prepare-runtime.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const pin='0f2b081e50f5b2ddcb78518f213b7a99f8a0f21e';
const hash=v=>createHash('sha256').update(v).digest('hex');

test('identity binding preserves the native Pages guards and records exact source bytes',async()=>{
  const output=join(root,'.e08-pages-check-'+randomUUID());
  try {
    const manifest=await preparePagesRuntime(root,output);assert.equal(manifest.records.length,2);
    for(const record of manifest.records){
      assert.equal(record.sourceSha256,hash(await readFile(join(root,record.path))));
      assert.equal(record.runtimeSha256,hash(await readFile(join(output,record.path))));
      assert.equal(record.replacements.length,record.path.endsWith('/pages-runtime.mjs')?3:2);
    }
    const {pagesDefinition}=await import(pathToFileURL(join(output,'scripts/pages-runtime.mjs')).href);
    const original=await readFile(join(root,'templates/release/pages.yml'),'utf8');
    const text=original.replaceAll('d89aaffa0d0f22e1f8c4d5d160b43da4c7e3262e',pin).replaceAll('repository: splrad/steward\n','repository: splrad/steward-e08-controller\n');
    assert.equal(pagesDefinition(Buffer.from(text)).controllerSha,pin);
    for(const mutate of [
      d=>{d.jobs.deploy.steps[0].with.repository='splrad/steward';},
      d=>{d.jobs.select.steps[0].with.ref='f'.repeat(40);},
      d=>{d.jobs.deploy.steps[0].with['persist-credentials']=true;},
      d=>{d.jobs.deploy.needs=['select'];},
      d=>{d.concurrency['cancel-in-progress']=true;},
      d=>{d.on.pull_request={};},
    ]) {
      const d=YAML.parse(text);mutate(d);assert.throws(()=>pagesDefinition(Buffer.from(YAML.stringify(d))),/^Error: PAGES_/);
    }
    await assert.rejects(preparePagesRuntime(root,output),/EEXIST/);
    for(const record of manifest.records)assert.equal(record.runtimeSha256,hash(await readFile(join(output,record.path))));
  }finally {
    const rel=relative(root,output);assert(rel.startsWith('.e08-pages-check-')&&!rel.includes('..'));
    await rm(output,{recursive:true,force:true});
  }
});

test('rejects root and outside output targets before writes',async()=>{
  await assert.rejects(preparePagesRuntime(root,root),/E08_PAGES_TARGET/);
  await assert.rejects(preparePagesRuntime(root,resolve(root,'..','unexpected-pages-runtime')),/E08_PAGES_TARGET/);
});

test('refuses a changed source anchor before creating an output directory',async()=>{
  const fixture=await mkdtemp(join(tmpdir(),'e08-pages-anchors-'));
  try {
    await mkdir(join(fixture,'scripts'));
    const source=await readFile(join(root,'scripts/select-pages-source.mjs'),'utf8');
    await writeFile(join(fixture,'scripts/select-pages-source.mjs'),source.replace('301115370','123'));
    const output=join(fixture,'runtime');
    await assert.rejects(preparePagesRuntime(fixture,output),/E08_PAGES_ANCHOR/);
    await assert.rejects(access(output));
  }finally {
    assert(fixture.startsWith(join(tmpdir(),'e08-pages-anchors-')));
    await rm(fixture,{recursive:true,force:true});
  }
});
