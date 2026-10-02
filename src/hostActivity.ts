import * as vscode from 'vscode';
import { RecordEvent } from './sandboxCommands';

/**
 * Observa execuções no hospedeiro que NÃO passam pela extensão: comandos
 * digitados no terminal, tarefas (inclusive as automáticas de folderOpen) e
 * sessões de depuração. É a principal variável de resultado do experimento,
 * e vale nos dois grupos: no grupo controle é a única forma de saber se o
 * participante rodou `npm install` direto na própria máquina.
 *
 * Só observa; nunca bloqueia nem executa nada.
 *
 * Limitação: comandos do terminal dependem da integração de shell do VS Code
 * (ativa por padrão em bash, zsh, fish e PowerShell; não funciona no cmd.exe).
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
