import { Evidence, Family } from '../types';

/** Utilitários compartilhados pelos analisadores. Sem dependência de `vscode`. */

export const MAX_SNIPPET = 120;

/** Converte deslocamentos no texto bruto em linha/coluna (1-based). */
export class TextIndex {
  private readonly lineStarts: number[] = [0];

  constructor(readonly text: string) {
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        this.lineStarts.push(i + 1);
      }
    }
  }

  position(offset: number): { linha: number; coluna: number } {
    const clamped = Math.max(0, Math.min(offset, this.text.length));
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= clamped) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return { linha: lo + 1, coluna: clamped - this.lineStarts[lo] + 1 };
  }

  lineText(linha: number): string {
    const start = this.lineStarts[linha - 1] ?? this.text.length;
    const end = this.lineStarts[linha] ?? this.text.length;
    return this.text.slice(start, end).replace(/\r?\n$/, '');
  }
}

/**
 * Prepara um trecho de código hostil para exibição.
 *
 * Caracteres de controle e de direção bidirecional (U+202A–U+202E,
 * U+2066–U+2069, a técnica "Trojan Source") fariam o trecho aparecer na tela
 * diferente do que realmente está no arquivo. Eles viram marcadores visíveis
 * ANTES do corte em 120 caracteres, para que o corte não esconda o marcador.
 */
export function sanitizeSnippet(raw: string, max: number = MAX_SNIPPET): string {
  const visible = markInvisible(raw.replace(/\t/g, ' ').replace(/\r/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
  return visible.length <= max ? visible : `${visible.slice(0, max - 1)}…`;
}

/** Troca caracteres de controle, invisíveis e bidirecionais por marcadores visíveis. Preserva \n e \t. */
export function markInvisible(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, (ch) =>
    `⟨U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`,
  );
}

/** Versão de várias linhas, para conteúdo decodificado exibido no painel. */
export function sanitizeBlock(raw: string, max = 2000): string {
  const visible = markInvisible(raw.replace(/\r\n?/g, '\n'));
  return visible.length <= max ? visible : `${visible.slice(0, max - 1)}…`;
}

export interface EvidenceInput {
  regra: string;
  familia: Family;
  arquivo: string;
  index: TextIndex;
  offset: number;
  explicacao: string;
  /** Se omitido, usa a linha do código onde o achado está. */
  trecho?: string;
  decodificado?: string;
  foraDaContencao?: boolean;
  /**
   * Posição, no arquivo real, do início do texto indexado. Usado para código
   * embutido em manifestos (`node -e "..."` dentro do package.json).
   */
  base?: { linha: number; coluna: number };
}

export function makeEvidence(input: EvidenceInput): Evidence {
  const local = input.index.position(input.offset);
  const linha = input.base !== undefined ? input.base.linha + local.linha - 1 : local.linha;
  const coluna =
    input.base !== undefined && local.linha === 1 ? input.base.coluna + local.coluna - 1 : local.coluna;
  const evidence: Evidence = {
    // Id determinístico: a mesma análise gera os mesmos ids, o que permite
    // cruzar "evidencia_inspecionada" no registro com o achado exibido.
    id: `${input.regra}@${input.arquivo}:${linha}:${coluna}`,
    familia: input.familia,
    arquivo: input.arquivo,
    linha,
    coluna,
    trecho: sanitizeSnippet(input.trecho ?? input.index.lineText(local.linha)),
    explicacao: input.explicacao,
  };
  if (input.decodificado !== undefined) {
    evidence.decodificado = input.decodificado;
  }
  if (input.foraDaContencao === true) {
    evidence.foraDaContencao = true;
  }
  return evidence;
}

export function dedupeEvidence(list: Evidence[]): Evidence[] {
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

export interface TextMatch {
  offset: number;
  text: string;
}

function allMatches(text: string, patterns: RegExp[]): TextMatch[] {
  const found: TextMatch[] = [];
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    for (const m of text.matchAll(global)) {
      found.push({ offset: m.index ?? 0, text: m[0] });
    }
  }
  return found.sort((a, b) => a.offset - b.offset);
}

/**
 * "Baixar e executar" em um passo: o conteúdo executado não existe no
 * repositório, então nenhuma análise estática consegue vê-lo. Além de sh/bash,
 * cobre interpretadores e a variante do PowerShell, comum em alvos Windows.
 */
const DOWNLOAD_CHAIN_PATTERNS: RegExp[] = [
  /\b(?:curl|wget)\b[^|\n;&]*\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:(?:ba|z|da|k)?sh|python[23]?|node|perl|ruby)\b/i,
  /\b(?:(?:ba|z|da)?sh|python[23]?|node)\b[^\n]*?(?:<\(|\$\(|`)\s*(?:curl|wget)\b/i,
  /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod|\(?new-object\s+net\.webclient\)?\.downloadstring)\b[^\n]*\|\s*(?:iex|invoke-expression)\b/i,
  /\b(?:iex|invoke-expression)\b\s*\(?\s*(?:\(?new-object\s+net\.webclient\)?\.downloadstring|iwr|irm|invoke-webrequest|invoke-restmethod)\b/i,
];

export function findDownloadChains(text: string): TextMatch[] {
  return allMatches(text, DOWNLOAD_CHAIN_PATTERNS);
}

export interface SensitivePattern {
  regex: RegExp;
  rotulo: string;
}

/**
 * Locais onde ficam segredos do desenvolvedor. A lista da especificação
 * (.ssh, .aws, .config/gcloud, .npmrc, id_rsa, .env, wallet, keystore) foi
 * estendida com outros alvos frequentes de ladrões de credenciais.
 */
export const SENSITIVE_PATTERNS: SensitivePattern[] = [
  { regex: /\.ssh\b/, rotulo: 'as chaves SSH' },
  { regex: /\bid_(?:rsa|ed25519|ecdsa|dsa)\b/, rotulo: 'a chave SSH privada' },
  { regex: /\.aws\b/, rotulo: 'as credenciais da AWS' },
  { regex: /\.config[\\/]gcloud\b/, rotulo: 'as credenciais do Google Cloud' },
  { regex: /\.azure\b/, rotulo: 'as credenciais da Azure' },
  { regex: /\.kube[\\/]config\b/, rotulo: 'as credenciais do Kubernetes' },
  { regex: /\.docker[\\/]config\.json\b/, rotulo: 'as credenciais do Docker' },
  { regex: /\.npmrc\b/, rotulo: 'o token de publicação do npm' },
  { regex: /\.git-credentials\b|\.netrc\b/, rotulo: 'senhas salvas do git' },
  // Exige um separador antes de ".env" para não casar com "process.env".
  { regex: /(?:^|[\\/'"`\s])\.env(?:\.[\w-]+)?\b/, rotulo: 'o arquivo .env com segredos' },
  { regex: /wallet/i, rotulo: 'carteiras de criptomoedas' },
  { regex: /keystore|keychain/i, rotulo: 'o cofre de chaves' },
];

