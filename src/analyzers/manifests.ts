import { Node as JsonNode, parseTree } from 'jsonc-parser';
import { tokenizeCommand } from '../collector';
import { CollectedArtifact, Evidence, Family } from '../types';
import {
  TextIndex,
  dedupeEvidence,
  findDownloadChains,
  findSensitivePaths,
  makeEvidence,
  quoteCommand,
} from './common';

/**
 * Analisador de manifestos: encontra os pontos em que o repositório pede para
 * ser executado sem ação explícita do usuário (ciclo de vida do npm, tarefas
 * do VS Code, devcontainer, setup.py).
 *
 * As linhas vêm sempre do texto bruto: para JSON usamos a árvore do
 * jsonc-parser, que guarda o deslocamento de cada nó no arquivo original.
 * Isso também expõe chaves duplicadas, que um objeto parseado esconderia.
 */

/** Código JavaScript embutido num comando (`node -e "..."`), para o analisador de scripts. */
export interface InlineScript {
  arquivo: string;
  codigo: string;
  linha: number;
  coluna: number;
}

export interface ManifestAnalysis {
  evidencias: Evidence[];
  scriptsEmbutidos: InlineScript[];
}

export function analyzeManifests(artifacts: CollectedArtifact[]): ManifestAnalysis {
  const evidencias: Evidence[] = [];
  const scriptsEmbutidos: InlineScript[] = [];
  for (const artifact of artifacts) {
    const ctx = new Context(artifact);
    switch (artifact.kind) {
      case 'package-json':
        analyzePackageJson(ctx);
        break;
      case 'vscode-tasks':
        analyzeTasks(ctx);
        break;
      case 'vscode-launch':
        analyzeLaunch(ctx);
        break;
      case 'devcontainer':
        analyzeDevcontainer(ctx);
        break;
      case 'setup-py':
        analyzeSetupPy(ctx);
        break;
      case 'pyproject':
        analyzePyproject(ctx);
        break;
      case 'makefile':
        analyzeMakefile(ctx);
        break;
      default:
        continue;
    }
    evidencias.push(...ctx.evidencias);
    scriptsEmbutidos.push(...ctx.scripts);
  }
  return { evidencias: dedupeEvidence(evidencias), scriptsEmbutidos };
}

class Context {
  readonly evidencias: Evidence[] = [];
  readonly scripts: InlineScript[] = [];
  readonly index: TextIndex;

  constructor(readonly artifact: CollectedArtifact) {
    this.index = new TextIndex(artifact.content);
  }

  get text(): string {
    return this.artifact.content;
  }

  add(
    regra: string,
    familia: Family,
    offset: number,
    explicacao: string,
    extra: { trecho?: string; foraDaContencao?: boolean } = {},
  ): void {
    this.evidencias.push(
      makeEvidence({ regra, familia, arquivo: this.artifact.path, index: this.index, offset, explicacao, ...extra }),
    );
  }

  /** Verificações comuns a qualquer comando de shell declarado num manifesto. */
  checkCommand(command: string, node: JsonNode | undefined, fallbackOffset: number): void {
    for (const chain of findDownloadChains(command)) {
      this.add(
        'download-encadeado',
        'DOWNLOAD_ENCADEADO',
        offsetOfSubstring(this.text, node, chain.text) ?? fallbackOffset,
        'Baixa um programa da internet e o executa na hora, sem que ninguém veja o conteúdo antes.',
        { trecho: chain.text },
      );
    }
    for (const code of inlineNodeCode(command)) {
      const offset = offsetOfSubstring(this.text, node, code.slice(0, 40)) ?? fallbackOffset;
      const { linha, coluna } = this.index.position(offset);
      this.scripts.push({ arquivo: this.artifact.path, codigo: code, linha, coluna });
    }
  }
}

// ---------------------------------------------------------------- JSON utils

interface JsonProperty {
  key: string;
  keyNode: JsonNode;
  valueNode: JsonNode | undefined;
}

function parseJsonTree(text: string): JsonNode | undefined {
  try {
    return parseTree(text, [], { allowTrailingComma: true, disallowComments: false });
  } catch {
    return undefined;
  }
}

