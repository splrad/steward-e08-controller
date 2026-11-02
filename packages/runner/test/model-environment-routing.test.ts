import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it.each([
  ['release.yml', 'release-coordinator', 'steward-release'],
  ['quality-language-summary.yml', 'quality-summary', 'steward-release-notes'],
])('%s routes the shared model secret only into its consumer step', async (file, key, environment) => {
  const workflow = parse(await readFile(`.github/workflows/${file}`, 'utf8'));
  const job = workflow.jobs[key];
  expect(job.environment).toEqual({ name: environment, deployment: false });
  expect(job.if).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");
  expect(workflow.env).toBeUndefined();
  expect(job.env).toBeUndefined();
  const consumers = job.steps.filter((step: {env?: Record<string, string>}) => step.env?.STEWARD_COPILOT_TOKEN);
  expect(consumers).toHaveLength(1);
  expect(consumers[0].env.STEWARD_COPILOT_TOKEN).toBe('${{ secrets.COPILOT_GITHUB_TOKEN }}');
  for (const step of job.steps.filter((step: unknown) => step !== consumers[0])) {
    expect(JSON.stringify(step)).not.toMatch(/secrets\./);
  }
  if (workflow.jobs['automation-health']) {
    expect(workflow.jobs['automation-health'].environment).toBeUndefined();
    expect(JSON.stringify(workflow.jobs['automation-health'])).not.toMatch(/secrets\./);
  }
});
