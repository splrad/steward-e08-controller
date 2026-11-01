// Pure trusted-P policy: complete Git input in, applicability and reasons out.
export function selectValidationScope(input) {
  const fail=()=>{throw Error('VALIDATION_INPUT_INCOMPLETE');};
  if(!input||input.complete!==true||!Number.isSafeInteger(input.repositoryId)||input.repositoryId<=0
    ||![input.base,input.head,input.workflowSha].every(v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v))
    ||!Array.isArray(input.changes))fail();
  const reasons={source:[],dependency:[],docs:[],governance:[]};
  const add=(groups,path)=>{for(const group of groups)if(!reasons[group].includes(path))reasons[group].push(path);};
  for(const change of input.changes) {
    if(!change||!(/^[AMDT]$/.test(change.status)||/^[RC]\d{1,3}$/.test(change.status))
      ||!Array.isArray(change.paths)||change.paths.length!==(/^[RC]/.test(change.status)?2:1))fail();
    for(const path of change.paths) {
      if(typeof path!=='string'||!path||path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..')||/[\0-\x1f\x7f]/.test(path))fail();
      if(/(?:^|\/)(?:AGENTS\.md|CONTRIBUTING\.md|copilot-instructions\.md|.*instructions\.md|VERSION|Version\.props)$/.test(path)
        ||/^(?:templates|schema|config|scripts|tools)\//.test(path)||/^\.github\//.test(path)
        ||/^(?:copier\.yml|\.copier-answers\.yml|tsconfig.*\.json|vitest\.config\..*)$/.test(path)) {
        add(['source','governance'],path);
        if(/\.(?:md|mdx|html?)$/.test(path))add(['docs'],path);
        if(/\.(?:yml|yaml|json|toml|lock)$/.test(path)||/^tools\//.test(path))add(['dependency'],path);
      } else if(/(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|.*\.lock|.*\.lock\.json|global\.json|Directory\.(?:Packages|Build)\.props|.*\.csproj|.*\.slnx?|mise\.(?:toml|lock)|pyproject\.toml)$/.test(path))add(['source','dependency','governance'],path);
      else if(/\.(?:md|mdx|html?|png|jpe?g|gif|svg|webp|ico)$/.test(path))add(['docs'],path);
      else if(/^(?:packages|src|test|tests)\//.test(path))add(['source','governance'],path);
      else add(['source','dependency','docs','governance'],path); // Unknown impact cannot opt out.
    }
  }
  return Object.fromEntries(Object.entries(reasons).map(([name,paths])=>[name,{selected:paths.length>0,
    reasons:paths.length?paths.sort():['complete base/head diff contains no applicable changes']}]));
}