/** Todas as propriedades, inclusive chaves repetidas. */
function properties(node: JsonNode | undefined): JsonProperty[] {
  if (node === undefined || node.type !== 'object') {
    return [];
  }
  const out: JsonProperty[] = [];
  for (const prop of node.children ?? []) {
    const keyNode = prop.children?.[0];
    if (keyNode !== undefined && typeof keyNode.value === 'string') {
      out.push({ key: keyNode.value, keyNode, valueNode: prop.children?.[1] });
    }
  }
  return out;
}

function named(node: JsonNode | undefined, name: string): JsonProperty[] {
  return properties(node).filter((p) => p.key === name);
}

function valueOf(node: JsonNode | undefined, name: string): JsonNode | undefined {
  const all = named(node, name);
  // Em chave duplicada, o JSON.parse (npm, VS Code) usa a última ocorrência.
  return all[all.length - 1]?.valueNode;
}

function stringOf(node: JsonNode | undefined): string | undefined {
  return node?.type === 'string' && typeof node.value === 'string' ? node.value : undefined;
}

function items(node: JsonNode | undefined): JsonNode[] {
  return node?.type === 'array' ? node.children ?? [] : [];
}

/** Comandos em string, array de strings ou objeto de comandos (formatos do devcontainer). */
function commandsIn(node: JsonNode | undefined): Array<{ command: string; node: JsonNode }> {
  if (node === undefined) {
    return [];
  }
  const s = stringOf(node);
  if (s !== undefined) {
    return [{ command: s, node }];
  }
  if (node.type === 'array') {
    const parts = items(node).map(stringOf);
    return parts.every((p): p is string => p !== undefined) ? [{ command: parts.join(' '), node }] : [];
  }
  if (node.type === 'object') {
    return properties(node).flatMap((p) => commandsIn(p.valueNode));
  }
  return [];
}

/**
 * Procura um trecho dentro do texto bruto de um nó. O valor parseado pode
 * diferir do bruto por causa de escapes (\" A), então se não achar
 * devolvemos undefined e o chamador usa o início do nó.
 */
function offsetOfSubstring(text: string, node: JsonNode | undefined, needle: string): number | undefined {
  if (node === undefined || needle === '') {
    return undefined;
  }
  const raw = text.slice(node.offset, node.offset + node.length);
  const idx = raw.indexOf(needle);
  return idx >= 0 ? node.offset + idx : undefined;
}

/** Extrai o código de `node -e "..."` / `node --eval` / `node -p`. */
export function inlineNodeCode(command: string): string[] {
  const tokens = tokenizeCommand(command);
  const found: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    const base = tokens[i].split(/[\\/]/).pop() ?? '';
    if (base !== 'node' && base !== 'nodejs' && base !== 'node.exe') {
      continue;
    }
    for (let j = i + 1; j < tokens.length - 1; j++) {
      if (['-e', '--eval', '-p', '--print', '-pe'].includes(tokens[j])) {
        found.push(tokens[j + 1]);
        break;
      }
      if (!tokens[j].startsWith('-')) {
        break;
      }
    }
  }
  return found;
}

// ------------------------------------------------------------- package.json

const LIFECYCLE_SCRIPTS: Record<string, string> = {
  preinstall: 'roda sozinho antes de o npm install baixar as dependências',
  install: 'roda sozinho durante o npm install',
  postinstall: 'roda sozinho logo depois do npm install',
  prepare: 'roda sozinho durante o npm install e ao instalar o pacote direto do git',
  preprepare: 'roda sozinho junto com o prepare, durante o npm install',
  postprepare: 'roda sozinho junto com o prepare, durante o npm install',
  prepublish: 'roda sozinho antes de publicar e, em versões antigas do npm, também no npm install',
};

function analyzePackageJson(ctx: Context): void {
  const root = parseJsonTree(ctx.text);
  for (const scriptsProp of named(root, 'scripts')) {
    for (const script of properties(scriptsProp.valueNode)) {
      const command = stringOf(script.valueNode);
      if (command === undefined) {
        continue;
      }
      const when = LIFECYCLE_SCRIPTS[script.key];
      if (when !== undefined) {
        ctx.add(
          `npm-${script.key}`,
          'EXEC_AUTOMATICA',
          script.keyNode.offset,
          `O script "${script.key}" ${when}, sem você pedir; ele executa: ${quoteCommand(command)}`,
          { trecho: `"${script.key}": "${command}"` },
        );
      }
      // Todos os scripts, não só os automáticos: "npm start" e "npm test"
      // são justamente o que o "desafio técnico" pede para rodar.
      ctx.checkCommand(command, script.valueNode, script.keyNode.offset);
    }
  }
}

