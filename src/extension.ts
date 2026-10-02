import * as path from 'path';
import * as vscode from 'vscode';
import { runAnalysis } from './analysis';
import { affectsSettings, readSettings } from './config';
import { DockerStatus, checkDocker, cliFor } from './container';
import { LoadedWeights, loadWeights, shouldAlert } from './engine';
import { verifyEnvironment } from './environmentCheck';
import { openInstallGuide } from './guide';
import { watchHostArtifacts, watchHostExecution } from './hostActivity';
import { terminalCanBeCaptured } from './hostMarkers';
import { EvidencePanel } from './panel';
import { RecordEvent, SandboxController } from './sandboxCommands';
import { EventLog, resolveLogPath } from './telemetry';
import { AnalysisResult, ExtensionSettings } from './types';
import { createVscodeReader } from './workspaceReader';

/**
 * Ponto de entrada.
 *
 * A extensão declara suporte a workspaces não confiáveis e ativa em
 * onStartupFinished, portanto roda ANTES de o usuário responder ao diálogo de
 * confiança. Nessa fase ela só lê arquivos (via vscode.workspace.fs). Nenhum
 * módulo de análise importa child_process: a única porta para execução é
 * container.ts, e ela só é aberta por uma ação explícita do usuário.
 *
 * A proteção não depende da confiança do workspace. Conceder confiança libera
 * tarefas e depuradores do próprio VS Code, não o hospedeiro para os comandos
 * da extensão: nossos comandos continuam indo para o container.
 */

let settings: ExtensionSettings;
let log: vscode.LogOutputChannel | undefined;
let weights: Promise<LoadedWeights>;
let eventLog: EventLog | undefined;
/** Registro do experimento. Grava nos dois modos (experimental e controle). */
const record: RecordEvent = (evento, detalhes) => eventLog?.record(evento, detalhes);

let dockerCache: { at: number; status: Promise<DockerStatus> } | undefined;

/**
 * Situação do Docker/Podman para o aviso do painel, guardada por 60 s para
 * não disparar um processo a cada painel aberto.
 */
function sandboxStatus(): Promise<DockerStatus> {
  if (dockerCache === undefined || Date.now() - dockerCache.at > 60_000) {
    dockerCache = { at: Date.now(), status: checkDocker(cliFor(settings.comandoContainer)) };
  }
  return dockerCache.status;
}

/** Folders já processadas nesta sessão, para não repetir a análise automática. */
const handledFolders = new Set<string>();
/** Observadores de indícios de execução no hospedeiro, por pasta. */
const artifactWatchers = new Map<string, vscode.Disposable>();
/** Último resultado por pasta, usado no painel e nos alertas de liberação. */
const analyses = new Map<string, AnalysisResult>();

export function activate(context: vscode.ExtensionContext): void {
  settings = readSettings();
  configureLogging(context);
  // Os pesos vêm do diretório da extensão, nunca do workspace analisado.
  weights = loadWeights(path.join(context.extensionPath, 'config', 'weights.json'));

  let warnedPath = false;
  eventLog = new EventLog(
    () => {
      const resolved = resolveLogPath(settings.caminhoRegistro, context.globalStorageUri.fsPath);
      if (resolved.aviso !== undefined && !warnedPath) {
        warnedPath = true;
        debug(resolved.aviso);
      }
      return resolved.arquivo;
    },
    () => ({
      participanteId: settings.participanteId || 'nao-definido',
      grupo: settings.grupo,
      desafioId: settings.desafioId || (vscode.workspace.workspaceFolders?.[0]?.name ?? 'sem-pasta'),
    }),
    (message) => debug(message),
  );
  debug(`Registro do experimento: ${resolveLogPath(settings.caminhoRegistro, context.globalStorageUri.fsPath).arquivo}`);

  EvidencePanel.configure((force) => {
    if (force) {
      dockerCache = undefined;
    }
    return sandboxStatus();
  });

  new SandboxController(
    () => settings,
    (folder) => analyses.get(folder.uri.toString()),
    record,
  ).register(context);

  context.subscriptions.push(
    ...watchHostExecution(record),
    vscode.commands.registerCommand('repoguard.analisar', () => uiOnly(reanalyze)),
    vscode.commands.registerCommand('repoguard.mostrarPainel', () => uiOnly(showPanelForPickedFolder)),
    vscode.commands.registerCommand('repoguard.guiaInstalacao', () => uiOnly(() => openInstallGuide(context.extensionUri))),
    vscode.commands.registerCommand('repoguard.verificarAmbiente', () =>
      uiOnly(async () => {
        dockerCache = undefined;
        await verifyEnvironment(settings, resolveLogPath(settings.caminhoRegistro, context.globalStorageUri.fsPath).arquivo);
      }),
    ),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const folder of event.added) {
        void handleFolder(folder);
      }
      for (const folder of event.removed) {
        handledFolders.delete(folder.uri.toString());
        analyses.delete(folder.uri.toString());
        artifactWatchers.get(folder.uri.toString())?.dispose();
        artifactWatchers.delete(folder.uri.toString());
      }
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      // Apenas registrado. Confiança concedida não muda o destino de execução.
      debug('Confiança concedida ao workspace; a contenção continua valendo.');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsSettings(event)) {
        settings = readSettings();
        dockerCache = undefined;
        configureLogging(context);
      }
    }),
  );

  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    void handleFolder(folder);
  }
}

