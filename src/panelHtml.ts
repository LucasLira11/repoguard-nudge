import { sanitizeBlock } from './analyzers/common';
import { FAMILY_LABELS } from './engine';
import { AnalysisResult, Evidence, FAMILIES, Family } from './types';

/**
 * HTML do painel de evidências. Módulo puro (sem `vscode`) para ser testado.
 *
 * Regra de segurança: TODO texto vindo do repositório (caminhos, trechos,
 * explicações que citam comandos, conteúdo decodificado, até o nome da pasta)
 * passa por escapeHtml. O conteúdo analisado é hostil por definição; um
 * trecho `<img src=x onerror=...>` tem que aparecer como texto, não virar
 * elemento. A CSP com nonce é a segunda barreira: mesmo que algo escape,
 * nenhum script ou estilo sem o nonce roda, e nenhum recurso externo carrega.
 */

export interface PanelModel {
  pasta: string;
  resultado: AnalysisResult;
  /** Situação do Docker/Podman; ausente enquanto a verificação não terminou. */
  sandbox?: { disponivel: boolean; motivo?: string };
}

export type PanelMessage =
  | { type: 'inspecionar'; id: string }
  | { type: 'sandbox' }
  | { type: 'cancelar' }
  | { type: 'guiaInstalacao' }
  | { type: 'verificarSandbox' };

const SIMPLE_MESSAGES = new Set(['sandbox', 'cancelar', 'guiaInstalacao', 'verificarSandbox']);

/**
 * Mensagens do webview são validadas e o id é só uma chave de busca: o
 * arquivo e a linha a abrir vêm do resultado guardado na extensão, nunca da
 * mensagem. Assim, um webview comprometido não consegue mandar abrir
 * caminhos arbitrários.
 */
export function parsePanelMessage(raw: unknown): PanelMessage | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const msg = raw as Record<string, unknown>;
  if (msg.type === 'inspecionar' && typeof msg.id === 'string' && msg.id.length <= 1000) {
    return { type: 'inspecionar', id: msg.id };
  }
  if (typeof msg.type === 'string' && SIMPLE_MESSAGES.has(msg.type)) {
    return { type: msg.type } as PanelMessage;
  }
  return undefined;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

export function evidenceCountTitle(n: number): string {
  return n === 1 ? '1 evidência encontrada' : `${n} evidências encontradas`;
}

export interface FileGroup {
  arquivo: string;
  evidencias: Evidence[];
  familias: Family[];
  foraDaContencao: boolean;
  correlacao: boolean;
}

/**
 * Agrupa por arquivo e ordena pelo que mais importa para a decisão:
 * primeiro o que escapa do container, depois o arquivo da correlação que
 * definiu a pontuação, depois quem tem mais tipos diferentes de sinal.
 */
export function groupByFile(result: AnalysisResult): FileGroup[] {
  const groups = new Map<string, FileGroup>();
  for (const e of result.evidencias) {
    let g = groups.get(e.arquivo);
    if (g === undefined) {
      g = {
        arquivo: e.arquivo,
        evidencias: [],
        familias: [],
        foraDaContencao: false,
        correlacao: e.arquivo === result.detalhamento.arquivoCorrelacao,
      };
      groups.set(e.arquivo, g);
    }
    g.evidencias.push(e);
    if (!g.familias.includes(e.familia)) {
      g.familias.push(e.familia);
    }
    g.foraDaContencao ||= e.foraDaContencao === true;
  }
  for (const g of groups.values()) {
    g.evidencias.sort((a, b) => a.linha - b.linha || a.coluna - b.coluna);
    g.familias.sort((a, b) => FAMILIES.indexOf(a) - FAMILIES.indexOf(b));
  }
  return [...groups.values()].sort(
    (a, b) =>
      Number(b.foraDaContencao) - Number(a.foraDaContencao) ||
      Number(b.correlacao) - Number(a.correlacao) ||
      b.familias.length - a.familias.length ||
      a.arquivo.localeCompare(b.arquivo),
  );
}

const FAMILY_CLASS: Record<Family, string> = {
  EXEC_AUTOMATICA: 'f-auto',
  EXEC_SISTEMA: 'f-exec',
  ACESSO_SENSIVEL: 'f-acesso',
  OFUSCACAO: 'f-ofusc',
  SAIDA_REDE: 'f-rede',
  DOWNLOAD_ENCADEADO: 'f-download',
};

function chip(f: Family): string {
  return `<span class="chip ${FAMILY_CLASS[f]}">${escapeHtml(FAMILY_LABELS[f])}</span>`;
}

function decodedLabel(e: Evidence): string {
  const rule = e.id.split('@')[0];
  if (rule.includes('fragment') || rule.includes('montad')) {
    return 'Texto remontado';
  }
  if (rule === 'fromcharcode') {
    return 'Texto a partir dos códigos';
  }
  if (rule === 'escapes') {
    return 'Texto sem os escapes';
  }
  return 'Decodificado';
}

