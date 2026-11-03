import {readFile} from 'node:fs/promises';
import {verifyToolchain} from './verify-toolchain.mjs';
import {assertRepositoryInstructions} from '../packages/runner/dist/index.js';
import YAML from 'yaml';
await verifyToolchain();
const legacy=JSON.parse(await readFile('config/review/legacy-instructions.json','utf8'));
await assertRepositoryInstructions(process.cwd(),await readFile('templates/repository/AGENTS.md'),{templateSource:true,legacy});
const organizationInstructions=await readFile('config/review/copilot-organization.md','utf8');
const languageBody='LANG-01【输出语言】审查标题、摘要、行内意见和修正建议以简体中文为主，可按表达需要使用其他语言。\n\n'
  +'LANG-02【原文保留】审查输出中的代码标识、文件路径、命令、日志原文、严重级别标签及平台固定字段保留原文。\n';
if(organizationInstructions!==languageBody)throw Error('ORGANIZATION_INSTRUCTIONS_FORMAT');
const copier=YAML.parse(await readFile('copier.yml','utf8'));
if(copier._subdirectory!=='templates/repository')throw Error('TEMPLATE_SOURCE');
const bootstrap=JSON.parse(await readFile('config/governance/bootstrap.json','utf8'));
if(bootstrap.schemaVersion!==1||!Array.isArray(bootstrap.rules))throw Error('BOOTSTRAP_REGISTRATION');
console.log('native configuration verified');
