import * as vscode from 'vscode';
import { checkDocker, cliFor, imageExists, pullImage, runtimeName } from './container';
import {
  ACTION_LABELS,
  CheckAction,
  CheckLine,
  LEVEL_SYMBOL,
  actionsFor,
  terminalCheckLine,
  trustCheckLines,
  worstLevel,
} from './environmentRules';
import { checkWritable } from './telemetry';
import { ExtensionSettings } from './types';

/**
 * "RepoGuard: Verificar ambiente": checklist para preparar cada máquina do
 * experimento antes da sessão. Uma extensão não consegue instalar o Docker
 * (exige administrador, WSL 2, licença); o que ela pode é dizer exatamente o
 * que falta, baixar a imagem com antecedência e oferecer os ajustes de
 * configuração, cada um aplicado só com o clique do pesquisador.
 */

let channel: vscode.OutputChannel | undefined;

function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('RepoGuard: ambiente');
  return channel;
}

async function containerLines(settings: ExtensionSettings): Promise<CheckLine[]> {
  const docker = cliFor(settings.comandoContainer);
  const nome = runtimeName(docker);
  const image = settings.imagemContainer;

  const status = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `RepoGuard: verificando o ${nome}…` },
    () => checkDocker(docker),
  );
  if (!status.disponivel) {
    return [{ nivel: 'erro', texto: status.motivo ?? `${nome} indisponível.`, acao: 'guiaInstalacao' }];
  }

  const lines: CheckLine[] = [{ nivel: 'ok', texto: `${nome} ${status.versao ?? ''} em execução.` }];
  let present = await imageExists(docker, image);
  if (!present) {
    const choice = await vscode.window.showWarningMessage(
      `A imagem ${image} ainda não foi baixada. Sem ela, o primeiro uso do sandbox precisa de internet e vai demorar.`,
      'Baixar agora',
    );
    if (choice === 'Baixar agora') {
      const out = output();
      out.show(true);
      out.appendLine(`$ ${docker.command} pull ${image}`);
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `RepoGuard: baixando ${image}`, cancellable: true },
        (_progress, token) => {
          const controller = new AbortController();
          token.onCancellationRequested(() => controller.abort());
          return pullImage(docker, image, { onOutput: (chunk) => out.append(chunk), signal: controller.signal });
        },
      );
      present = result.executado && result.codigoSaida === 0 && !result.cancelado;
    }
  }
  lines.push(
    present
      ? { nivel: 'ok', texto: `Imagem ${image} disponível.` }
      : { nivel: 'erro', texto: `Imagem ${image} não baixada (rode "${docker.command} pull ${image}").` },
  );
  return lines;
}

function trustLines(): CheckLine[] {
  const config = vscode.workspace.getConfiguration('security.workspace.trust');
  // isTrusted vale para a janela inteira: com mais de uma pasta, todas
  // compartilham o mesmo estado de confiança.
  const trusted = vscode.workspace.isTrusted;
  return trustCheckLines({
    enabled: config.get<boolean>('enabled', true),
    startupPrompt: config.get<string>('startupPrompt', 'never'),
    folders: (vscode.workspace.workspaceFolders ?? []).map((f) => ({ nome: f.name, confiavel: trusted })),
  });
}

/** Ajustes de configuração: cada um só roda com o clique explícito do pesquisador. */
async function runAction(action: CheckAction): Promise<void> {
  switch (action) {
    case 'guiaInstalacao':
      await vscode.commands.executeCommand('repoguard.guiaInstalacao');
      return;
    case 'usarPowerShell':
      await vscode.workspace
        .getConfiguration('terminal.integrated')
        .update('defaultProfile.windows', 'PowerShell', vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage('RepoGuard: terminal padrão alterado para PowerShell. Abra um terminal novo para valer.');
      return;
    case 'ligarConfianca':
      await vscode.workspace
        .getConfiguration('security.workspace.trust')
        .update('enabled', true, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage('RepoGuard: confiança de espaço de trabalho ligada. Reinicie o VS Code para valer.');
      return;
    case 'ligarPerguntaConfianca':
      await vscode.workspace
        .getConfiguration('security.workspace.trust')
        .update('startupPrompt', 'once', vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        'RepoGuard: a pergunta "Você confia nos autores?" passa a aparecer na primeira abertura de cada pasta nova.',
      );
      return;
    case 'gerenciarConfianca':
      // Tela nativa do VS Code com a lista de pastas confiáveis; o pesquisador remove a pasta-mãe ali.
      await vscode.commands.executeCommand('workbench.trust.manage');
      return;
  }
}

export async function verifyEnvironment(settings: ExtensionSettings, logFile: string): Promise<void> {
  const lines: CheckLine[] = [...(await containerLines(settings))];

  const writeError = await checkWritable(logFile);
  lines.push(
    writeError === undefined
      ? { nivel: 'ok', texto: `Registro gravável em ${logFile}.` }
      : { nivel: 'erro', texto: `Não foi possível gravar o registro em ${logFile}: ${writeError}` },
  );
  lines.push(
    settings.participanteId !== ''
      ? { nivel: 'ok', texto: `Participante: ${settings.participanteId}.` }
      : { nivel: 'erro', texto: 'repoguard.participanteId não definido (o registro usará "nao-definido").' },
  );
  lines.push(terminalCheckLine(vscode.env.shell, process.platform));
  lines.push(...trustLines());
  lines.push({ nivel: 'ok', texto: `Modo: ${settings.modo} · grupo: ${settings.grupo}.` });

  const detail = lines.map((l) => `${LEVEL_SYMBOL[l.nivel]} ${l.texto}`).join('\n');
  const actions = actionsFor(lines);
  const buttons = actions.map((a) => ACTION_LABELS[a]);
  const level = worstLevel(lines);

  let choice: string | undefined;
  if (level === 'erro') {
    choice = await vscode.window.showWarningMessage('RepoGuard: o ambiente precisa de ajustes.', { modal: true, detail }, ...buttons);
  } else if (level === 'aviso') {
    choice = await vscode.window.showInformationMessage(
      'RepoGuard: ambiente pronto, com avisos para conferir.',
      { modal: true, detail },
      ...buttons,
    );
  } else {
    choice = await vscode.window.showInformationMessage('RepoGuard: ambiente pronto.', { modal: true, detail });
  }
  const action = actions.find((a) => ACTION_LABELS[a] === choice);
  if (action !== undefined) {
    await runAction(action);
  }
}
