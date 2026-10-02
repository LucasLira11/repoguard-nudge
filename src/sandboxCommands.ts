import * as path from 'path';
import * as vscode from 'vscode';
import {
  ContainerGrant,
  RunResult,
  SandboxSession,
  cliFor,
  runOnHost,
  sensitiveHostPathWarning,
  validateGrant,
} from './container';
import { AnalysisResult, ExtensionSettings, ReleaseKind, TelemetryEventName } from './types';

/**
 * Interface da contenção: executar no sandbox e pedir liberações.
 *
 * Cada liberação é um comando e um diálogo próprios. Não existe botão "sair
 * do container": liberar tudo de uma vez é o diálogo binário de confiança
 * que perde eficácia por habituação.
 */

export type RecordEvent = (evento: TelemetryEventName, detalhes: Record<string, unknown>) => void;

const RELEASE_LABELS: Record<ReleaseKind, string> = {
  porta: 'uma porta',
  pasta: 'uma pasta da sua máquina',
  variavel: 'uma variável de ambiente',
  hospedeiro: 'a execução direta na sua máquina',
};

export class SandboxController implements vscode.Disposable {
  private readonly sessions = new Map<string, SandboxSession>();
  private output: vscode.OutputChannel | undefined;

  constructor(
    private readonly getSettings: () => ExtensionSettings,
    private readonly getAnalysis: (folder: vscode.WorkspaceFolder) => AnalysisResult | undefined,
    private readonly record: RecordEvent,
  ) {}

