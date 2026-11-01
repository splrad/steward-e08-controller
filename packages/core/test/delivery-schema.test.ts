import { expect, it } from 'vitest';
import { parseDeliveryConfig, deliveryAssetNames } from '../src/delivery-config.js';
const config = { schemaVersion: 1, repositoryAuthors: [{ id: 44151430, evidence: 'Confirmed author axiomoth; native ID verified.' }], units: [
  { id: 'app', path: '.', notesPath: '.release-notes/app.md', assets: [{ id: 'app', name: 'app-${packageVersion}.zip', mediaType: 'application/zip' }], channels: [] },
] };
it('accepts finite version substitution and channels=[] without inventing a channel', () => {
  const parsed = parseDeliveryConfig(config);
  expect(parsed.repositoryAuthors[0]!.id).toBe(44151430);
  expect(deliveryAssetNames(parsed.units[0]!, '1.2.3-rc.1', '1.2.3rc1').get('app')).toBe('app-1.2.3rc1.zip');
  expect(parsed.units[0]!.channels).toEqual([]);
});
it.each(['recipe', 'command', 'author-duplicate', 'unit-duplicate', 'path', 'git-path', 'reserved', 'unsafe-name', 'unknown-placeholder', 'case-collision'])('rejects %s in finite delivery input', kind => {
  const input: any = structuredClone(config), unit = input.units[0];
  if (kind === 'recipe') unit.builds = [{ entrypoint: 'build.ps1' }];
  if (kind === 'command') input.command = 'shell';
  if (kind === 'author-duplicate') input.repositoryAuthors.push(input.repositoryAuthors[0]);
  if (kind === 'unit-duplicate') input.units.push(unit);
  if (kind === 'path') unit.notesPath = '../secret';
  if (kind === 'git-path') unit.notesPath = '.git/config';
  if (kind === 'reserved') unit.assets[0].name = 'SHA256SUMS';
  if (kind === 'unsafe-name') unit.assets[0].name = 'CON.zip';
  if (kind === 'unknown-placeholder') unit.assets[0].name = 'app-${command}.zip';
  if (kind === 'case-collision') unit.assets.push({ ...unit.assets[0], id: 'other', name: 'APP-${packageVersion}.zip' });
  expect(() => parseDeliveryConfig(input)).toThrow();
});