function renderEvidence(e: Evidence): string {
  const id = escapeHtml(e.id);
  const original = `<pre class="trecho">${escapeHtml(e.trecho)}</pre>`;
  const code =
    e.decodificado === undefined
      ? original
      : `<div class="lado-a-lado">
          <div><span class="rotulo">Original</span>${original}</div>
          <div><span class="rotulo">${escapeHtml(decodedLabel(e))} <em>(apenas texto, nada foi executado)</em></span>
            <pre class="trecho decodificado">${escapeHtml(sanitizeBlock(e.decodificado))}</pre></div>
        </div>`;
  return `<li class="evidencia${e.foraDaContencao === true ? ' fora' : ''}">
      <div class="codigo">
        <div class="local">
          <button class="link" data-action="inspecionar" data-id="${id}" title="Abrir no editor">linha ${e.linha}</button>
          ${chip(e.familia)}
        </div>
        ${code}
      </div>
      <p class="explicacao">${escapeHtml(e.explicacao)}</p>
    </li>`;
}

function renderGroup(g: FileGroup): string {
  const tags = [
    g.foraDaContencao ? '<span class="tag tag-fora">roda fora do container</span>' : '',
    g.correlacao ? '<span class="tag tag-correlacao">combinação suspeita neste arquivo</span>' : '',
  ].join('');
  return `<section class="arquivo">
      <h2><code>${escapeHtml(g.arquivo)}</code>${tags}</h2>
      <ol>${g.evidencias.map(renderEvidence).join('')}</ol>
    </section>`;
}

const ICON = `<svg class="icone" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8.6 1.5a.7.7 0 0 0-1.2 0L.6 13.7a.7.7 0 0 0 .6 1h13.6a.7.7 0 0 0 .6-1L8.6 1.5zM8 5c.4 0 .7.3.7.7v3.8a.7.7 0 0 1-1.4 0V5.7c0-.4.3-.7.7-.7zm0 8a.9.9 0 1 1 0-1.8.9.9 0 0 1 0 1.8z"/></svg>`;

const CONTAINER_ICON = `<svg class="cartao-icone" viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" d="M8 1.5l6 3.25v6.5L8 14.5l-6-3.25v-6.5zM2 4.75L8 8l6-3.25M8 8v6.5"/></svg>`;

const STYLE = `
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
         background: var(--vscode-editor-background); padding: 0 20px 32px; line-height: 1.5; }
  header { display: flex; gap: 14px; align-items: center; padding: 18px 0 8px; }
  .icone { width: 40px; height: 40px; flex: none; color: var(--vscode-editorWarning-foreground); }
  .nivel-ALTO .icone { color: var(--vscode-errorForeground); }
  h1 { font-size: 1.6em; margin: 0; }
  .sub { margin: 2px 0 0; color: var(--vscode-descriptionForeground); }
  .resumo { font-size: 1.05em; max-width: 72em; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 14px; }
  .chip { font-size: 0.85em; padding: 1px 8px; border-radius: 10px; white-space: nowrap;
          background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .f-acesso, .f-download { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-foreground);
          border: 1px solid var(--vscode-inputValidation-errorBorder); }
  .f-rede, .f-ofusc { background: var(--vscode-inputValidation-warningBackground); color: var(--vscode-foreground);
          border: 1px solid var(--vscode-inputValidation-warningBorder); }
  .aviso-fora { border-left: 4px solid var(--vscode-errorForeground); background: var(--vscode-inputValidation-errorBackground);
          padding: 8px 12px; margin: 12px 0; }
  .cartao-sandbox { display: flex; gap: 12px; align-items: flex-start; margin: 14px 0; padding: 12px 14px;
          background: var(--vscode-editorWidget-background); color: var(--vscode-editorWidget-foreground, var(--vscode-foreground));
          border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
          border-left: 3px solid var(--vscode-editorWarning-foreground); border-radius: 4px; }
  .cartao-icone { width: 22px; height: 22px; flex: none; margin-top: 1px; color: var(--vscode-editorWarning-foreground); }
  .cartao-corpo { min-width: 0; }
  .cartao-sandbox h3 { margin: 0; font-size: 1em; font-weight: 600; }
  .cartao-motivo { margin: 4px 0 0; }
  .cartao-nota { margin: 4px 0 0; color: var(--vscode-descriptionForeground); }
  .cartao-acoes { display: flex; flex-wrap: wrap; align-items: center; gap: 14px; margin-top: 10px; }
  button.compacto { padding: 3px 12px; }
  .protecao { border-left: 4px solid var(--vscode-testing-iconPassed, var(--vscode-focusBorder)); padding: 6px 12px;
          background: var(--vscode-textBlockQuote-background); }
  .acoes { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 24px; position: sticky; top: 0; z-index: 1; padding: 8px 0;
          background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
  button { font-family: inherit; font-size: inherit; padding: 5px 14px; border: 1px solid var(--vscode-button-border, transparent);
          background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; border-radius: 2px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.secundario { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.secundario:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.link { background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); text-decoration: underline; }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .arquivo { margin-bottom: 22px; }
  .arquivo h2 { font-size: 1.05em; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
          border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .tag { font-size: 0.8em; font-weight: normal; padding: 0 6px; border-radius: 3px; }
  .tag-fora { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
  .tag-correlacao { border: 1px solid var(--vscode-editorWarning-foreground); color: var(--vscode-editorWarning-foreground); }
  ol { list-style: none; padding: 0; margin: 0; }
  .evidencia { display: grid; grid-template-columns: minmax(0, 3fr) minmax(14em, 2fr); gap: 16px; padding: 10px 0;
          border-bottom: 1px dashed var(--vscode-panel-border); }
  .evidencia.fora { border-left: 3px solid var(--vscode-errorForeground); padding-left: 10px; }
  @media (max-width: 700px) { .evidencia { grid-template-columns: 1fr; gap: 4px; } .evidencia .explicacao { margin-top: 6px; } }
  .local { display: flex; gap: 8px; align-items: center; margin-bottom: 4px; }
  .trecho { font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); margin: 0;
          padding: 6px 8px; white-space: pre-wrap; word-break: break-all; background: var(--vscode-textCodeBlock-background); }
  .decodificado { max-height: 16em; overflow: auto; }
  .lado-a-lado { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  @media (max-width: 900px) { .lado-a-lado { grid-template-columns: 1fr; } }
  .rotulo { display: block; font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .explicacao { margin: 22px 0 0; }
  code { font-family: var(--vscode-editor-font-family); }
`;