// --------------------------------------------------------------- tasks.json

function taskCommand(task: JsonNode): string | undefined {
  const command = stringOf(valueOf(task, 'command'));
  if (command === undefined) {
    return undefined;
  }
  const args = items(valueOf(task, 'args'))
    .map((a) => stringOf(a) ?? stringOf(valueOf(a, 'value')))
    .filter((a): a is string => a !== undefined);
  return [command, ...args].join(' ');
}

function analyzeTasks(ctx: Context): void {
  const root = parseJsonTree(ctx.text);
  const tasks = [...(root !== undefined ? [root] : []), ...items(valueOf(root, 'tasks'))];

  for (const task of tasks) {
    const label = stringOf(valueOf(task, 'label')) ?? stringOf(valueOf(task, 'taskName')) ?? '(sem nome)';
    const command = taskCommand(task);

    // O esquema oficial é runOptions.runOn; aceitamos também runOn solto,
    // pois o objetivo é achar a intenção, não validar o arquivo.
    const runOnProps = [...named(valueOf(task, 'runOptions'), 'runOn'), ...named(task, 'runOn')];
    for (const runOn of runOnProps) {
      if (stringOf(runOn.valueNode) !== 'folderOpen') {
        continue;
      }
      // O VS Code bloqueia tarefas automáticas enquanto o workspace não é
      // confiável; basta um clique em "Confiar" para ela rodar na máquina do
      // usuário, por fora do nosso container. Daí foraDaContencao.
      ctx.add(
        'tasks-folder-open',
        'EXEC_AUTOMATICA',
        runOn.valueNode?.offset ?? runOn.keyNode.offset,
        command !== undefined
          ? `A tarefa "${label}" roda sozinha na sua máquina assim que a pasta é aberta e executa: ${quoteCommand(command)}`
          : `A tarefa "${label}" roda sozinha na sua máquina assim que a pasta é aberta.`,
        { trecho: `runOn: folderOpen → ${command ?? label}`, foraDaContencao: true },
      );
    }

    if (command !== undefined) {
      const commandNode = valueOf(task, 'command');
      ctx.checkCommand(command, commandNode, commandNode?.offset ?? 0);
    }
    for (const platform of ['windows', 'linux', 'osx']) {
      const override = valueOf(task, platform);
      const overrideCommand = override !== undefined ? taskCommand(override) : undefined;
      if (overrideCommand !== undefined) {
        const node = valueOf(override, 'command');
        ctx.checkCommand(overrideCommand, node, node?.offset ?? 0);
      }
    }
  }
}

// -------------------------------------------------------------- launch.json

function analyzeLaunch(ctx: Context): void {
  const root = parseJsonTree(ctx.text);
  for (const config of items(valueOf(root, 'configurations'))) {
    const name = stringOf(valueOf(config, 'name')) ?? '(sem nome)';
    for (const key of ['preLaunchTask', 'postDebugTask']) {
      for (const prop of named(config, key)) {
        const task = stringOf(prop.valueNode);
        if (task === undefined) {
          continue;
        }
        const moment = key === 'preLaunchTask' ? 'antes de começar' : 'ao terminar';
        ctx.add(
          `launch-${key}`,
          'EXEC_AUTOMATICA',
          prop.keyNode.offset,
          `Ao depurar com "${name}", a tarefa "${task}" é executada ${moment}, na sua máquina.`,
        );
      }
    }
  }
}

// ------------------------------------------------------- devcontainer.json

const DEVCONTAINER_COMMANDS: Record<string, { explicacao: string; host: boolean }> = {
  initializeCommand: {
    explicacao: 'roda na SUA máquina, fora do container, antes mesmo de ele ser criado',
    host: true,
  },
  onCreateCommand: { explicacao: 'roda sozinho quando o container é criado', host: false },
  updateContentCommand: { explicacao: 'roda sozinho quando o container é criado', host: false },
  postCreateCommand: { explicacao: 'roda sozinho logo depois de o container ser criado', host: false },
  postStartCommand: { explicacao: 'roda sozinho toda vez que o container inicia', host: false },
  postAttachCommand: { explicacao: 'roda sozinho toda vez que o VS Code se conecta ao container', host: false },
};

