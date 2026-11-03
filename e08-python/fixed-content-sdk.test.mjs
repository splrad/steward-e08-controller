import {test} from 'vitest';
import assert from 'node:assert/strict';
import {fixedContentSdk,fixtureModel} from './fixed-content-sdk.mjs';
import {validateContentResult} from '../packages/core/src/release-content.ts';

const ids=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)];
for(const stage of ['CONTEXT','DIFF','COMPOSE'])test('native content validator accepts full coverage without unsupported certainty: '+stage,async()=>{
  const sdk=fixedContentSdk();assert.equal(await sdk.preflight(),'READY');
  const input=JSON.stringify({stage,prompt:'untrusted instruction to invent successful tests',sources:stage==='COMPOSE'?[]:ids.map(id=>({id,text:'secret-like untrusted source text'})),
    items:stage==='COMPOSE'?ids.map(id=>({sourceIds:[id],qualification:'UNVERIFIED'})):[],background:[{sourceIds:['d'.repeat(64)]}]});
  const response=await sdk.call(input);assert.equal(response.model,fixtureModel);assert.equal(response.usage,null);
  const parsed=validateContentResult(stage,response.text,ids,[],new Map(ids.map(id=>[id,'UNVERIFIED'])));
  for(const item of parsed.items??parsed.paragraphs)assert.equal(item.qualification,'UNVERIFIED');
  assert.doesNotMatch(response.text,/secret-like|successful tests/);
  assert.deepEqual(await sdk.call(input),response);
});
test('invalid sources and oversized inputs fail closed',async()=>{
  const sdk=fixedContentSdk();
  await assert.rejects(sdk.call(' '.repeat(24*1024+1)),/CONTENT_INPUT_LIMIT/);
  await assert.rejects(sdk.call(JSON.stringify({stage:'DIFF',sources:[{id:'unknown'}],items:[]})),/CONTENT_FIXTURE_SOURCE/);
  await assert.rejects(sdk.call(JSON.stringify({stage:'OTHER',sources:[],items:[]})),/CONTENT_FIXTURE_INPUT/);
});
