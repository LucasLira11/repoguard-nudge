import * as path from 'path';
import { parse as parseJsonc } from 'jsonc-parser';
import {
  ArtifactKind,
  CollectedArtifact,
  CollectionResult,
  SkipReason,
  SkippedArtifact,
} from './types';

/**
 * Coletor: lê, sem executar nada, os artefatos que podem disparar execução
 * automática e os scripts que eles referenciam.
 *
 * O acesso a disco passa por WorkspaceReader. Na extensão ele é implementado
 * sobre vscode.workspace.fs (workspaceReader.ts); nos testes, sobre fs do Node.
 * Assim este módulo não importa `vscode` e roda no Jest.
 */

export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILES = 200;
/** Profundidade máxima ao seguir require/import relativos a partir de um script. */
export const MAX_IMPORT_DEPTH = 5;

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface EntryInfo {
  kind: EntryKind;
  size: number;
}

export interface WorkspaceReader {
  /** Caminho relativo com barras normais. Retorna undefined se não existir. */
  stat(relPath: string): Promise<EntryInfo | undefined>;
  read(relPath: string): Promise<Uint8Array>;
}

const MANIFESTS: ReadonlyArray<{ path: string; kind: ArtifactKind }> = [
  { path: 'package.json', kind: 'package-json' },
  { path: 'package-lock.json', kind: 'package-lock' },
  { path: '.vscode/tasks.json', kind: 'vscode-tasks' },
  { path: '.vscode/launch.json', kind: 'vscode-launch' },
  { path: '.devcontainer/devcontainer.json', kind: 'devcontainer' },
  // Local alternativo aceito pelo Dev Containers; ignorá-lo seria um ponto cego trivial.
  { path: '.devcontainer.json', kind: 'devcontainer' },
  { path: 'setup.py', kind: 'setup-py' },
  { path: 'pyproject.toml', kind: 'pyproject' },
  { path: 'Makefile', kind: 'makefile' },
];

const SCRIPT_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const SHELL_EXT = /\.(?:sh|bash)$/i;
const JS_INTERPRETERS = new Set(['node', 'nodejs', 'ts-node', 'tsx', 'babel-node', 'bun']);
const SHELL_INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash']);
const RESOLVE_SUFFIXES = [
  '',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.cts',
  '.mts',
  '.jsx',
  '.tsx',
  '/index.js',
  '/index.ts',
];
const IGNORED_SEGMENTS = new Set(['node_modules', '.git']);

const DEVCONTAINER_COMMAND_KEYS = [
  'initializeCommand',
  'onCreateCommand',
  'updateContentCommand',
  'postCreateCommand',
  'postStartCommand',
  'postAttachCommand',
];

/** Uma referência a arquivo encontrada num comando ou num import. */
export interface FileReference {
  raw: string;
  baseDir: string;
  kind: 'script' | 'shell-script';
  depth: number;
}

export async function collectArtifacts(
  reader: WorkspaceReader,
  signal?: AbortSignal,
): Promise<CollectionResult> {
  const collector = new Collector(reader, signal);
  return collector.run();
}

class Collector {
  private readonly artifacts: CollectedArtifact[] = [];
  private readonly skipped: SkippedArtifact[] = [];
  private readonly seen = new Set<string>();
  private readonly symlinkAncestorCache = new Map<string, boolean>();
  private truncated = false;
  private aborted = false;

  constructor(
    private readonly reader: WorkspaceReader,
    private readonly signal: AbortSignal | undefined,
  ) {}

  async run(): Promise<CollectionResult> {
    for (const manifest of MANIFESTS) {
      await this.addFile(manifest.path, manifest.kind);
    }

    const queue: FileReference[] = [];
    for (const artifact of [...this.artifacts]) {
      queue.push(...referencesFromManifest(artifact));
    }

    // Busca em largura: primeiro o que os comandos chamam diretamente,
    // depois o que esses scripts importam. A carga útil costuma estar a um
    // ou dois require() de distância do script declarado.
    while (queue.length > 0 && !this.stopped()) {
      const ref = queue.shift() as FileReference;
      const artifact = await this.addReference(ref);
      if (artifact !== undefined && artifact.kind === 'script' && ref.depth < MAX_IMPORT_DEPTH) {
        const dir = path.posix.dirname(artifact.path);
        for (const specifier of relativeImports(artifact.content)) {
          queue.push({ raw: specifier, baseDir: dir, kind: 'script', depth: ref.depth + 1 });
        }
      }
    }

    return {
      artifacts: this.artifacts,
      skipped: this.skipped,
      truncated: this.truncated,
      aborted: this.aborted,
    };
  }

  private stopped(): boolean {
    if (this.signal?.aborted === true) {
      this.aborted = true;
    }
    return this.aborted;
  }

  private skip(relPath: string, reason: SkipReason): void {
    if (!this.skipped.some((s) => s.path === relPath && s.reason === reason)) {
      this.skipped.push({ path: relPath, reason });
    }
  }

