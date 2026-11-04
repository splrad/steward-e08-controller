// E08 content protocol fixture only. No model, subprocess, network or credential access.
export const fixtureModel='E08_FIXED_NO_MODEL';
const statement='E08 固定 SDK 验收资料；未执行真实模型分析，产品变化及验证结论仍待核实。';
export function fixedContentSdk() {
  return {
    async preflight(){return 'READY';},
    async call(input) {
      if(typeof input!=='string')throw Error('CONTENT_FIXTURE_INPUT');
      const payload=JSON.parse(input);
      if(!['DRAFT','CONTEXT','DIFF','COMPOSE'].includes(payload.stage)||!Array.isArray(payload.sources)||!Array.isArray(payload.items))throw Error('CONTENT_FIXTURE_INPUT');
      const sourceIds=[...new Set([...payload.sources.map(value=>value.id),...payload.items.flatMap(value=>value.sourceIds)])].sort();
      if(!sourceIds.length||sourceIds.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))throw Error('CONTENT_FIXTURE_SOURCE');
      const base={sourceIds,section:'summary',qualification:'UNVERIFIED'};
      const result=['DRAFT','COMPOSE'].includes(payload.stage)?{paragraphs:[{...base,textZh:statement}]}:{items:[{...base,visibility:'UNRESOLVED',statementZh:statement}]};
      const text=JSON.stringify(result);
      if(Buffer.byteLength(text)>12*1024)throw Error('CONTENT_OUTPUT_LIMIT');
      return {text,model:fixtureModel,usage:null};
    },
  };
}
