import { mkdtemp, readFile, readdir, lstat, rm, realpath } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, relative, isAbsolute, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const policyRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const toolIds = { jactionlint: 'github:jdx/jactionlint', zizmor: 'aqua:zizmorcore/zizmor',
  shellcheck: 'aqua:koalaman/shellcheck', pyflakes: 'pypi:pyflakes', python: 'python' } as const;

export async function assertPolicyNodeVersion(): Promise<void> {
  const inventory = JSON.parse(run('mise', ['ls', '--json'], policyRoot, toolEnvironment()));
  const node = inventory.node;
  if (!Array.isArray(node) || node.length !== 1 || !node[0].installed || !node[0].active
    || resolve(node[0].source?.path ?? '') !== join(policyRoot, 'mise.toml') || node[0].version !== process.versions.node) {
    throw new Error('Node does not match trusted mise lock');
  }
  const rel = relative(await realpath(node[0].install_path), await realpath(process.execPath));
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Node executable outside trusted installation');
}

function toolEnvironment(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { MISE_SAFE: '1', MISE_LOCKED: '1', MISE_NODE_COMPILE: 'false' };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG',
    'MISE_DATA_DIR', 'MISE_CONFIG_DIR', 'MISE_CACHE_DIR', 'MISE_STATE_DIR', 'MISE_SYSTEM_CONFIG_DIR', 'MISE_GLOBAL_CONFIG_FILE']) {
    if (process.env[key]) clean[key] = process.env[key];
  }
  return clean;
}

