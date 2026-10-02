import * as vscode from 'vscode';
import { checkDocker, cliFor, imageExists, pullImage, runtimeName } from './container';
import { checkWritable } from './telemetry';
import { ExtensionSettings } from './types';

/**
 * "RepoGuard: Verificar ambiente": checklist para preparar cada máquina do
 * experimento antes da sessão. Uma extensão não consegue instalar o Docker
 * (exige administrador, WSL 2, licença); o que ela pode é dizer exatamente o
 * que falta e baixar a imagem com antecedência.
 */

interface CheckLine {
  ok: boolean;
  texto: string;
}

let channel: vscode.OutputChannel | undefined;

function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('RepoGuard: ambiente');
  return channel;
}

export async function verifyEnvironment(settings: ExtensionSettings, logFile: string): Promise<void> {
  const docker = cliFor(settings.comandoContainer);
  const nome = runtimeName(docker);
  const image = settings.imagemContainer;
  const lines: CheckLine[] = [];

  const status = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `RepoGuard: verificando o ${nome}…` },
    () => checkDocker(docker),
  );

  if (status.disponivel) {
    lines.push({ ok: true, texto: `${nome} ${status.versao ?? ''} em execução.` });
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
        ? { ok: true, texto: `Imagem ${image} disponível.` }
        : { ok: false, texto: `Imagem ${image} não baixada (rode "${docker.command} pull ${image}").` },
    );
  } else {
    lines.push({ ok: false, texto: status.motivo ?? `${nome} indisponível.` });
  }

  const writeError = await checkWritable(logFile);
  lines.push(
    writeError === undefined
      ? { ok: true, texto: `Registro gravável em ${logFile}.` }
      : { ok: false, texto: `Não foi possível gravar o registro em ${logFile}: ${writeError}` },
  );
  lines.push(
    settings.participanteId !== ''
      ? { ok: true, texto: `Participante: ${settings.participanteId}.` }
      : { ok: false, texto: 'repoguard.participanteId não definido (o registro usará "nao-definido").' },
  );
  lines.push({ ok: true, texto: `Modo: ${settings.modo} · grupo: ${settings.grupo}.` });

  const allOk = lines.every((l) => l.ok);
  const detail = lines.map((l) => `${l.ok ? '✔' : '✖'} ${l.texto}`).join('\n');
  if (allOk) {
    await vscode.window.showInformationMessage('RepoGuard: ambiente pronto.', { modal: true, detail });
  } else {
    const guia = 'Como habilitar o sandbox';
    const choice = await vscode.window.showWarningMessage(
      'RepoGuard: o ambiente precisa de ajustes.',
      { modal: true, detail },
      ...(status.disponivel ? [] : [guia]),
    );
    if (choice === guia) {
      await vscode.commands.executeCommand('repoguard.guiaInstalacao');
    }
  }
}
