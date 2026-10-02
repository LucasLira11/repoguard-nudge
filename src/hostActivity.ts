import * as path from 'path';
import * as vscode from 'vscode';
import { HOST_EXECUTION_MARKERS, hostMarkerFor } from './hostMarkers';
import { RecordEvent } from './sandboxCommands';

/**
 * Observa execuções no hospedeiro que NÃO passam pela extensão: comandos
 * digitados no terminal, tarefas (inclusive as automáticas de folderOpen),
 * sessões de depuração e, como rede de segurança, arquivos que só uma
 * instalação na máquina criaria. É a principal variável de resultado do
 * experimento, e vale nos dois grupos: no grupo controle é a única forma de
 * saber se o participante rodou `npm install` direto na própria máquina.
 *
 * Só observa; nunca bloqueia nem executa nada.
 *
 * Limitação: comandos do terminal dependem da integração de shell do VS Code
 * (ativa por padrão em bash, zsh, fish e PowerShell; não funciona no cmd.exe).
 * Os indícios por arquivo cobrem esse caso e terminais fora do VS Code.
 */
export function watchHostExecution(record: RecordEvent): vscode.Disposable[] {
  return [
    vscode.window.onDidStartTerminalShellExecution((event) => {
      record('execucao_hospedeiro', {
        origem: 'terminal',
        comando: event.execution.commandLine.value,
        // Low = a integração de shell não tem certeza de que capturou o comando inteiro.
        confianca: vscode.TerminalShellExecutionCommandLineConfidence[event.execution.commandLine.confidence],
      });
    }),
    vscode.tasks.onDidStartTaskProcess((event) => {
      // A API não expõe runOn; para saber se foi uma tarefa folderOpen,
      // cruze o nome com o .vscode/tasks.json do desafio na análise dos dados.
      const task = event.execution.task;
      record('execucao_hospedeiro', { origem: 'tarefa', tarefa: task.name, fonte: task.source });
    }),
    vscode.debug.onDidStartDebugSession((session) => {
      record('execucao_hospedeiro', { origem: 'depurador', tipo: session.type, nome: session.name });
    }),
  ];
}

/**
 * Registra execucao_hospedeiro (origem "arquivos") quando aparece na raiz da
 * pasta um node_modules ou lockfile que não existia ao abri-la. Cada indício
 * é registrado uma vez; se for apagado e recriado, conta de novo.
 *
 * Limitação: se o repositório já traz o lockfile e a instalação não cria
 * node_modules (projeto sem dependências), não há indício a observar.
 */
export function watchHostArtifacts(folder: vscode.WorkspaceFolder, record: RecordEvent): vscode.Disposable {
  const present = new Set<string>();
  const snapshot = Promise.all(
    HOST_EXECUTION_MARKERS.map(async (marker) => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, marker));
        present.add(marker);
      } catch {
        // Não existe ainda: se aparecer, é indício.
      }
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(folder, `{${HOST_EXECUTION_MARKERS.join(',')}}`),
    false,
    true,
    false,
  );
  const markerOf = (uri: vscode.Uri): string | undefined =>
    hostMarkerFor(path.relative(folder.uri.fsPath, uri.fsPath));

  watcher.onDidCreate(async (uri) => {
    await snapshot;
    const marker = markerOf(uri);
    if (marker === undefined || present.has(marker)) {
      return;
    }
    present.add(marker);
    record('execucao_hospedeiro', { origem: 'arquivos', indicio: marker, pasta: folder.name });
  });
  watcher.onDidDelete(async (uri) => {
    await snapshot;
    const marker = markerOf(uri);
    if (marker !== undefined) {
      present.delete(marker);
    }
  });
  return watcher;
}
