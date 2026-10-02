import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { TelemetryEventName, TelemetryRecord } from './types';

/**
 * Registro do experimento: um arquivo JSONL local, uma linha por evento.
 *
 * - Nada sai da máquina: a extensão não faz chamadas de rede. Os arquivos
 *   são recolhidos pelos pesquisadores ao fim da sessão.
 * - Funciona igual nos dois grupos. No modo "controle" a interface some, mas
 *   o registro continua; é isso que permite comparar os grupos.
 * - O registro nunca derruba a extensão: erro de escrita vira aviso no log.
 * - Privacidade: valores de variáveis liberadas e caminhos locais não são
 *   registrados por quem chama; aqui ainda mascaramos segredos que apareçam
 *   em comandos digitados (`API_KEY=... npm start`, tokens conhecidos).
 */

export const DEFAULT_LOG_FILE = 'repoguard-eventos.jsonl';
const MAX_STRING = 500;
const MAX_DEPTH = 4;

export interface TelemetryContext {
  participanteId: string;
  grupo: string;
  desafioId: string;
}

/**
 * Caminho do arquivo de registro. Só aceita caminho absoluto: um relativo
 * dependeria do diretório corrente do VS Code, que muda de uma máquina para
 * outra, e os dados de um participante sumiriam sem ninguém perceber.
 */
export function resolveLogPath(configured: string, defaultDir: string): { arquivo: string; aviso?: string } {
  const fallback = path.join(defaultDir, DEFAULT_LOG_FILE);
  if (configured === '') {
    return { arquivo: fallback };
  }
  if (!path.isAbsolute(configured)) {
    return {
      arquivo: fallback,
      aviso: `repoguard.caminhoRegistro deve ser um caminho absoluto; usando ${fallback}.`,
    };
  }
  try {
    if (fs.statSync(configured).isDirectory()) {
      return { arquivo: path.join(configured, DEFAULT_LOG_FILE) };
    }
  } catch {
    // Ainda não existe: será criado como arquivo.
  }
  return { arquivo: configured };
}

export interface RecordingScope {
  participanteId: string;
  desafioId: string;
  /** Nomes das pastas abertas na janela. */
  pastasAbertas: string[];
}

/**
 * Decide se um evento entra no registro.
 *
 * Privacidade: a extensão observa terminal, tarefas e arquivos. Instalada
 * fora de uma sessão do experimento (na máquina de um pesquisador, por
 * exemplo), ela gravaria o histórico de comandos de todos os projetos. Por
 * isso:
 * - sem participante definido, nada é gravado (a proteção continua igual);
 * - com desafioId definido, só entra o que acontece na pasta do desafio
 *   (eventos com `pasta`) ou na janela em que ela está aberta (terminal,
 *   tarefas, painel, sandbox). Outros projetos abertos ficam de fora.
 * Nomes de pasta são comparados sem diferenciar maiúsculas (Windows/macOS).
 */
export function shouldRecord(scope: RecordingScope, pasta?: string): boolean {
  if (scope.participanteId.trim() === '') {
    return false;
  }
  const desafio = scope.desafioId.trim().toLowerCase();
  if (desafio === '') {
    return true;
  }
  if (pasta !== undefined) {
    return pasta.toLowerCase() === desafio;
  }
  return scope.pastasAbertas.some((nome) => nome.toLowerCase() === desafio);
}

/** Confere se o arquivo de registro pode ser gravado. Retorna a mensagem de erro, ou undefined. */
export async function checkWritable(file: string): Promise<string | undefined> {
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, '', 'utf8');
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // NOME_COM_CARA_DE_SEGREDO=valor
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSW(?:OR)?D?|API_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=<omitido>'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 <omitido>'],
  [/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1<omitido>@'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '<omitido>'],
  [/\bnpm_[A-Za-z0-9]{20,}\b/g, '<omitido>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<omitido>'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '<omitido>'],
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function sanitizeDetails(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const redacted = redactSecrets(value);
    return redacted.length <= MAX_STRING ? redacted : `${redacted.slice(0, MAX_STRING - 1)}…`;
  }
  if (depth >= MAX_DEPTH) {
    return '[…]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((v) => sanitizeDetails(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = sanitizeDetails(v, depth + 1);
      }
    }
    return out;
  }
  return value === undefined ? null : String(value);
}

export class EventLog {
  /** Identifica a janela do VS Code; separa sessões do mesmo participante. */
  readonly sessaoId = crypto.randomUUID();
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(
    private readonly resolveFile: () => string,
    private readonly context: () => TelemetryContext,
    private readonly onError: (message: string) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(evento: TelemetryEventName, detalhes: Record<string, unknown> = {}): void {
    const ctx = this.context();
    const record: TelemetryRecord = {
      participanteId: ctx.participanteId,
      grupo: ctx.grupo,
      desafioId: ctx.desafioId,
      evento,
      timestamp: this.now().toISOString(),
      detalhes: {
        ...(sanitizeDetails(detalhes) as Record<string, unknown>),
        // seq permite reconstruir a ordem mesmo com timestamps iguais.
        sessaoId: this.sessaoId,
        seq: ++this.seq,
      },
    };
    const line = `${JSON.stringify(record)}\n`;
    const file = this.resolveFile();
    // Fila: as linhas são gravadas na ordem dos eventos, uma de cada vez,
    // sem bloquear quem registrou.
    this.queue = this.queue
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.appendFile(file, line, 'utf8');
        this.failed = false;
      })
      .catch((error: unknown) => {
        if (!this.failed) {
          this.failed = true; // Avisa uma vez por sequência de falhas, não a cada evento.
          this.onError(`Não foi possível gravar o registro em ${file}: ${String(error)}`);
        }
      });
  }

  /** Aguarda as gravações pendentes (usado ao desativar a extensão e nos testes). */
  flush(): Promise<void> {
    return this.queue;
  }
}