export function findSensitivePaths(text: string): Array<TextMatch & { rotulo: string }> {
  const found: Array<TextMatch & { rotulo: string }> = [];
  for (const { regex, rotulo } of SENSITIVE_PATTERNS) {
    const m = regex.exec(text);
    if (m !== null) {
      found.push({ offset: m.index, text: m[0], rotulo });
    }
  }
  return found.sort((a, b) => a.offset - b.offset);
}

const URL_PATTERN = /\bhttps?:\/\/[^\s'"`<>()\\{}]+/gi;

/**
 * Hosts que não contam como saída suspeita. A especificação lista os registros
 * npm, PyPI e GitHub. Note que raw.githubusercontent.com e gist.* NÃO entram:
 * são o lugar mais comum para hospedar a segunda etapa de um ataque.
 */
const KNOWN_REGISTRY_HOSTS = [
  'npmjs.org',
  'npmjs.com',
  'yarnpkg.com',
  'pypi.org',
  'pythonhosted.org',
  'github.com',
];

/**
 * URLs que são identificadores, não destinos de rede (namespaces de SVG/XML,
 * $schema). Sem isto, todo componente React com <svg> geraria SAIDA_REDE.
 */
const IDENTIFIER_HOSTS = ['w3.org', 'json-schema.org', 'purl.org', 'schemas.xmlsoap.org', 'schemastore.org'];

/** Tráfego local não sai da máquina, logo não é exfiltração. */
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '[::1]'];

function hostMatches(host: string, list: string[]): boolean {
  return list.some((known) => host === known || host.endsWith(`.${known}`));
}

export interface UrlMatch extends TextMatch {
  host: string;
  benigno: boolean;
}

export function findUrls(text: string): UrlMatch[] {
  const found: UrlMatch[] = [];
  for (const m of text.matchAll(URL_PATTERN)) {
    let host: string;
    try {
      host = new URL(m[0]).hostname.toLowerCase();
    } catch {
      continue;
    }
    const benigno =
      hostMatches(host, KNOWN_REGISTRY_HOSTS) || hostMatches(host, IDENTIFIER_HOSTS) || LOCAL_HOSTS.includes(host);
    found.push({ offset: m.index ?? 0, text: m[0], host, benigno });
  }
  return found;
}

/**
 * Tenta decodificar Base64 ou hexadecimal. É só transformação de texto:
 * nada do conteúdo decodificado é interpretado ou executado. Só devolve o
 * resultado se ele parecer texto legível; binário não ajuda quem lê o alerta.
 */
export function tryDecode(value: string): string | undefined {
  const s = value.trim();
  let bytes: Buffer | undefined;
  if (s.length >= 8 && /^(?:[0-9a-fA-F]{2})+$/.test(s)) {
    bytes = Buffer.from(s, 'hex');
  } else if (s.length >= 8 && /^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) {
    bytes = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  }
  if (bytes === undefined || bytes.length === 0) {
    return undefined;
  }
  const text = bytes.toString('utf8');
  return isReadable(text) ? text : undefined;
}

export function isReadable(text: string): boolean {
  if (text.length === 0) {
    return false;
  }
  let readable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code !== 0xfffd)) {
      readable++;
    }
  }
  return readable / text.length >= 0.9;
}

/** Encurta um comando para citá-lo dentro de uma explicação. */
export function quoteCommand(command: string, max = 60): string {
  return sanitizeSnippet(command, max);
}
