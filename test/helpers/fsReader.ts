import * as fs from 'fs';
import * as path from 'path';
import { EntryInfo, WorkspaceReader } from '../../src/collector';

/** WorkspaceReader sobre fs do Node, com a mesma semântica do leitor do VS Code. */
export function createFsReader(root: string): WorkspaceReader {
  const toAbs = (relPath: string): string => path.join(root, ...relPath.split('/'));

  return {
    async stat(relPath: string): Promise<EntryInfo | undefined> {
      try {
        const stat = await fs.promises.lstat(toAbs(relPath));
        if (stat.isSymbolicLink()) {
          return { kind: 'symlink', size: stat.size };
        }
        if (stat.isFile()) {
          return { kind: 'file', size: stat.size };
        }
        if (stat.isDirectory()) {
          return { kind: 'directory', size: 0 };
        }
        return { kind: 'other', size: stat.size };
      } catch {
        return undefined;
      }
    },
    async read(relPath: string): Promise<Uint8Array> {
      return fs.promises.readFile(toAbs(relPath));
    },
  };
}
