import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { DockerStatus } from './container';
import { PanelModel, parsePanelMessage, renderPanelHtml } from './panelHtml';
import { RecordEvent } from './sandboxCommands';
import { AnalysisResult, Evidence } from './types';

/**
 * Painel de evidências (webview). Um único painel, reaproveitado: abrir a
 * análise de outra pasta substitui o conteúdo.
 */
export class EvidencePanel implements vscode.Disposable {
  private static current: EvidencePanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly decoration: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private folder: vscode.WorkspaceFolder;
  private resultado: AnalysisResult;
  // Para o evento painel_cancelado: quanto tempo o alerta ficou aberto e se
  // o participante olhou o código antes de desistir.
  private openedAt = Date.now();
  private readonly inspected = new Set<string>();
  private usedSandbox = false;
  private sandbox: PanelModel['sandbox'];
  private closeVia: 'botao' | 'aba' = 'aba';

  static show(
    folder: vscode.WorkspaceFolder,
    resultado: AnalysisResult,
    record: RecordEvent,
    sandboxStatus?: Promise<DockerStatus>,
  ): void {
    if (EvidencePanel.current !== undefined) {
      EvidencePanel.current.update(folder, resultado);
      EvidencePanel.current.panel.reveal(vscode.ViewColumn.Beside);
    } else {
      EvidencePanel.current = new EvidencePanel(folder, resultado, record);
    }
    EvidencePanel.current.watchSandbox(sandboxStatus);
    record('painel_exibido', {
      pontuacao: resultado.pontuacao,
      nivel: resultado.nivel,
      evidencias: resultado.evidencias.length,
      familias: resultado.detalhamento.familias,
    });
  }

  private constructor(
    folder: vscode.WorkspaceFolder,
    resultado: AnalysisResult,
    private readonly record: RecordEvent,
  ) {
    this.folder = folder;
    this.resultado = resultado;
    this.panel = vscode.window.createWebviewPanel(
      'repoguard.evidencias',
      'RepoGuard: evidências',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        // Nenhum arquivo local pode ser carregado pelo webview e nenhum link
        // command: funciona: a única saída do webview é postMessage validado.
        localResourceRoots: [],
        enableCommandUris: false,
      },
    );
    this.decoration = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('inputValidation.warningBackground'),
      border: '1px solid',
      borderColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerColor: new vscode.ThemeColor('editorWarning.foreground'),
      overviewRulerLane: vscode.OverviewRulerLane.Full,
    });

    this.panel.webview.onDidReceiveMessage((raw: unknown) => void this.onMessage(raw), undefined, this.disposables);
    this.panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    this.render();
  }

  private disposed = false;

  dispose(): void {
    // Fechar o painel dispara onDidDispose, que chama dispose de novo.
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (!this.usedSandbox) {
      // 'aba' também cobre o fechamento da janela do VS Code com o painel aberto.
      this.record('painel_cancelado', {
        via: this.closeVia,
        tempoAbertoMs: Date.now() - this.openedAt,
        evidenciasInspecionadas: this.inspected.size,
        nivel: this.resultado.nivel,
      });
    }
    if (EvidencePanel.current === this) {
      EvidencePanel.current = undefined;
    }
    this.decoration.dispose();
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    this.panel.dispose();
  }

  private update(folder: vscode.WorkspaceFolder, resultado: AnalysisResult): void {
    this.folder = folder;
    this.resultado = resultado;
    this.openedAt = Date.now();
    this.inspected.clear();
    this.usedSandbox = false;
    this.render();
  }

  /**
   * O painel abre na hora; a verificação do Docker pode levar alguns
   * segundos. Só re-renderiza se o sandbox estiver indisponível, que é
   * quando o aviso muda o que o usuário deve fazer.
   */
  private watchSandbox(status: Promise<DockerStatus> | undefined): void {
    this.sandbox = undefined;
    const shown = this.resultado;
    void status?.then((s) => {
      if (this.disposed || this.resultado !== shown) {
        return;
      }
      this.sandbox = s.motivo !== undefined ? { disponivel: s.disponivel, motivo: s.motivo } : { disponivel: s.disponivel };
      if (!s.disponivel) {
        this.render();
      }
    });
  }

  private render(): void {
    // Nonce novo a cada renderização: só o <script> e o <style> gerados aqui rodam.
    const nonce = crypto.randomBytes(18).toString('base64');
    this.panel.title = `RepoGuard: ${this.folder.name}`;
    this.panel.webview.html = renderPanelHtml(
      {
        pasta: this.folder.name,
        resultado: this.resultado,
        ...(this.sandbox !== undefined ? { sandbox: this.sandbox } : {}),
      },
      { nonce },
    );
  }

  private async onMessage(raw: unknown): Promise<void> {
    const msg = parsePanelMessage(raw);
    if (msg === undefined) {
      return;
    }
    switch (msg.type) {
      case 'inspecionar': {
        const evidence = this.resultado.evidencias.find((e) => e.id === msg.id);
        if (evidence !== undefined) {
          await this.inspect(evidence);
        }
        break;
      }
      case 'sandbox':
        this.usedSandbox = true;
        await vscode.commands.executeCommand('repoguard.executarSandbox', { origem: 'painel' });
        break;
      case 'cancelar':
        this.closeVia = 'botao';
        this.dispose();
        break;
    }
  }

  /**
   * Abre o arquivo na linha exata e destaca a linha. Abrir um arquivo no
   * editor não executa nada; em modo restrito, nem as extensões de linguagem
   * rodam código do projeto.
   */
  private async inspect(evidence: Evidence): Promise<void> {
    const segments = evidence.arquivo.split('/');
    if (segments.some((s) => s === '..' || s === '') || /^[a-zA-Z]:/.test(evidence.arquivo)) {
      return; // Defesa em profundidade: o coletor já só produz caminhos internos.
    }
    const uri = vscode.Uri.joinPath(this.folder.uri, ...segments);
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      void vscode.window.showWarningMessage(`RepoGuard: não foi possível abrir ${evidence.arquivo}.`);
      return;
    }
    const line = Math.min(Math.max(evidence.linha - 1, 0), document.lineCount - 1);
    const column = Math.max(evidence.coluna - 1, 0);
    const position = new vscode.Position(line, column);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preview: true,
      selection: new vscode.Selection(position, position),
    });
    const range = document.lineAt(line).range;
    editor.setDecorations(this.decoration, [
      {
        range,
        // appendText escapa Markdown: a explicação cita comandos do repositório.
        hoverMessage: new vscode.MarkdownString().appendText(`RepoGuard: ${evidence.explicacao}`),
        renderOptions: { after: { contentText: `  ⚠ ${truncate(evidence.explicacao, 90)}`, color: new vscode.ThemeColor('editorWarning.foreground') } },
      },
    ]);
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

    this.inspected.add(evidence.id);
    this.record('evidencia_inspecionada', {
      id: evidence.id,
      familia: evidence.familia,
      arquivo: evidence.arquivo,
      linha: evidence.linha,
    });
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