  private async addReference(ref: FileReference): Promise<CollectedArtifact | undefined> {
    const resolved = resolveWorkspacePath(ref.raw, ref.baseDir);
    if (resolved === null) {
      // Referências a caminhos absolutos ou acima da raiz nunca são lidas:
      // o coletor não sai do workspace, mesmo que o repositório peça.
      this.skip(ref.raw, 'fora-do-workspace');
      return undefined;
    }
    if (isIgnoredPath(resolved)) {
      this.skip(resolved, 'ignorado');
      return undefined;
    }
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = resolved + suffix;
      const info = await this.reader.stat(candidate);
      if (info !== undefined && (info.kind === 'file' || info.kind === 'symlink')) {
        return this.addFile(candidate, ref.kind);
      }
      if (this.stopped()) {
        return undefined;
      }
    }
    return undefined;
  }

  private async addFile(relPath: string, kind: ArtifactKind): Promise<CollectedArtifact | undefined> {
    if (this.seen.has(relPath) || this.stopped()) {
      return undefined;
    }
    this.seen.add(relPath);

    const info = await this.reader.stat(relPath);
    if (info === undefined) {
      return undefined;
    }
    if (this.artifacts.length >= MAX_FILES) {
      this.truncated = true;
      this.skip(relPath, 'limite-total');
      return undefined;
    }
    // Links simbólicos (no arquivo ou em qualquer pasta acima dele) não são
    // seguidos. Um repositório pode trazer scripts/setup.js -> ~/.ssh/id_rsa;
    // lê-lo não executaria nada, mas traria o segredo do usuário para dentro
    // do painel e do registro do experimento.
    if (info.kind === 'symlink' || (await this.hasSymlinkAncestor(relPath))) {
      this.skip(relPath, 'link-simbolico');
      return undefined;
    }
    if (info.kind !== 'file') {
      return undefined;
    }
    if (info.size > MAX_FILE_BYTES) {
      this.skip(relPath, 'tamanho');
      return undefined;
    }

    let bytes: Uint8Array;
    try {
      bytes = await this.reader.read(relPath);
    } catch {
      this.skip(relPath, 'erro-leitura');
      return undefined;
    }
    // Revalida após a leitura: o arquivo pode ter mudado entre stat e read.
    if (bytes.byteLength > MAX_FILE_BYTES) {
      this.skip(relPath, 'tamanho');
      return undefined;
    }

    const artifact: CollectedArtifact = { path: relPath, content: decodeText(bytes), kind };
    this.artifacts.push(artifact);
    return artifact;
  }

  private async hasSymlinkAncestor(relPath: string): Promise<boolean> {
    const segments = relPath.split('/');
    let prefix = '';
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = prefix === '' ? segments[i] : `${prefix}/${segments[i]}`;
      let isLink = this.symlinkAncestorCache.get(prefix);
      if (isLink === undefined) {
        const info = await this.reader.stat(prefix);
        isLink = info?.kind === 'symlink';
        this.symlinkAncestorCache.set(prefix, isLink);
      }
      if (isLink) {
        return true;
      }
    }
    return false;
  }
}

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Normaliza um caminho citado pelo repositório para um caminho relativo à raiz.
 * Retorna null se ele apontar para fora do workspace.
 */