/** A pasta pessoal inteira (não uma subpasta dela) montada no container. */
const HOME_MOUNT = /\$\{localEnv:(?:HOME|USERPROFILE)\}[\\/]?(?=[,:"'\s]|$)/;
const SECRET_ENV_NAME = /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE|CREDENTIAL|AWS_|GITHUB_|NPM_|GH_/i;

function analyzeDevcontainer(ctx: Context): void {
  const root = parseJsonTree(ctx.text);

  for (const [key, info] of Object.entries(DEVCONTAINER_COMMANDS)) {
    for (const prop of named(root, key)) {
      for (const { command, node } of commandsIn(prop.valueNode)) {
        ctx.add(
          `devcontainer-${key}`,
          'EXEC_AUTOMATICA',
          prop.keyNode.offset,
          `O ${key} ${info.explicacao} e executa: ${quoteCommand(command)}`,
          { trecho: `${key}: ${command}`, foraDaContencao: info.host },
        );
        ctx.checkCommand(command, node, node.offset);
      }
    }
  }

  // A contenção funciona porque não há segredos dentro do container. Um
  // devcontainer que monta ~/.ssh ou a pasta pessoal desfaz essa premissa.
  const mountStrings: Array<{ text: string; node: JsonNode }> = [];
  for (const mount of items(valueOf(root, 'mounts'))) {
    const s = stringOf(mount) ?? stringOf(valueOf(mount, 'source'));
    if (s !== undefined) {
      mountStrings.push({ text: s, node: mount });
    }
  }
  const runArgs = items(valueOf(root, 'runArgs'));
  for (const arg of runArgs) {
    const s = stringOf(arg);
    if (s !== undefined) {
      mountStrings.push({ text: s, node: arg });
    }
  }

  for (const { text, node } of mountStrings) {
    const sensitive = findSensitivePaths(text)[0];
    if (sensitive !== undefined || HOME_MOUNT.test(text)) {
      ctx.add(
        'devcontainer-monta-segredos',
        'ACESSO_SENSIVEL',
        node.offset,
        sensitive !== undefined
          ? `O container recebe acesso a ${sensitive.rotulo} da sua máquina.`
          : 'O container recebe acesso à sua pasta pessoal inteira, onde ficam chaves e senhas.',
        { trecho: text },
      );
    }
    if (/docker\.sock/.test(text) || text === '--privileged') {
      ctx.add(
        'devcontainer-escape',
        'EXEC_SISTEMA',
        node.offset,
        'Dá ao container controle sobre a sua máquina, o que permite escapar do isolamento.',
        { trecho: text, foraDaContencao: true },
      );
    }
  }

  for (const envKey of ['containerEnv', 'remoteEnv']) {
    for (const prop of properties(valueOf(root, envKey))) {
      const value = stringOf(prop.valueNode) ?? '';
      const m = /\$\{localEnv:([^}:]+)/.exec(value);
      if (m !== null && (SECRET_ENV_NAME.test(m[1]) || SECRET_ENV_NAME.test(prop.key))) {
        ctx.add(
          'devcontainer-env-segredo',
          'ACESSO_SENSIVEL',
          prop.keyNode.offset,
          `Copia a variável secreta ${m[1]} da sua máquina para dentro do container.`,
        );
      }
    }
  }
}

// ----------------------------------------------------------------- Makefile

function analyzeMakefile(ctx: Context): void {
  // O Makefile não roda sozinho; só verificamos download encadeado nas receitas.
  let offset = 0;
  for (const line of ctx.text.split('\n')) {
    if (line.startsWith('\t')) {
      for (const chain of findDownloadChains(line)) {
        ctx.add(
          'download-encadeado',
          'DOWNLOAD_ENCADEADO',
          offset + chain.offset,
          'Baixa um programa da internet e o executa na hora, sem que ninguém veja o conteúdo antes.',
          { trecho: chain.text },
        );
      }
    }
    offset += line.length + 1;
  }
}

// ---------------------------------------------------------------- pyproject

function analyzePyproject(ctx: Context): void {
  const rules: Array<{ regra: string; re: RegExp; explicacao: string }> = [
    {
      regra: 'pyproject-backend-local',
      re: /^[ \t]*backend-path[ \t]*=/m,
      explicacao: 'A instalação usa um programa de build que está no próprio repositório e roda durante o pip install.',
    },
    {
      regra: 'pyproject-cmdclass',
      re: /^[ \t]*\[tool\.setuptools\.cmdclass\]/m,
      explicacao: 'O projeto troca etapas da instalação por código próprio, que roda durante o pip install.',
    },
  ];
  for (const rule of rules) {
    const m = rule.re.exec(ctx.text);
    if (m !== null) {
      ctx.add(rule.regra, 'EXEC_AUTOMATICA', m.index + (m[0].length - m[0].trimStart().length), rule.explicacao);
    }
  }
}

// ----------------------------------------------------------------- setup.py

/** Linha lógica de Python: une continuações e parênteses abertos. */
export interface PythonLine {
  code: string;
  /** Deslocamento no arquivo original de cada caractere de `code`. */
  offsets: number[];
  indent: number;
}

/**
 * Divide Python em linhas lógicas, sem comentários. Strings de aspas triplas
 * viram "" (docstrings geram falsos positivos, e código escondido nelas só
 * roda via exec/eval/compile, que são detectados à parte).
 */
export function pythonLogicalLines(src: string): PythonLine[] {
  const lines: PythonLine[] = [];
  let code = '';
  let offsets: number[] = [];
  let depth = 0;

  const flush = (): void => {
    if (code.trim() !== '') {
      const indent = code.length - code.trimStart().length;
      lines.push({ code: code.slice(indent).trimEnd(), offsets: offsets.slice(indent), indent });
    }
    code = '';
    offsets = [];
  };
  const push = (text: string, at: number): void => {
    code += text;
    for (let k = 0; k < text.length; k++) {
      offsets.push(at + k);
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') {
        i++;
      }
      continue;
    }
    if (ch === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
      push(' ', i);
      i += src[i + 1] === '\r' ? 3 : 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = ch.repeat(3);
      if (src.startsWith(triple, i)) {
        push(`${ch}${ch}`, i);
        let j = i + 3;
        while (j < src.length && !src.startsWith(triple, j)) {
          j += src[j] === '\\' ? 2 : 1;
        }
        i = Math.min(src.length, j + 3);
        continue;
      }
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') {
        j += src[j] === '\\' && src[j + 1] !== '\n' ? 2 : 1;
      }
      const end = src[j] === ch ? j + 1 : j;
      push(src.slice(i, end), i);
      i = end;
      continue;
    }
    if ('([{'.includes(ch)) {
      depth++;
    } else if (')]}'.includes(ch)) {
      depth = Math.max(0, depth - 1);
    }
    if (ch === '\n') {
      if (depth > 0) {
        push(' ', i);
      } else {
        flush();
      }
      i++;
      continue;
    }
    if (ch !== '\r') {
      push(ch, i);
    }
    i++;
  }
  flush();
  return lines;
}