export interface WorkflowToolResult { executable: string; args: string[]; status: number | null; stdout: string; stderr: string }
function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, evidence?: WorkflowToolResult[], acceptedStatuses: number[] = [0]): string {
  const result = spawnSync(executable, args, { cwd, env, shell: false, windowsHide: true,
    encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  evidence?.push({ executable, args, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' });
  if (result.error || result.status === null || !acceptedStatuses.includes(result.status)) {
    throw new Error(`${executable} failed (${result.status ?? result.signal}): ${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result.stdout;
}

/** User-approved title-only exception. The trusted template remains the single workflow source. */
async function titleTriggerException(root: string, finding: any, files: readonly string[]): Promise<boolean> {
  if (finding.ident !== 'dangerous-triggers' || finding.ignored !== false) return false;
  const primary = finding.locations?.filter((location: any) => location.symbolic?.kind === 'Primary');
  if (primary?.length !== 1 || JSON.stringify(primary[0].symbolic?.route?.route) !== JSON.stringify([{ Key: 'on' }, { Key: 'pull_request_target' }])) return false;
  const path = primary[0].symbolic?.key?.Local?.verbatim_path;
  if (typeof path !== 'string' || !files.includes(resolve(path))) return false;
  const local = relative(root, path).replaceAll('\\', '/');
  if (!['.github/workflows/pr-title.yml', 'templates/repository/.github/workflows/pr-title.yml'].includes(local)) return false;
  const normalize = (text: string) => {
    const parsed = YAML.parseDocument(text);
    if (parsed.errors.length) return null;
    const doc = parsed.toJS({ maxAliasCount: 100 });
    const jobs: any[] = Object.values(doc?.jobs ?? {}), step = jobs[0]?.steps?.[0];
    if (jobs.length !== 1 || jobs[0].steps?.length !== 1 || step?.run !== undefined
      || !/^amannn\/action-semantic-pull-request@[a-f0-9]{40}$/.test(step?.uses ?? '')
      || JSON.stringify(doc.permissions) !== '{"pull-requests":"read"}' || jobs[0].permissions !== undefined) return null;
    // Dependency updates retain their single native uses SHA; no second SHA table.
    step.uses = step.uses.replace(/@[a-f0-9]{40}$/, '@PINNED');
    const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered)
      : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
    return JSON.stringify(ordered(doc));
  };
  const trusted = normalize(await readFile(join(policyRoot, 'templates/repository/.github/workflows/pr-title.yml'), 'utf8'));
  return trusted !== null && normalize(await readFile(path, 'utf8')) === trusted;
}

/** Approved central promotion entry only. The reviewed P YAML is the authority, not candidate config. */
async function promotionTriggerException(root: string, finding: any, files: readonly string[]): Promise<boolean> {
  if (finding.ident !== 'dangerous-triggers' || finding.ignored !== false) return false;
  const primary = finding.locations?.filter((location: any) => location.symbolic?.kind === 'Primary');
  if (primary?.length !== 1 || JSON.stringify(primary[0].symbolic?.route?.route) !== JSON.stringify([{ Key: 'on' }, { Key: 'workflow_run' }])) return false;
  const path = primary[0].symbolic?.key?.Local?.verbatim_path;
  if (typeof path !== 'string' || !files.includes(resolve(path))
    || relative(root, path).replaceAll('\\', '/') !== '.github/workflows/governance-promotion.yml') return false;
  const normalize = (text: string): string | null => {
    const parsed = YAML.parseDocument(text);
    if (parsed.errors.length) return null;
    const doc = parsed.toJS({ maxAliasCount: 100 });
    if (!doc?.on?.workflow_run || !doc?.jobs) return null;
    for (const job of Object.values(doc.jobs) as any[]) for (const step of job.steps ?? []) {
      if (step.uses !== undefined) {
        if (typeof step.uses !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/.test(step.uses)) return null;
        // Existing projects can receive native dependency SHA updates; their identity and all other fields stay bound to P.
        step.uses = step.uses.replace(/@[a-f0-9]{40}$/, '@PINNED');
        if (step.uses === 'jdx/mise-action@PINNED') {
          if (typeof step.with?.version !== 'string' || !/^\d{4}\.\d+\.\d+$/.test(step.with.version)) return null;
          step.with.version = 'LOCKED-RELEASE';
        }
      }
    }
    const ordered = (value: any): any => Array.isArray(value) ? value.map(ordered)
      : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
    return JSON.stringify(ordered(doc));
  };
  const trusted = normalize(await readFile(join(policyRoot, '.github/workflows/governance-promotion.yml'), 'utf8'));
  return trusted !== null && normalize(await readFile(path, 'utf8')) === trusted;
}
export async function resolvePolicyTool(name: 'syft' | 'gh' | 'lychee' | 'oras' | 'uv'): Promise<string> {
  const ids = { syft: 'aqua:anchore/syft', gh: 'aqua:cli/cli', lychee: 'aqua:lycheeverse/lychee', oras: 'aqua:oras-project/oras', uv: 'aqua:astral-sh/uv' };
  const env = toolEnvironment(), inventory = JSON.parse(run('mise', ['ls', '--json'], policyRoot, env));
  const entries = inventory[ids[name]];
  if (!Array.isArray(entries) || entries.length !== 1 || !entries[0].installed || !entries[0].active
    || resolve(entries[0].source?.path ?? '') !== join(policyRoot, 'mise.toml')) throw new Error(`${name}: missing trusted locked tool`);
  const executable = await realpath(run('mise', ['which', name], policyRoot, env).trim());
  const rel = relative(await realpath(entries[0].install_path), executable);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${name}: outside trusted installation`);
  if (!run(executable, ['--version'], policyRoot, env).split(/\s+/).includes(entries[0].version)) throw new Error(`${name}: locked version mismatch`);
  return executable;
}

/** Resolve only the trusted policy's installed lock; never load the scanned repository's config. */
export async function resolveWorkflowTools() {
  const env = toolEnvironment();
  const inventory = JSON.parse(run('mise', ['ls', '--json'], policyRoot, env));
  const tools = {} as Record<keyof typeof toolIds, string>;
  const versions = {} as Record<keyof typeof toolIds, string>;
  for (const [name, id] of Object.entries(toolIds) as [keyof typeof toolIds, string][]) {
    const entries = inventory[id];
    if (!Array.isArray(entries) || entries.length !== 1 || !entries[0].installed || !entries[0].active
      || resolve(entries[0].source?.path ?? '') !== join(policyRoot, 'mise.toml')) {
      throw new Error(`${name}: provision the trusted mise lock before validation`);
    }
    const executable = await realpath(run('mise', ['which', name], policyRoot, env).trim());
    const installation = await realpath(entries[0].install_path);
    const rel = relative(installation, executable);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${name}: executable outside locked installation`);
    const version = run(executable, ['--version'], policyRoot, env);
    if (!version.split(/\s+/).includes(entries[0].version)) throw new Error(`${name}: installed version differs from mise lock`);
    tools[name] = executable;
    versions[name] = entries[0].version;
  }
  return { tools, versions, env };
}

async function targetFile(root: string, path: string): Promise<string> {
  const rel = relative(root, resolve(root, path));
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !/\.ya?ml$/.test(path)) throw new Error('workflow path outside target');
  let parent = root;
  for (const segment of rel.split(/[\\/]/)) {
    parent = join(parent, segment);
    if ((await lstat(parent)).isSymbolicLink()) throw new Error('workflow path must not traverse symlinks');
  }
  const full = await realpath(parent);
  if (!(await lstat(full)).isFile()) throw new Error('workflow must be a regular file');
  return full;
}

/** Inventory comes from candidate files, never its config or a catalog whitelist. */
export async function discoverWorkflowFiles(workspace: string, includeTemplates = false): Promise<string[]> {
  const root = await realpath(workspace), pending: string[] = [], visited = new Set<string>();
  async function collect(directory: string, recursive: boolean) {
    let entries;
    try {
      let parent = root;
      for (const segment of directory.split('/')) {
        parent = join(parent, segment);
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('workflow directory must be a regular directory');
      }
      entries = await readdir(parent, { withFileTypes: true });
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      const path = `${directory}/${entry.name}`;
      if (/\.ya?ml$/.test(entry.name)) pending.push(path);
      else if (recursive && entry.isDirectory()) await collect(path, true);
    }
  }
  await collect('.github/workflows', false);
  if (includeTemplates) await collect('templates', true);
  while (pending.length) {
    const path = pending.shift()!;
    if (visited.has(path)) continue;
    const full = await targetFile(root, path);
    // Native scanners own YAML and expression diagnostics. Parsing here only finds
    // local dependencies; malformed documents still reach the native scanners.
    const parsed = YAML.parseDocument(await readFile(full, 'utf8'));
    if (parsed.errors.length) { visited.add(path); continue; }
    const document = parsed.toJS({ maxAliasCount: 100 });
    if (path.startsWith('templates/') && !document?.on && !document?.jobs && !document?.runs) continue;
    visited.add(path);
    const uses: string[] = [];
    for (const job of Object.values(document?.jobs ?? {}) as any[]) {
      if (typeof job?.uses === 'string') uses.push(job.uses);
      for (const step of job?.steps ?? []) if (typeof step?.uses === 'string') uses.push(step.uses);
    }
    for (const step of document?.runs?.steps ?? []) if (typeof step?.uses === 'string') uses.push(step.uses);
    for (const use of uses.filter(use => use.startsWith('./') || use.startsWith('$/'))) {
      const local = relative(root, resolve(root, use.slice(2))).replace(/\\/g, '/');
      if (!local || local.startsWith('..') || isAbsolute(local)) throw new Error('workflow dependency outside target');
      if (/\.ya?ml$/.test(local)) pending.push(local);
      else {
        let found = false;
        for (const name of ['action.yml', 'action.yaml']) {
          try { await targetFile(root, `${local}/${name}`); pending.push(`${local}/${name}`); found = true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        }
        if (!found) throw new Error(`missing local action: ${local}`);
      }
    }
  }
  return [...visited].sort();
}

export async function scanWorkflows(workspace: string, paths: readonly string[]) {
  const results: WorkflowToolResult[] = [];
  if (!paths.length) return { files: [], versions: {}, results };
  const root = await realpath(workspace);
  const files = await Promise.all(paths.map(path => targetFile(root, path)));
  const { tools, versions, env } = await resolveWorkflowTools();
  const temporary = await mkdtemp(join(tmpdir(), 'steward-workflow-scan-'));
  try {
    const isolated: NodeJS.ProcessEnv = { ...env, PATH: [...new Set(Object.values(tools).map(tool => dirname(tool)))].join(delimiter),
      HOME: temporary, USERPROFILE: temporary, XDG_CONFIG_HOME: temporary, APPDATA: temporary, LOCALAPPDATA: temporary,
      PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1' };
    delete isolated.Path;
    run(tools.jactionlint, ['--profile', 'correctness', '--strict-exit', '--no-ignores', '--no-online', '--no-color',
      '--config-file', join(policyRoot, '.github/jactionlint.yaml'), '--shellcheck', tools.shellcheck,
      '--pyflakes', tools.pyflakes, '--', ...files], temporary, isolated, results);
    const output = run(tools.zizmor, ['--offline', '--no-config', '--no-ignores', '--strict-collection', '--no-progress', '--color', 'never', '--format=json-v1', ...files], temporary, isolated, results, [0, 14]);
    const findings = JSON.parse(output);
    if (!Array.isArray(findings)) throw new Error('zizmor failed: unknown JSON result');
    const exceptions = [];
    if (results.at(-1)!.status !== 0) {
      for (const finding of findings.filter(f => !f.ignored)) {
        const decision = await titleTriggerException(root, finding, files) ? 'E07-TITLE-METADATA-20261028'
          : await promotionTriggerException(root, finding, files) ? 'E07-PROMOTION-WORKFLOW-RUN-20261031' : null;
        if (!decision) throw new Error(`zizmor failed: ${JSON.stringify(finding)}`);
        exceptions.push({ decision, finding });
      }
      if (!exceptions.length) throw new Error('zizmor failed: nonzero result without an accepted finding');
    }
    return { files: [...paths], versions, results, exceptions };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