const SCRIPT = `
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest('[data-action]') : null;
    if (!target) { return; }
    vscode.postMessage({ type: target.getAttribute('data-action'), id: target.getAttribute('data-id') || undefined });
  });
`;

export function renderPanelHtml(model: PanelModel, opts: { nonce: string }): string {
  const { resultado } = model;
  const groups = groupByFile(resultado);
  const total = resultado.evidencias.length;
  const fora = groups.filter((g) => g.foraDaContencao);
  const first = groups[0]?.evidencias[0];
  const nonce = escapeHtml(opts.nonce);

  const avisoSandbox =
    model.sandbox === undefined || model.sandbox.disponivel
      ? ''
      : `<section class="cartao-sandbox" role="status" aria-labelledby="sandbox-titulo">
          ${CONTAINER_ICON}
          <div class="cartao-corpo">
            <h3 id="sandbox-titulo">Sandbox indisponível nesta máquina</h3>
            <p class="cartao-motivo">${escapeHtml(model.sandbox.motivo ?? 'O programa de containers não respondeu.')}</p>
            <p class="cartao-nota">Você continua podendo revisar todas as evidências abaixo.</p>
            <div class="cartao-acoes">
              <button class="secundario compacto" data-action="guiaInstalacao">Como habilitar o sandbox</button>
              <button class="link" data-action="verificarSandbox">Verificar novamente</button>
            </div>
          </div>
        </section>`;

  const avisoFora =
    fora.length === 0
      ? ''
      : `<div class="aviso-fora"><strong>Não clique em "Confiar" no aviso do VS Code antes de revisar.</strong>
         ${escapeHtml(fora.map((g) => g.arquivo).join(', '))} pede que o próprio VS Code execute algo na sua máquina,
         por um caminho que o container não cobre.</div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RepoGuard</title>
  <style nonce="${nonce}">${STYLE}</style>
</head>
<body class="nivel-${resultado.nivel}">
  <header>
    ${ICON}
    <div>
      <h1>${escapeHtml(evidenceCountTitle(total))}</h1>
      <p class="sub">em <strong>${escapeHtml(model.pasta)}</strong> · nível ${escapeHtml(resultado.nivel)} · pontuação ${resultado.pontuacao}</p>
    </div>
  </header>
  <p class="resumo">${escapeHtml(resultado.justificativa)}</p>
  <div class="chips">${resultado.detalhamento.familias.map(chip).join('')}</div>
  ${avisoFora}
  <p class="protecao">Nada deste repositório foi executado. Se você rodar o projeto pelo sandbox, ele funciona
    numa cópia isolada, sem acesso às suas chaves, senhas e arquivos pessoais.</p>
  ${avisoSandbox}
  <div class="acoes">
    ${first !== undefined ? `<button data-action="inspecionar" data-id="${escapeHtml(first.id)}">Inspecionar código</button>` : ''}
    <button data-action="sandbox">Executar em sandbox</button>
    <button class="secundario" data-action="cancelar">Cancelar</button>
  </div>
  ${groups.map(renderGroup).join('')}
  <script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
}