  register(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this,
      vscode.commands.registerCommand('repoguard.executarSandbox', (arg?: unknown) =>
        this.guard(() =>
          this.executeInSandbox(
            typeof arg === 'string' ? arg : undefined,
            isObject(arg) && arg.origem === 'painel' ? 'painel' : 'comando',
          ),
        ),
      ),
      vscode.commands.registerCommand('repoguard.liberarPorta', () => this.guard(() => this.requestPort())),
      vscode.commands.registerCommand('repoguard.liberarPasta', () => this.guard(() => this.requestFolder())),
      vscode.commands.registerCommand('repoguard.liberarVariavel', () => this.guard(() => this.requestVariable())),
      vscode.commands.registerCommand('repoguard.executarNoHospedeiro', () => this.guard(() => this.requestHost())),
    );
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      void session.dispose();
    }
    this.sessions.clear();
    this.output?.dispose();
  }

  /** No modo controle a interface não existe, nem por atalho de teclado. */
  private async guard(action: () => Promise<void>): Promise<void> {
    if (this.getSettings().modo === 'controle') {
      return;
    }
    try {
      await action();
    } catch (error) {
      void vscode.window.showErrorMessage(`RepoGuard: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private channel(): vscode.OutputChannel {
    this.output ??= vscode.window.createOutputChannel('RepoGuard: sandbox');
    return this.output;
  }

  private async pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = folders.length <= 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick();
    if (folder === undefined) {
      void vscode.window.showWarningMessage('RepoGuard: abra uma pasta para usar a contenção.');
      return undefined;
    }
    if (folder.uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('RepoGuard: a contenção só funciona com pastas locais.');
      return undefined;
    }
    return folder;
  }

  private session(folder: vscode.WorkspaceFolder): SandboxSession {
    const key = folder.uri.toString();
    let session = this.sessions.get(key);
    if (session === undefined) {
      session = new SandboxSession(folder.uri.fsPath);
      this.sessions.set(key, session);
    }
    session.image = this.getSettings().imagemContainer;
    session.docker = cliFor(this.getSettings().comandoContainer);
    return session;
  }

  // ------------------------------------------------------------- sandbox

  async executeInSandbox(preset?: string, origem: 'painel' | 'comando' = 'comando'): Promise<void> {
    const folder = await this.pickFolder();
    if (folder === undefined) {
      return;
    }
    const session = this.session(folder);
    const command = await vscode.window.showInputBox({
      title: 'Executar em sandbox',
      prompt: 'O comando roda num container com uma cópia do projeto, sem acesso aos seus arquivos, chaves ou variáveis.',
      value: preset ?? 'npm install',
    });
    if (command === undefined || command.trim() === '') {
      return;
    }

    const out = this.channel();
    out.show(true);
    out.appendLine(`\n$ ${command}   [container ${session.image}${describeGrants(session.concessoes)}]`);

    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'RepoGuard: executando no container', cancellable: true },
      (_progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        return session.run(command, { onOutput: (chunk) => out.append(chunk), signal: controller.signal });
      },
    );

    this.record('sandbox_executado', {
      origem,
      comando: command,
      executado: result.executado,
      codigoSaida: result.codigoSaida,
      cancelado: result.cancelado,
      concessoes: session.concessoes.map((g) => g.tipo),
    });
    this.reportResult(result, 'no container');
  }

  private reportResult(result: RunResult, where: string): void {
    const out = this.channel();
    if (!result.executado) {
      // Degradação clara: dizer que NADA rodou e por quê.
      out.appendLine(`[RepoGuard] Nada foi executado. ${result.motivo ?? ''}`);
      const guia = 'Como habilitar o sandbox';
      void vscode.window
        .showWarningMessage(`RepoGuard: nada foi executado. ${result.motivo ?? ''}`, ...(result.semRuntime === true ? [guia] : []))
        .then((choice) => (choice === guia ? vscode.commands.executeCommand('repoguard.guiaInstalacao') : undefined));
    } else if (result.cancelado) {
      out.appendLine(`[RepoGuard] Execução ${where} cancelada.`);
    } else {
      out.appendLine(`[RepoGuard] Terminou ${where} com código ${result.codigoSaida ?? '?'}.`);
    }
  }

  // ---------------------------------------------------------- liberações

  /**
   * Alerta de liberação: explica o que será aberto e resume as evidências do
   * repositório atual. O texto muda conforme o repositório e o tipo de
   * liberação, de propósito (alertas polimórficos resistem à habituação).
   */
  private async confirmRelease(
    folder: vscode.WorkspaceFolder,
    tipo: ReleaseKind,
    efeito: string,
    alerta: string | undefined,
    botao: string,
  ): Promise<boolean> {
    const analysis = this.getAnalysis(folder);
    const evidence =
      analysis === undefined
        ? 'A análise deste repositório ainda não terminou.'
        : analysis.evidencias.length === 0
          ? 'A análise estática não encontrou sinais de risco neste repositório.'
          : `${analysis.evidencias.length} evidência(s) encontradas em "${folder.name}" (nível ${analysis.nivel}). ${analysis.justificativa}`;
    const detail = [efeito, alerta !== undefined ? `⚠ ${alerta}` : undefined, evidence]
      .filter((s): s is string => s !== undefined)
      .join('\n\n');

    const choice = await vscode.window.showWarningMessage(
      `Liberar ${RELEASE_LABELS[tipo]} para "${folder.name}"?`,
      { modal: true, detail },
      botao,
    );
    return choice === botao;
  }

  private async grant(
    folder: vscode.WorkspaceFolder,
    grant: ContainerGrant,
    efeito: string,
    botao: string,
    detalhes: Record<string, unknown>,
  ): Promise<void> {
    const validation = validateGrant(grant);
    if (validation.erro !== undefined) {
      this.record('liberacao_negada', { tipo: grant.tipo, motivo: 'invalida', ...detalhes });
      void vscode.window.showErrorMessage(`RepoGuard: ${validation.erro}`);
      return;
    }
    const ok = await this.confirmRelease(folder, grant.tipo, efeito, validation.alerta, botao);
    if (!ok) {
      this.record('liberacao_negada', { tipo: grant.tipo, ...detalhes });
      return;
    }
    this.session(folder).addGrant(grant);
    this.record('liberacao_concedida', { tipo: grant.tipo, ...detalhes });
    void vscode.window.showInformationMessage(
      `RepoGuard: liberação concedida. Ela vale para os próximos comandos no sandbox de "${folder.name}".`,
    );
  }

  async requestPort(): Promise<void> {
    const folder = await this.pickFolder();
    if (folder === undefined) {
      return;
    }
    this.record('liberacao_solicitada', { tipo: 'porta' });
    const container = await askNumber('Porta usada pelo programa dentro do container (ex.: 3000)');
    if (container === undefined) {
      return this.record('liberacao_negada', { tipo: 'porta', motivo: 'cancelada' });
    }
    const host = await askNumber('Porta na sua máquina', String(container));
    if (host === undefined) {
      return this.record('liberacao_negada', { tipo: 'porta', motivo: 'cancelada' });
    }
    await this.grant(
      folder,
      { tipo: 'porta', portaHost: host, portaContainer: container },
      `Você poderá abrir http://localhost:${host} no navegador. A porta fica acessível só nesta máquina, não na rede.`,
      `Liberar porta ${host}`,
      { portaHost: host, portaContainer: container },
    );
  }

  async requestFolder(): Promise<void> {
    const folder = await this.pickFolder();
    if (folder === undefined) {
      return;
    }
    this.record('liberacao_solicitada', { tipo: 'pasta' });
    const picked = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: 'Escolher pasta para o container',
    });
    const hostPath = picked?.[0]?.fsPath;
    if (hostPath === undefined) {
      return this.record('liberacao_negada', { tipo: 'pasta', motivo: 'cancelada' });
    }
    const destino = await vscode.window.showInputBox({
      prompt: 'Onde a pasta aparecerá dentro do container',
      value: `/mnt/${path.basename(hostPath).replace(/[^A-Za-z0-9._-]/g, '_') || 'pasta'}`,
    });
    if (destino === undefined) {
      return this.record('liberacao_negada', { tipo: 'pasta', motivo: 'cancelada' });
    }
    const mode = await vscode.window.showQuickPick(
      [
        { label: 'Somente leitura', description: 'recomendado', ro: true },
        { label: 'Leitura e escrita', description: 'o código poderá alterar e apagar arquivos dessa pasta', ro: false },
      ],
      { title: 'Permissão na pasta' },
    );
    if (mode === undefined) {
      return this.record('liberacao_negada', { tipo: 'pasta', motivo: 'cancelada' });
    }
    // O registro guarda só se a pasta era sensível, não o caminho: caminhos
    // locais costumam conter o nome do participante.
    await this.grant(
      folder,
      { tipo: 'pasta', caminhoHost: hostPath, destino, somenteLeitura: mode.ro },
      `O código do repositório poderá ${mode.ro ? 'ler' : 'ler, alterar e apagar'} tudo o que está em ${hostPath}.`,
      'Liberar pasta',
      { somenteLeitura: mode.ro, sensivel: sensitiveHostPathWarning(hostPath) !== undefined },
    );
  }

  async requestVariable(): Promise<void> {
    const folder = await this.pickFolder();
    if (folder === undefined) {
      return;
    }
    this.record('liberacao_solicitada', { tipo: 'variavel' });
    const nome = await vscode.window.showInputBox({ prompt: 'Nome da variável de ambiente (ex.: API_URL)' });
    if (nome === undefined || nome.trim() === '') {
      return this.record('liberacao_negada', { tipo: 'variavel', motivo: 'cancelada' });
    }
    const valor = await vscode.window.showInputBox({ prompt: `Valor de ${nome}`, password: true });
    if (valor === undefined) {
      return this.record('liberacao_negada', { tipo: 'variavel', motivo: 'cancelada' });
    }
    // O valor nunca vai para o registro do experimento.
    await this.grant(
      folder,
      { tipo: 'variavel', nome: nome.trim(), valor },
      `Todo o código do repositório, inclusive scripts de instalação, poderá ler ${nome.trim()} e enviá-la pela internet.`,
      `Liberar ${nome.trim()}`,
      { nome: nome.trim() },
    );
  }

  /**
   * A liberação mais arriscada: sair do container. Exige digitar o nome do
   * repositório. Um botão "Confirmar" vira reflexo; digitar um nome que muda
   * a cada projeto obriga a ler o que se está aprovando.
   */
  async requestHost(): Promise<void> {
    const folder = await this.pickFolder();
    if (folder === undefined) {
      return;
    }
    this.record('liberacao_solicitada', { tipo: 'hospedeiro' });
    const ok = await this.confirmRelease(
      folder,
      'hospedeiro',
      'O comando rodará FORA do container, na sua máquina, com acesso a todos os seus arquivos, chaves SSH, credenciais de nuvem e variáveis de ambiente.',
      undefined,
      'Continuar',
    );
    if (!ok) {
      return this.record('liberacao_negada', { tipo: 'hospedeiro' });
    }
    const typed = await vscode.window.showInputBox({
      title: 'Confirmação de execução fora do container',
      prompt: `Para confirmar, digite o nome do repositório: ${folder.name}`,
      placeHolder: folder.name,
    });
    if (typed !== folder.name) {
      this.record('liberacao_negada', { tipo: 'hospedeiro', motivo: typed === undefined ? 'cancelada' : 'confirmacao-incorreta' });
      if (typed !== undefined) {
        void vscode.window.showWarningMessage('RepoGuard: o nome digitado não confere. Nada foi executado.');
      }
      return;
    }
    const command = await vscode.window.showInputBox({ prompt: 'Comando a executar na sua máquina' });
    if (command === undefined || command.trim() === '') {
      return this.record('liberacao_negada', { tipo: 'hospedeiro', motivo: 'cancelada' });
    }
    this.record('liberacao_concedida', { tipo: 'hospedeiro' });

    const out = this.channel();
    out.show(true);
    out.appendLine(`\n$ ${command}   [HOSPEDEIRO: fora do container]`);
    const result = await runOnHost(command, folder.uri.fsPath, { onOutput: (chunk) => out.append(chunk) });
    this.record('execucao_hospedeiro', { origem: 'liberacao', comando: command, codigoSaida: result.codigoSaida });
    this.reportResult(result, 'na sua máquina');
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function describeGrants(grants: readonly ContainerGrant[]): string {
  if (grants.length === 0) {
    return ', sem liberações';
  }
  return `, liberações: ${grants
    .map((g) =>
      g.tipo === 'porta' ? `porta ${g.portaHost}` : g.tipo === 'pasta' ? `pasta ${g.destino}` : `variável ${g.nome}`,
    )
    .join(', ')}`;
}

async function askNumber(prompt: string, value?: string): Promise<number | undefined> {
  const text = await vscode.window.showInputBox({
    prompt,
    ...(value !== undefined ? { value } : {}),
    validateInput: (v) => (/^\d{1,5}$/.test(v.trim()) ? undefined : 'Digite um número de porta.'),
  });
  return text === undefined ? undefined : Number(text.trim());
}
