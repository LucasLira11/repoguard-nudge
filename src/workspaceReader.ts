import * as vscode from 'vscode';
import { EntryInfo, WorkspaceReader } from './collector';

/**
 * Implementação do WorkspaceReader sobre vscode.workspace.fs.
 *
 * Usamos a API de arquivos do VS Code (e não fs do Node) para funcionar do
 * mesmo jeito em workspaces locais e remotos e para que a leitura aconteça
 * pelo mesmo caminho que o editor usa em modo restrito, sem executar nada.
 */
export function createVscodeReader(root: vscode.Uri): WorkspaceReader {
  const toUri = (relPath: string): vscode.Uri => vscode.Uri.joinPath(root, ...relPath.split('/'));

  return {
    async stat(relPath: string): Promise<EntryInfo | undefined> {
      try {
        const stat = await vscode.workspace.fs.stat(toUri(relPath));
        // FileType é uma máscara de bits: um link para arquivo vem como
        // File | SymbolicLink. O bit de link tem precedência.
        if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
          return { kind: 'symlink', size: stat.size };
        }
        if ((stat.type & vscode.FileType.File) !== 0) {
          return { kind: 'file', size: stat.size };
        }
        if ((stat.type & vscode.FileType.Directory) !== 0) {
          return { kind: 'directory', size: 0 };
        }
        return { kind: 'other', size: stat.size };
      } catch {
        return undefined;
      }
    },
    async read(relPath: string): Promise<Uint8Array> {
      return vscode.workspace.fs.readFile(toUri(relPath));
    },
  };
}