const PY_KEYWORDS = new Set([
  'if', 'elif', 'while', 'for', 'return', 'not', 'and', 'or', 'in', 'is', 'with', 'assert',
  'lambda', 'yield', 'except', 'print', 'await', 'raise', 'del', 'from', 'import', 'as',
]);

/** Chamadas que, no nível de módulo, indicam execução durante o pip install. */
const PY_RISKY_CALLS =
  /^(?:os\.(?:system|popen|exec\w*|spawn\w*|startfile)|subprocess\.\w+|exec|eval|compile|__import__|importlib\.\w+|urllib\w*\.[\w.]+|requests\.\w+|httpx\.\w+|socket\.\w+|http\.client\.[\w.]+|base64\.\w+|codecs\.decode|marshal\.\w+|zlib\.\w+|ctypes\.[\w.]+|shutil\.\w+|pty\.\w+|webbrowser\.\w+)$/;

const PY_FAMILY_PATTERNS: Array<{ regra: string; familia: Family; re: RegExp; explicacao: string }> = [
  {
    regra: 'py-comando-sistema',
    familia: 'EXEC_SISTEMA',
    re: /\b(?:os\.(?:system|popen|exec\w*|spawn\w*)|subprocess\.\w+|pty\.spawn)\s*\(/,
    explicacao: 'Executa comandos do sistema operacional a partir do Python.',
  },
  {
    regra: 'py-codigo-dinamico',
    familia: 'EXEC_SISTEMA',
    re: /(?<![\w.])(?:exec|eval|compile|__import__)\s*\(/,
    explicacao: 'Executa código montado na hora, que não dá para ler direto no arquivo.',
  },
  {
    regra: 'py-rede',
    familia: 'SAIDA_REDE',
    re: /\b(?:urllib(?:2|\.request)?\.\w+|requests\.\w+|httpx\.\w+|http\.client\.\w+|socket\.\w+)\s*\(/,
    explicacao: 'Abre uma conexão com a internet durante a instalação.',
  },
  {
    regra: 'py-decodificacao',
    familia: 'OFUSCACAO',
    re: /\b(?:base64\.b(?:64|32|16|85)decode|codecs\.decode|marshal\.loads|zlib\.decompress)\s*\(/,
    explicacao: 'Decodifica conteúdo escondido, técnica comum para disfarçar código malicioso.',
  },
  {
    regra: 'py-variaveis-ambiente',
    familia: 'ACESSO_SENSIVEL',
    re: /\bos\.(?:environ|getenv)\b/,
    explicacao: 'Lê variáveis de ambiente, onde costumam ficar tokens e senhas.',
  },
];

function analyzeSetupPy(ctx: Context): void {
  const lines = pythonLogicalLines(ctx.text);
  const at = (line: PythonLine, idx: number): number =>
    line.offsets[Math.min(idx, line.offsets.length - 1)] ?? 0;

  const localFunctions = new Set<string>();
  for (const line of lines) {
    const m = /^(?:async\s+)?def\s+([A-Za-z_]\w*)/.exec(line.code);
    if (m !== null) {
      localFunctions.add(m[1]);
    }
  }

  // Corpos de def/class não rodam quando o setup.py é carregado. (Corpos de
  // classe rodam, mas tratá-los à parte complica pouco a análise para ganhar
  // pouco: os padrões perigosos abaixo são procurados no arquivo inteiro.)
  let blockIndent: number | null = null;
  for (const line of lines) {
    let moduleLevel = true;
    if (blockIndent !== null && line.indent > blockIndent) {
      moduleLevel = false;
    } else {
      blockIndent = null;
      if (/^(?:async\s+def|def|class)\b/.test(line.code)) {
        blockIndent = line.indent;
        moduleLevel = false;
      }
    }

    if (moduleLevel) {
      for (const call of line.code.matchAll(/([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*\(/g)) {
        const name = call[1].replace(/\s+/g, '');
        if (PY_KEYWORDS.has(name)) {
          continue;
        }
        if (PY_RISKY_CALLS.test(name) || localFunctions.has(name)) {
          ctx.add(
            'setup-py-nivel-modulo',
            'EXEC_AUTOMATICA',
            at(line, call.index ?? 0),
            `O setup.py chama ${name}(...) assim que o pip o carrega, antes de qualquer instalação.`,
          );
          break;
        }
      }
    }

    const cmdclass = /\bcmdclass\b/.exec(line.code);
    if (cmdclass !== null) {
      ctx.add(
        'setup-py-cmdclass',
        'EXEC_AUTOMATICA',
        at(line, cmdclass.index),
        'O setup.py troca etapas da instalação (cmdclass) por código próprio, que roda durante o pip install.',
      );
    }

    for (const rule of PY_FAMILY_PATTERNS) {
      const m = rule.re.exec(line.code);
      if (m !== null) {
        ctx.add(rule.regra, rule.familia, at(line, m.index), rule.explicacao);
      }
    }
    for (const sensitive of findSensitivePaths(line.code)) {
      ctx.add(
        'py-caminho-sensivel',
        'ACESSO_SENSIVEL',
        at(line, sensitive.offset),
        `Menciona ${sensitive.rotulo}, um lugar que um instalador não tem motivo para ler.`,
      );
    }
    for (const chain of findDownloadChains(line.code)) {
      ctx.add(
        'download-encadeado',
        'DOWNLOAD_ENCADEADO',
        at(line, chain.offset),
        'Baixa um programa da internet e o executa na hora, sem que ninguém veja o conteúdo antes.',
      );
    }
  }
}
