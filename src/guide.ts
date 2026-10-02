import * as vscode from 'vscode';

/**
 * Abre o passo a passo de instalação do Docker/Podman que vem junto com a
 * extensão (docs/instalar-container.md). Ele fica dentro do pacote para
 * funcionar sem internet e para o texto não depender de um site externo.
 */
export async function openInstallGuide(extensionUri: vscode.Uri): Promise<void> {
  const uri = vscode.Uri.joinPath(extensionUri, 'docs', 'instalar-container.md');
  try {
    await vscode.commands.executeCommand('markdown.showPreview', uri);
  } catch {
    // Sem a extensão de Markdown embutida, mostra o texto puro.
    await vscode.window.showTextDocument(uri, { preview: true });
  }
}