export function resolveWorkspacePath(raw: string, baseDir: string): string | null {
  let p = raw.trim().replace(/\\/g, '/');
  let base = baseDir;
  const workspaceVar = /^\$\{workspace(?:Folder|Root)\}\/?/;
  if (workspaceVar.test(p)) {
    p = p.replace(workspaceVar, '');
    base = '';
  }
  if (
    p === '' ||
    p.startsWith('~') ||
    p.startsWith('/') ||
    /^[a-zA-Z]:/.test(p) ||
    // Qualquer expansão ($HOME, ${VAR}, $(cmd), %USERPROFILE%) é resolvida
    // pelo shell para um local que não controlamos: tratamos como externo.
    p.includes('$') ||
    p.includes('%')
  ) {
    return null;
  }
  const joined = path.posix.normalize(path.posix.join(base === '' ? '.' : base, p));
  if (joined === '..' || joined.startsWith('../') || joined === '.') {
    return null;
  }
  return joined.replace(/^\.\//, '');
}

export function isIgnoredPath(relPath: string): boolean {
  return relPath.split('/').some((segment) => IGNORED_SEGMENTS.has(segment));
}

/** Divide um comando de shell em palavras, respeitando aspas e operadores. */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch) || '&|;<>()'.includes(ch)) {
      if (current !== '') {
        tokens.push(current);
      }
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Extrai de um comando os arquivos que ele manda executar. Além de extensões
 * conhecidas, aceita qualquer palavra logo após um interpretador:
 * `node payload.dat` executa payload.dat como JavaScript, e a extensão
 * enganosa não deve esconder o arquivo da análise.
 */
export function scriptReferencesInCommand(
  command: string,
): Array<{ raw: string; kind: 'script' | 'shell-script' }> {
  const refs: Array<{ raw: string; kind: 'script' | 'shell-script' }> = [];
  const tokens = tokenizeCommand(command);
  for (let i = 0; i < tokens.length; i++) {
    let token = tokens[i];
    const eq = token.indexOf('=');
    if (token.startsWith('-') && eq > 0) {
      token = token.slice(eq + 1); // --require=./hook.js
    }
    if (token.startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(token)) {
      continue;
    }
    const previous = i > 0 ? path.posix.basename(tokens[i - 1]) : '';
    if (SHELL_EXT.test(token) || SHELL_INTERPRETERS.has(previous)) {
      refs.push({ raw: token, kind: 'shell-script' });
    } else if (SCRIPT_EXT.test(token) || JS_INTERPRETERS.has(previous)) {
      refs.push({ raw: token, kind: 'script' });
    }
  }
  return refs;
}

/** Especificadores relativos em require(), import() e import/export estáticos. */
export function relativeImports(source: string): string[] {
  const pattern =
    /(?:require|import)\s*\(\s*(['"`])(\.{1,2}\/[^'"`]+)\1\s*\)|(?:import|export)\s[^'";]*?from\s*(['"])(\.{1,2}\/[^'"]+)\3|import\s*(['"])(\.{1,2}\/[^'"]+)\5/g;
  const found = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const specifier = match[2] ?? match[4] ?? match[6];
    if (specifier !== undefined) {
      found.add(specifier);
    }
  }
  return [...found];
}

/** Coleta strings de comando em formatos do devcontainer: string, array ou objeto. */
function commandStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.every((v) => typeof v === 'string') ? [value.join(' ')] : [];
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(commandStrings);
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function taskCommands(task: Record<string, unknown>): string[] {
  const commands: string[] = [];
  const args = asArray(task.args).filter((a): a is string => typeof a === 'string');
  if (typeof task.command === 'string') {
    commands.push([task.command, ...args].join(' '));
  }
  for (const platform of ['windows', 'linux', 'osx']) {
    const override = asRecord(task[platform]);
    if (override !== undefined && typeof override.command === 'string') {
      commands.push(override.command);
    }
  }
  return commands;
}

export function referencesFromManifest(artifact: CollectedArtifact): FileReference[] {
  const commands: string[] = [];
  const directPaths: string[] = [];

  switch (artifact.kind) {
    case 'package-json': {
      const scripts = asRecord(asRecord(safeParseJsonc(artifact.content))?.scripts);
      for (const value of Object.values(scripts ?? {})) {
        if (typeof value === 'string') {
          commands.push(value);
        }
      }
      break;
    }
    case 'vscode-tasks': {
      const root = asRecord(safeParseJsonc(artifact.content));
      if (root !== undefined) {
        commands.push(...taskCommands(root));
        for (const task of asArray(root.tasks)) {
          const record = asRecord(task);
          if (record !== undefined) {
            commands.push(...taskCommands(record));
          }
        }
      }
      break;
    }
    case 'vscode-launch': {
      const root = asRecord(safeParseJsonc(artifact.content));
      for (const config of asArray(root?.configurations)) {
        const record = asRecord(config);
        if (record !== undefined && typeof record.program === 'string') {
          directPaths.push(record.program);
        }
      }
      break;
    }
    case 'devcontainer': {
      const root = asRecord(safeParseJsonc(artifact.content));
      for (const key of DEVCONTAINER_COMMAND_KEYS) {
        commands.push(...commandStrings(root?.[key]));
      }
      break;
    }
    case 'makefile': {
      // Linhas de receita começam com TAB.
      for (const line of artifact.content.split(/\r?\n/)) {
        if (line.startsWith('\t')) {
          commands.push(line.trim().replace(/^[@\-+]+/, ''));
        }
      }
      break;
    }
    default:
      break;
  }

  const refs: FileReference[] = [];
  for (const command of commands) {
    for (const ref of scriptReferencesInCommand(command)) {
      refs.push({ raw: ref.raw, baseDir: '', kind: ref.kind, depth: 0 });
    }
  }
  for (const raw of directPaths) {
    refs.push({ raw, baseDir: '', kind: SHELL_EXT.test(raw) ? 'shell-script' : 'script', depth: 0 });
  }
  return refs;
}

/**
 * tasks.json, launch.json e devcontainer.json são JSONC (comentários e
 * vírgulas finais). JSON.parse falharia em arquivos válidos e o coletor
 * deixaria de seguir as referências deles.
 */
function safeParseJsonc(text: string): unknown {
  try {
    return parseJsonc(text, [], { allowTrailingComma: true, disallowComments: false });
  } catch {
    return undefined;
  }
}