export async function deactivate(): Promise<void> {
  // Fechar a janela com o painel aberto também é desistir: registra antes de gravar o que falta.
  EvidencePanel.closeForShutdown();
  for (const watcher of artifactWatchers.values()) {
    watcher.dispose();
  }
  artifactWatchers.clear();
  handledFolders.clear();
  analyses.clear();
  await eventLog?.flush();
}

/** Comandos de interface não fazem nada no modo controle, nem por atalho de teclado. */
async function uiOnly(action: () => Promise<void>): Promise<void> {
  if (settings.modo === 'experimental') {
    await action();
  }
}

async function analyzeFolder(
  folder: vscode.WorkspaceFolder,
  origem: 'abertura' | 'comando',
): Promise<AnalysisResult | undefined> {
  try {
    const loaded = await weights;
    if (loaded.aviso !== undefined) {
      debug(loaded.aviso);
    }
    const run = await runAnalysis(createVscodeReader(folder.uri), loaded.config);
    const { resultado } = run;
    analyses.set(folder.uri.toString(), resultado);
    debug(
      `Análise de ${folder.name}: ${run.artefatos} artefato(s), ${resultado.evidencias.length} evidência(s), ` +
        `pontuação ${resultado.pontuacao}, nível ${resultado.nivel}, ${run.duracaoMs} ms.`,
    );
    for (const skipped of run.descartados) {
      debug(`  descartado (${skipped.reason}): ${skipped.path}`);
    }
    debug(`  ${resultado.justificativa}`);
    record('analise_concluida', {
      origem,
      pontuacao: resultado.pontuacao,
      nivel: resultado.nivel,
      evidencias: resultado.evidencias.length,
      acimaDoLimiar: shouldAlert(resultado),
      ...resultado.detalhamento,
      artefatos: run.artefatos,
      duracaoMs: run.duracaoMs,
    });
    return resultado;
  } catch (error) {
    // Falha na análise não pode derrubar a extensão; a contenção não depende dela.
    debug(`Falha na análise de ${folder.name}: ${String(error)}`);
    record('analise_concluida', { origem, falhou: true, motivo: String(error) });
    return undefined;
  }
}

async function handleFolder(folder: vscode.WorkspaceFolder): Promise<void> {
  const key = folder.uri.toString();
  if (handledFolders.has(key)) {
    return;
  }
  handledFolders.add(key);
  debug(`Workspace aberto: ${folder.name} (confiável: ${vscode.workspace.isTrusted}, modo: ${settings.modo})`);
  artifactWatchers.set(key, watchHostArtifacts(folder, record));
  record('workspace_aberto', {
    pasta: folder.name,
    confiavel: vscode.workspace.isTrusted,
    modo: settings.modo,
    // Sem captura (cmd.exe), comandos digitados não aparecem no registro;
    // só os indícios por arquivo. Fica registrado para a análise dos dados.
    terminalPadrao: path.basename(vscode.env.shell),
    capturaTerminal: terminalCanBeCaptured(vscode.env.shell),
  });

  const resultado = await analyzeFolder(folder, 'abertura');
  if (resultado === undefined || !shouldAlert(resultado)) {
    // Abaixo do limiar: silêncio total. Alertar em todo repositório
    // reintroduziria a habituação que a proposta combate.
    return;
  }
  if (settings.modo === 'experimental') {
    EvidencePanel.show(folder, resultado, record);
  }
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length <= 1 ? folders[0] : vscode.window.showWorkspaceFolderPick();
}

/** Pedido explícito do usuário: aqui faz sentido responder mesmo abaixo do limiar. */
async function reanalyze(): Promise<void> {
  const folder = await pickFolder();
  if (folder === undefined) {
    return;
  }
  const resultado = await analyzeFolder(folder, 'comando');
  if (resultado === undefined) {
    void vscode.window.showWarningMessage('RepoGuard: não foi possível analisar esta pasta.');
  } else {
    showOrSummarize(folder, resultado);
  }
}

async function showPanelForPickedFolder(): Promise<void> {
  const folder = await pickFolder();
  if (folder === undefined) {
    return;
  }
  const resultado = analyses.get(folder.uri.toString()) ?? (await analyzeFolder(folder, 'comando'));
  if (resultado !== undefined) {
    showOrSummarize(folder, resultado);
  }
}

function showOrSummarize(folder: vscode.WorkspaceFolder, resultado: AnalysisResult): void {
  if (resultado.evidencias.length === 0) {
    void vscode.window.showInformationMessage(`RepoGuard: ${resultado.justificativa}`);
  } else {
    EvidencePanel.show(folder, resultado, record);
  }
}

/**
 * No modo "controle" nenhum elemento de interface pode aparecer, nem mesmo
 * um canal de saída na lista do painel Output: o participante do grupo
 * controle não deve perceber que existe uma extensão de segurança.
 */
function configureLogging(context: vscode.ExtensionContext): void {
  if (settings.modo === 'experimental' && log === undefined) {
    log = vscode.window.createOutputChannel('RepoGuard-Nudge', { log: true });
    context.subscriptions.push(log);
  } else if (settings.modo === 'controle' && log !== undefined) {
    log.dispose();
    log = undefined;
  }
}

function debug(message: string): void {
  log?.info(message);
}
