import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyRevocations} from './revocation.mjs';

function fixture(sequence) {
  const calls=[],waits=[];
  return {calls,waits,options:{sleep:async ms=>{waits.push(ms);},fetcher:async(url,init)=>{
    calls.push({url,method:init.method,signal:init.signal,cache:init.headers['cache-control']});
    assert.ok(sequence.length,'unexpected extra request');const status=sequence.shift();
    if(status===null)throw Error('sensitive transport value');
    return new Response(null,{status,headers:{'x-github-request-id':'fixture-request'}});
  }}};
}
test('already revoked token needs no further write',async()=>{
  const f=fixture([401]);const [r]=await verifyRevocations(['secret'],f.options);
  assert.equal(r.status,'PASS');assert.equal(f.calls.length,1);assert.deepEqual(f.waits,[]);
});
test('acknowledged revoke waits until a 401 is observed',async()=>{
  const f=fixture([200,204,200,200,401]);const [r]=await verifyRevocations(['secret'],f.options);
  assert.equal(r.status,'PASS');assert.deepEqual(r.reads.map(x=>x.status),[200,200,401]);
  assert.deepEqual(f.waits,[250,500]);assert.equal(f.calls.filter(x=>x.method==='DELETE').length,1);
  assert.ok(f.calls.every(x=>x.signal instanceof AbortSignal&&x.cache==='no-cache'));
});
test('accepted DELETE with persistent 200 fails at the bounded limit',async()=>{
  const f=fixture([200,204,...Array(6).fill(200)]);const [r]=await verifyRevocations(['secret'],f.options);
  assert.equal(r.status,'FAIL');assert.equal(r.reads.length,6);assert.equal(f.calls.length,8);
  assert.deepEqual(f.waits,[250,500,1000,2000,4000]);
});
test('lost DELETE response is reconciled by native readback',async()=>{
  const f=fixture([200,null,401]);const [r]=await verifyRevocations(['secret'],f.options);
  assert.equal(r.status,'PASS');assert.equal(r.revoke.error,'TRANSPORT_UNAVAILABLE');
});
test('403 and 404 never prove a token was revoked',async()=>{
  const f=fixture([403,403,403,404,403,404,403,404]);const [r]=await verifyRevocations(['secret'],f.options);
  assert.equal(r.status,'FAIL');assert.equal(r.finalStatus,404);
});
test('failed initial read still attempts cleanup, transient reads can recover',async()=>{
  const f=fixture([null,204,null,429,503,401]);const [r]=await verifyRevocations(['secret'],f.options);
  assert.equal(r.status,'PASS');assert.equal(r.initial.error,'TRANSPORT_UNAVAILABLE');
  assert.equal(f.calls[1].method,'DELETE');
});
test('cleanup continues with every remaining token after a permanent failure',async()=>{
  const f=fixture([200,204,...Array(6).fill(null),401,200,204,401]);
  const r=await verifyRevocations(['first-secret','second-secret','third-secret'],f.options);
  assert.deepEqual(r.map(x=>x.status),['FAIL','PASS','PASS']);
  assert.equal(r[0].finalStatus,null);
  assert.equal(f.calls.filter(x=>x.method==='DELETE').length,2);
  assert.doesNotMatch(JSON.stringify(r),/secret|sensitive transport/);
});
test('no minted tokens produces no requests',async()=>{
  const f=fixture([]);assert.deepEqual(await verifyRevocations([],f.options),[]);assert.equal(f.calls.length,0);
});
