import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { BuildContractError, decodeBuildJson } from '../../core/src/build-manifest.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isolatedBuildEnvironment } from './build-environment.js';
import { type NativeVersionInspector, type NativeVersionResult } from './build-manifest.js';
import { releaseAssert } from '../../core/src/release-note-receipt.js';
export const nativeInspectionTimeoutMs = 120000;
export function nativeReleaseInspector(script: string, home: string, platform: NodeJS.Platform = process.platform): NativeVersionInspector {
  const inspect: NativeVersionInspector = async () => { throw new Error('RN_NATIVE_PATH_REQUIRED'); };
  inspect.inspectPath = async path => {
    if (/[\\/]package\.json$/.test(path)) {
      const limit = 512 * 1024;
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      let bytes: Buffer;
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > limit) throw new BuildContractError('RN_BUILD_LIMIT');
        const buffer = Buffer.alloc(limit + 1); let size = 0;
        while (size < buffer.length) {
          const read = await handle.read(buffer, size, buffer.length - size, size);
          if (read.bytesRead === 0) break;
          size += read.bytesRead;
        }
        if (size > limit) throw new BuildContractError('RN_BUILD_LIMIT');
        bytes = buffer.subarray(0, size);
      } finally { await handle.close(); }
      const metadata = decodeBuildJson(bytes) as any;
      if (!metadata || typeof metadata.name !== 'string' || typeof metadata.version !== 'string') throw new BuildContractError('RN_BUILD_VERSION');
      return metadata.version;
    }
    releaseAssert(platform === 'win32', 'NATIVE_FORMAT_UNSUPPORTED');
    const result = await promisify(execFile)('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', script, '-LiteralPath', path], {
      env: isolatedBuildEnvironment(process.env, home), timeout: nativeInspectionTimeoutMs, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8',
    }).catch(error => {
      if (error.code === 2 && error.stdout?.trim() === '{"error":"RN_NATIVE_INVALID_ASSET"}') throw new BuildContractError('RN_BUILD_VERSION');
      throw error;
    });
    let value: any;
    try { value = JSON.parse(result.stdout.trim()); } catch { throw new BuildContractError('RN_BUILD_VERSION'); }
    if (!value || Object.keys(value).length !== 1) throw new BuildContractError('RN_BUILD_VERSION');
    if (typeof value.version === 'string') return value.version;
    if (value.resourceOnly !== 'font-archive') throw new BuildContractError('RN_BUILD_VERSION');
    return value as NativeVersionResult;
  };
  return inspect;
}
