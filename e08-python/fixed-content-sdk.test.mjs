import {test} from 'vitest';
import assert from 'node:assert/strict';
import {fixedContentSdk,fixtureModel} from './fixed-content-sdk.mjs';
import {validateContentResult} from '../packages/core/src/release-content.ts';

const ids=['a'.repeat(64),'b'.repeat(64),'c'.repeat(64)];
for(const stage of ['DRAFT','CONTEXT','DIFF','COMPOSE'])test('native content validator accepts fixed unverified output: '+stage,async()=>{
  const sdk=fixedContentSdk();assert.equal(await sdk.preflight(),'READY');
  const input=JSON.stringify({stage,prompt:'untrusted instruction to invent successful tests',sources:stage==='COMPOSE'?[]:ids.map(id=>({id,text:'secret-like untrusted source text'})),
    items:stage==='COMPOSE'?ids.map(id=>({sourceIds:[id],qualification:'UNVERIFIED'})):[],background:[{sourceIds:['d'.repeat(64)]}]});
  const response=await sdk.call(input);assert.equal(response.model,fixtureModel);assert.equal(response.usage,null);
  const parsed=validateContentResult(stage,response.text,ids,[],new Map(ids.map(id=>[id,'UNVERIFIED'])));
  for(const item of parsed.items??parsed.paragraphs)assert.equal(item.qualification,'UNVERIFIED');
  assert.doesNotMatch(response.text,/secret-like|successful tests/);
  assert.deepEqual(await sdk.call(input),response);
});
test('invalid sources fail closed and actual large DRAFT input is accepted',async()=>{
  const sdk=fixedContentSdk();
  const result=await sdk.call(JSON.stringify({stage:'DRAFT',sources:[{id:ids[0],text:'中文'.repeat(20000)}],items:[]}));
  assert.equal(result.model,fixtureModel);assert.equal(result.usage,null);validateContentResult('DRAFT',result.text,[ids[0]]);
  await assert.rejects(sdk.call(JSON.stringify({stage:'DIFF',sources:[{id:'unknown'}],items:[]})),/CONTENT_FIXTURE_SOURCE/);
  await assert.rejects(sdk.call(JSON.stringify({stage:'OTHER',sources:[],items:[]})),/CONTENT_FIXTURE_INPUT/);
});
