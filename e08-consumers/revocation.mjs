import {setTimeout as delay} from 'node:timers/promises';

// Accept only an authenticated 401 as revocation evidence. A DELETE acknowledgement
// or exhausted retries never substitutes for that readback.
export async function verifyRevocations(tokens, {fetcher=fetch, sleep=delay}={}) {
  const results=[];
  for (const token of tokens) {
    const headers={authorization:'Bearer '+token,'x-github-api-version':'2026-03-10','cache-control':'no-cache'};
    const request=async method=>{
      try {
        const response=await fetcher('https://api.github.com/installation/'+(method==='DELETE'?'token':'repositories'),
          {method,headers,signal:AbortSignal.timeout(10000)});
        const result={status:response.status,requestId:response.headers.get('x-github-request-id'),at:new Date().toISOString()};
        await response.body?.cancel().catch(()=>{});
        return result;
      } catch {
        // Transport errors can contain request credentials; never copy their text.
        return {status:null,error:'TRANSPORT_UNAVAILABLE',at:new Date().toISOString()};
      }
    };
    const result={initial:await request('GET'),reads:[]};
    results.push(result);
    if(result.initial.status!==401) {
      result.revoke=await request('DELETE');
      for(const milliseconds of [0,250,500,1000,2000,4000]) {
        if(milliseconds)await sleep(milliseconds);
        const observed=await request('GET');result.reads.push(observed);
        if(observed.status===401)break;
      }
    }
    result.finalStatus=result.reads.length?result.reads.at(-1).status:result.initial.status;
    result.status=result.finalStatus===401?'PASS':'FAIL';
  }
  return results;
}
