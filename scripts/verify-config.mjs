import {readFile} from 'node:fs/promises';
import {verifyToolchain} from './verify-toolchain.mjs';
import {assertRepositoryInstructions} from '../packages/runner/dist/index.js';
import YAML from 'yaml';
const args=process.argv.slice(2);
if(args.length && (args.length!==2||args[0]!=='--toolchain-root'||!args[1]))throw Error('CONFIG_ARGUMENTS');
await verifyToolchain(process.cwd(),args[1]);
await assertRepositoryInstructions(process.cwd(),await readFile('templates/repository/AGENTS.md'));
const organizationInstructions=await readFile('config/review/copilot-organization.md','utf8');
if(organizationInstructions.includes('\r')||organizationInstructions.startsWith('\uFEFF')||!organizationInstructions.endsWith('\n')
  ||organizationInstructions.endsWith('\n\n')||!['## 评论','## 发现依据','## 审查重点','## 结论'].every(h=>organizationInstructions.includes(h)))throw Error('ORGANIZATION_INSTRUCTIONS_FORMAT');
const copier=YAML.parse(await readFile('copier.yml','utf8'));
if(copier._subdirectory!=='templates/repository')throw Error('TEMPLATE_SOURCE');
const bootstrap=JSON.parse(await readFile('config/governance/bootstrap.json','utf8'));
if(bootstrap.schemaVersion!==1||!Array.isArray(bootstrap.rules))throw Error('BOOTSTRAP_REGISTRATION');
console.log('native configuration verified');
