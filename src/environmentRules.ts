import { terminalCanBeCaptured } from './hostMarkers';

/**
 * Regras do "Verificar ambiente" que não dependem do VS Code (testáveis).
 *
 * Níveis:
 * - erro: a máquina não está pronta para a sessão (o dado coletado ficaria errado);
 * - aviso: decisão do desenho do experimento, que o pesquisador deve conferir;
 * - ok: nada a fazer.
 */

export type CheckLevel = 'ok' | 'aviso' | 'erro';

export type CheckAction =
  | 'guiaInstalacao'
  | 'usarPowerShell'
  | 'ligarConfianca'
  | 'ligarPerguntaConfianca'
  | 'gerenciarConfianca';

export interface CheckLine {
  nivel: CheckLevel;
  texto: string;
  acao?: CheckAction;
}

export const ACTION_LABELS: Record<CheckAction, string> = {
  guiaInstalacao: 'Como habilitar o sandbox',
  usarPowerShell: 'Usar PowerShell no terminal',
  ligarConfianca: 'Ligar a confiança de espaço de trabalho',
  ligarPerguntaConfianca: 'Ligar a pergunta de confiança',
  gerenciarConfianca: 'Gerenciar pastas confiáveis',
};

export const LEVEL_SYMBOL: Record<CheckLevel, string> = { ok: '✔', aviso: '⚠', erro: '✖' };

export interface TrustState {
  /** security.workspace.trust.enabled */
  enabled: boolean;
  /** security.workspace.trust.startupPrompt: "always" | "once" | "never" */
  startupPrompt: string;
  /** Pastas abertas na janela e se cada uma já é confiável. */
  folders: Array<{ nome: string; confiavel: boolean }>;
}

/**
 * O experimento depende de o desafio abrir como um repositório desconhecido:
 * em modo restrito, e (se o protocolo quiser o diálogo clássico) com a
 * pergunta "Você confia nos autores?". Uma pasta-mãe na lista de confiança
 * (Documents, Downloads, um disco inteiro) desfaz as duas coisas em silêncio.
 */
export function trustCheckLines(state: TrustState): CheckLine[] {
  if (!state.enabled) {
    return [
      {
        nivel: 'erro',
        texto:
          'A confiança de espaço de trabalho está desligada: todo repositório abre com tarefas e depuração liberadas, e não existe modo restrito.',
        acao: 'ligarConfianca',
      },
    ];
  }

  const lines: CheckLine[] = [];
  if (state.startupPrompt === 'never') {
    lines.push({
      nivel: 'aviso',
      texto:
        'A pergunta "Você confia nos autores?" está desligada (Startup Prompt: never, o padrão do VS Code atual). Se o grupo controle deve ver o diálogo clássico, ligue-a.',
      acao: 'ligarPerguntaConfianca',
    });
  } else {
    lines.push({
      nivel: 'ok',
      texto: `A pergunta de confiança aparece ao abrir uma pasta nova (Startup Prompt: ${state.startupPrompt}).`,
    });
  }

  if (state.folders.length === 0) {
    lines.push({
      nivel: 'aviso',
      texto:
        'Nenhuma pasta aberta. Para conferir a confiança, abra uma pasta vazia no local onde os desafios serão colocados.',
    });
  }
  for (const folder of state.folders) {
    lines.push(
      folder.confiavel
        ? {
            nivel: 'erro',
            texto: `A pasta "${folder.nome}" já é confiável (ela ou uma pasta acima dela está na lista de confiança): um desafio aberto aqui não começaria em modo restrito.`,
            acao: 'gerenciarConfianca',
          }
        : { nivel: 'ok', texto: `A pasta "${folder.nome}" abre em modo restrito, como um repositório desconhecido.` },
    );
  }
  return lines;
}

/** Sem integração de shell (cmd.exe), o registro não vê os comandos digitados. */
export function terminalCheckLine(shellPath: string, platform: string): CheckLine {
  const name = shellPath.split(/[\\/]/).pop() || 'desconhecido';
  if (terminalCanBeCaptured(shellPath)) {
    return { nivel: 'ok', texto: `Terminal padrão: ${name} (comandos digitados são registrados).` };
  }
  return {
    nivel: 'erro',
    texto: `Terminal padrão: ${name}. Comandos digitados nele não podem ser registrados; use o PowerShell.`,
    ...(platform === 'win32' ? { acao: 'usarPowerShell' as const } : {}),
  };
}

export function worstLevel(lines: CheckLine[]): CheckLevel {
  if (lines.some((l) => l.nivel === 'erro')) {
    return 'erro';
  }
  return lines.some((l) => l.nivel === 'aviso') ? 'aviso' : 'ok';
}

/** Ações oferecidas como botões, sem repetição e na ordem em que aparecem. */
export function actionsFor(lines: CheckLine[]): CheckAction[] {
  return [...new Set(lines.flatMap((l) => (l.acao !== undefined ? [l.acao] : [])))];
}
