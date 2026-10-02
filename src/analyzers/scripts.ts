import { ParserOptions, ParserPlugin, parse } from '@babel/parser';
import traverse, { NodePath, Visitor } from '@babel/traverse';
import * as t from '@babel/types';
import { CollectedArtifact, Evidence, Family } from '../types';
import {
  TextIndex,
  dedupeEvidence,
  findDownloadChains,
  findSensitivePaths,
  findUrls,
  isReadable,
  makeEvidence,
  tryDecode,
} from './common';
import { InlineScript } from './manifests';

/**
 * Analisador de scripts JavaScript/TypeScript (AST via Babel) e shell (texto).
 *
 * Nada aqui executa o código analisado. `path.evaluate()` do Babel só dobra
 * constantes (concatenação de literais, String.fromCharCode com números
 * literais) e não chama funções do usuário; decodificar Base64 é
 * transformação de texto.
 */

/** Evita um painel ilegível quando a mesma regra dispara centenas de vezes num arquivo. */
const MAX_PER_RULE = 5;
const LONG_STRING = 200;

const CP_FUNCTIONS = new Set(['exec', 'execSync', 'spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']);
/**
 * Nomes específicos o bastante para dispensar saber de onde veio o objeto.
 * `exec` e `fork` ficam de fora: RegExp.prototype.exec e cluster.fork são
 * comuns em código benigno e gerariam alertas falsos (e habituação).
 */
const UNAMBIGUOUS_CP_FUNCTIONS = new Set(['execSync', 'spawnSync', 'execFileSync', 'execFile', 'spawn']);

const NETWORK_MODULE_FUNCTIONS: Record<string, Set<string>> = {
  http: new Set(['request', 'get']),
  https: new Set(['request', 'get']),
  http2: new Set(['connect']),
  net: new Set(['connect', 'createConnection', 'Socket']),
  tls: new Set(['connect']),
  dgram: new Set(['createSocket']),
  // Consultas DNS com dados no nome do domínio são um canal clássico de exfiltração.
  dns: new Set(['resolve', 'resolve4', 'resolve6', 'resolveTxt', 'resolveCname']),
};

const HTTP_CLIENT_MODULES = new Set([
  'axios',
  'node-fetch',
  'got',
  'request',
  'undici',
  'superagent',
  'needle',
  'ws',
  'socket.io-client',
  'phin',
  'cross-fetch',
  'isomorphic-fetch',
]);

const GLOBAL_OBJECTS = new Set(['global', 'globalThis', 'window', 'self']);

/**
 * process.env.NODE_ENV e process.env.PORT aparecem em quase todo projeto.
 * Reportá-los faria todo repositório pontuar ACESSO_SENSIVEL e, somado a
 * qualquer fetch, cruzar o limiar: habituação garantida. Por isso reportamos
 * o ambiente inteiro, nomes calculados e nomes com cara de segredo.
 */
const SECRET_ENV =
  /TOKEN|SECRET|PASSW|API_?KEY|PRIVATE|CREDENTIAL|AUTH|SESSION|COOKIE|^AWS_|^GH_|^GITHUB_|^NPM_|^AZURE_|^GOOGLE_|^GCP_|^OPENAI|^ANTHROPIC|^STRIPE|^DATABASE_URL$|^MONGO|^REDIS_URL$/i;

const BIDI = /[\u202a-\u202e\u2066-\u2069]/;

export function analyzeScripts(artifacts: CollectedArtifact[], inline: InlineScript[] = []): Evidence[] {
  const out: Evidence[] = [];
  for (const artifact of artifacts) {
    if (artifact.kind === 'script') {
      out.push(...analyzeJavaScript(artifact.path, artifact.content));
    } else if (artifact.kind === 'shell-script') {
      out.push(...analyzeShell(artifact.path, artifact.content));
    }
  }
  for (const script of inline) {
    out.push(
      ...analyzeJavaScript(script.arquivo, script.codigo, { linha: script.linha, coluna: script.coluna }),
    );
  }
  return dedupeEvidence(out);
}

class Reporter {
  readonly evidencias: Evidence[] = [];
  readonly index: TextIndex;
  private readonly perRule = new Map<string, number>();

  constructor(
    readonly arquivo: string,
    code: string,
    private readonly base?: { linha: number; coluna: number },
  ) {
    this.index = new TextIndex(code);
  }

  add(
    regra: string,
    familia: Family,
    offset: number,
    explicacao: string,
    extra: { trecho?: string; decodificado?: string } = {},
  ): void {
    const count = this.perRule.get(regra) ?? 0;
    if (count >= MAX_PER_RULE) {
      return;
    }
    this.perRule.set(regra, count + 1);
    const input = { regra, familia, arquivo: this.arquivo, index: this.index, offset, explicacao, ...extra };
    this.evidencias.push(makeEvidence(this.base !== undefined ? { ...input, base: this.base } : input));
  }
}

// ------------------------------------------------------------------ parsing

interface ParseOutcome {
  ast: t.File | undefined;
  errorOffset: number | undefined;
  errorMessage: string | undefined;
}

function errorPos(error: unknown): number | undefined {
  const pos = (error as { pos?: unknown }).pos;
  return typeof pos === 'number' ? pos : undefined;
}

/**
 * A especificação pede sourceType module com typescript+jsx. Esse modo é
 * estrito e rejeita CommonJS legítimo (octal 0755, `with`), e jsx conflita com
 * o cast `<T>x` de arquivos .ts. Tentamos variações em ordem e só concluímos
 * "não parseia" se nenhuma servir; do contrário, todo script de build antigo
 * viraria evidência de ofuscação.
 */
function parseResilient(code: string, file: string): ParseOutcome {
  const isTs = /\.[cm]?ts$/i.test(file);
  const withJsx: ParserPlugin[] = ['typescript', 'jsx', 'decorators-legacy'];
  const withoutJsx: ParserPlugin[] = ['typescript', 'decorators-legacy'];
  const pluginSets: ParserPlugin[][] = isTs ? [withoutJsx, withJsx] : [withJsx, ['jsx'], withoutJsx];

  const attempts: ParserOptions[] = [];
  for (const plugins of pluginSets) {
    for (const sourceType of ['module', 'script'] as const) {
      attempts.push({
        sourceType,
        plugins,
        errorRecovery: true,
        allowReturnOutsideFunction: true,
        allowAwaitOutsideFunction: true,
        allowImportExportEverywhere: true,
        allowUndeclaredExports: true,
        allowSuperOutsideMethod: true,
        allowNewTargetOutsideFunction: true,
      });
    }
  }

  let best: { ast: t.File; errors: unknown[] } | undefined;
  let firstThrown: unknown;
  for (const options of attempts) {
    try {
      const ast = parse(code, options);
      const errors: unknown[] = ast.errors ?? [];
      if (errors.length === 0) {
        return { ast, errorOffset: undefined, errorMessage: undefined };
      }
      if (best === undefined || errors.length < best.errors.length) {
        best = { ast, errors };
      }
    } catch (error) {
      firstThrown ??= error;
    }
  }
  if (best !== undefined) {
    const first = best.errors[0];
    return { ast: best.ast, errorOffset: errorPos(first), errorMessage: String((first as Error).message) };
  }
  return { ast: undefined, errorOffset: errorPos(firstThrown), errorMessage: String(firstThrown) };
}

// ---------------------------------------------------------------- AST utils

type AnyMember = t.MemberExpression | t.OptionalMemberExpression;

function isMember(node: t.Node | null | undefined): node is AnyMember {
  return t.isMemberExpression(node) || t.isOptionalMemberExpression(node);
}

function propName(node: AnyMember): string | undefined {
  if (!node.computed && t.isIdentifier(node.property)) {
    return node.property.name;
  }
  if (t.isStringLiteral(node.property)) {
    return node.property.value;
  }
  return undefined;
}

function normalizeModule(name: string): string {
  return name.replace(/^node:/, '');
}

/** require(x), import(x), module.require(x), createRequire(...)(x). */
function isModuleRequest(node: t.Node | null | undefined): node is t.CallExpression {
  if (!t.isCallExpression(node) || node.arguments.length === 0) {
    return false;
  }
  const c = node.callee;
  return (
    t.isIdentifier(c, { name: 'require' }) ||
    t.isImport(c) ||
    (isMember(c) && propName(c) === 'require') ||
    (t.isCallExpression(c) && t.isIdentifier(c.callee, { name: 'createRequire' }))
  );
}

/** Valor de string conhecido estaticamente, incluindo ['a','b'].join('') e concatenações. */
function staticString(path: NodePath | undefined, depth = 0): string | undefined {
  if (path === undefined || path.node === null || path.node === undefined || depth > 30) {
    return undefined;
  }
  if (path.isStringLiteral()) {
    return path.node.value;
  }
  if (path.isTemplateLiteral() && path.node.expressions.length === 0) {
    return path.node.quasis.map((q) => q.value.cooked ?? q.value.raw).join('');
  }
  if (path.isBinaryExpression({ operator: '+' })) {
    const left = staticString(path.get('left') as NodePath, depth + 1);
    const right = staticString(path.get('right') as NodePath, depth + 1);
    if (left !== undefined && right !== undefined) {
      return left + right;
    }
  }
  if (path.isCallExpression()) {
    const callee = path.get('callee');
    if (callee.isMemberExpression() && propName(callee.node) === 'join') {
      const object = callee.get('object');
      if (object.isArrayExpression()) {
        const parts = object.get('elements').map((e) => staticString(e as NodePath, depth + 1));
        const sepPath = path.get('arguments')[0] as NodePath | undefined;
        const sep = sepPath === undefined ? ',' : staticString(sepPath, depth + 1);
        if (sep !== undefined && parts.every((p): p is string => p !== undefined)) {
          return parts.join(sep);
        }
      }
    }
  }
  try {
    const result = path.evaluate();
    if (result.confident && typeof result.value === 'string') {
      return result.value;
    }
  } catch {
    // evaluate pode lançar em ASTs recuperadas de erro; tratamos como desconhecido.
  }
  return undefined;
}

function literalLeaves(node: t.Node): string[] {
  const leaves: string[] = [];
  t.traverseFast(node, (n) => {
    if (t.isStringLiteral(n)) {
      leaves.push(n.value);
    } else if (t.isTemplateElement(n)) {
      leaves.push(n.value.cooked ?? n.value.raw);
    }
  });
  return leaves;
}

function decodeAs(value: string, encoding: string): string | undefined {
  const enc = encoding.toLowerCase();
  if (enc !== 'base64' && enc !== 'base64url' && enc !== 'hex') {
    return undefined;
  }
  const text = Buffer.from(value, enc).toString('utf8');
  return isReadable(text) ? text : undefined;
}

interface ModuleBinding {
  module: string;
  /** Nome exportado, se veio de desestruturação ou import nomeado. */
  export?: string;
}

// --------------------------------------------------------------- JavaScript

export function analyzeJavaScript(
  arquivo: string,
  code: string,
  base?: { linha: number; coluna: number },
): Evidence[] {
  const rep = new Reporter(arquivo, code, base);

  const bidi = BIDI.exec(code);
  if (bidi !== null) {
    rep.add(
      'trojan-source',
      'OFUSCACAO',
      bidi.index,
      'Há caracteres invisíveis que fazem o código aparecer na tela diferente do que ele realmente faz.',
    );
  }

  const parsed = parseResilient(code, arquivo);
  if (parsed.errorMessage !== undefined) {
    // Código que não parseia é suspeito, não motivo para pular o arquivo:
    // o Node pode aceitar algo que o Babel recusa, e vice-versa.
    rep.add(
      'parse-falhou',
      'OFUSCACAO',
      parsed.errorOffset ?? 0,
      'Este arquivo não pôde ser lido como código válido; código que resiste à análise é tratado como suspeito.',
    );
  }
  if (parsed.ast === undefined) {
    scanRawText(rep, code);
    return rep.evidencias;
  }

  const bindings = collectModuleBindings(parsed.ast);
  const visitor = new JsVisitor(rep, bindings);
  traverse(parsed.ast, visitor.build());
  visitor.finish();
  return rep.evidencias;
}

function collectModuleBindings(ast: t.File): Map<string, ModuleBinding> {
  const bindings = new Map<string, ModuleBinding>();

  const fromPattern = (id: t.Node, module: string): void => {
    if (t.isIdentifier(id)) {
      bindings.set(id.name, { module });
    } else if (t.isObjectPattern(id)) {
      for (const prop of id.properties) {
        if (!t.isObjectProperty(prop)) {
          continue;
        }
        const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : undefined;
        const local = t.isAssignmentPattern(prop.value) ? prop.value.left : prop.value;
        if (key !== undefined && t.isIdentifier(local)) {
          bindings.set(local.name, { module, export: key });
        }
      }
    }
  };

  traverse(ast, {
    VariableDeclarator(path) {
      let initPath = path.get('init') as NodePath;
      if (initPath.isAwaitExpression()) {
        initPath = initPath.get('argument') as NodePath;
      }
      const init = initPath.node;
      if (isModuleRequest(init)) {
        // Resolve também nomes montados: require('child_' + 'process').
        const name = staticString((initPath.get('arguments') as NodePath[])[0]);
        if (name !== undefined) {
          fromPattern(path.node.id, normalizeModule(name));
        }
      } else if (isMember(init) && isModuleRequest(init.object)) {
        const arg = init.object.arguments[0];
        const prop = propName(init);
        if (t.isStringLiteral(arg) && prop !== undefined && t.isIdentifier(path.node.id)) {
          bindings.set(path.node.id.name, { module: normalizeModule(arg.value), export: prop });
        }
      }
    },
    ImportDeclaration(path) {
      const module = normalizeModule(path.node.source.value);
      for (const spec of path.node.specifiers) {
        if (t.isImportSpecifier(spec)) {
          const imported = t.isIdentifier(spec.imported) ? spec.imported.name : spec.imported.value;
          bindings.set(spec.local.name, { module, export: imported });
        } else {
          bindings.set(spec.local.name, { module });
        }
      }
    },
    TSImportEqualsDeclaration(path) {
      const ref = path.node.moduleReference;
      if (t.isTSExternalModuleReference(ref)) {
        bindings.set(path.node.id.name, { module: normalizeModule(ref.expression.value) });
      }
    },
  });
  return bindings;
}

interface CalleeInfo {
  /** Módulo de onde a função veio, se conhecido. */
  module?: string;
  /** Nome do objeto global quando a chamada é `global.fn()`. */
  object?: string;
  fn: string;
  isMemberCall: boolean;
}

class JsVisitor {
  private fromCharCodeCalls = 0;
  private readonly seenBindings = new Set<t.Node>();
  private totalBindings = 0;
  private singleLetter: t.Node[] = [];
  private hexNames: t.Node[] = [];

  constructor(
    private readonly rep: Reporter,
    private readonly bindings: Map<string, ModuleBinding>,
  ) {}

  build(): Visitor {
    return {
      CallExpression: (path) => this.onCall(path),
      OptionalCallExpression: (path) => this.onCall(path),
      NewExpression: (path) => this.onCall(path),
      MemberExpression: (path) => this.onMember(path),
      StringLiteral: (path) => this.onString(path),
      TemplateLiteral: (path) => this.onTemplate(path),
      BinaryExpression: (path) => this.onBinary(path),
      Scopable: (path) => this.onScope(path),
    };
  }

  finish(): void {
    if (this.hexNames.length >= 3) {
      this.rep.add(
        'nomes-hexadecimais',
        'OFUSCACAO',
        this.hexNames[0].start ?? 0,
        'As variáveis têm nomes como _0x1a2b, assinatura típica de ferramentas que disfarçam código.',
      );
    }
    if (this.totalBindings >= 20 && this.singleLetter.length / this.totalBindings >= 0.5) {
      this.rep.add(
        'nomes-curtos',
        'OFUSCACAO',
        this.singleLetter[0].start ?? 0,
        `${this.singleLetter.length} de ${this.totalBindings} variáveis têm nome de uma letra só, o que esconde o que o código faz.`,
      );
    }
  }

  private at(node: t.Node): number {
    return node.start ?? 0;
  }

  // ------------------------------------------------------------- chamadas

  private calleeInfo(callee: t.Node, scopePath: NodePath): CalleeInfo | undefined {
    if (t.isIdentifier(callee)) {
      const b = this.bindings.get(callee.name);
      if (b !== undefined) {
        return { module: b.module, fn: b.export ?? 'default', isMemberCall: false };
      }
      if (scopePath.scope.getBinding(callee.name) !== undefined) {
        return { fn: `local:${callee.name}`, isMemberCall: false };
      }
      return { fn: callee.name, isMemberCall: false };
    }
    if (isMember(callee)) {
      const fn = propName(callee);
      if (fn === undefined) {
        return undefined;
      }
      const obj = callee.object;
      if (t.isIdentifier(obj)) {
        const b = this.bindings.get(obj.name);
        if (b !== undefined) {
          return { module: b.export === undefined ? b.module : `${b.module}#${b.export}`, fn, isMemberCall: true };
        }
        return { object: obj.name, fn, isMemberCall: true };
      }
      if (isModuleRequest(obj) && t.isStringLiteral(obj.arguments[0])) {
        return { module: normalizeModule(obj.arguments[0].value), fn, isMemberCall: true };
      }
      return { fn, isMemberCall: true };
    }
    if (t.isSequenceExpression(callee)) {
      const last = callee.expressions[callee.expressions.length - 1];
      if (t.isIdentifier(last, { name: 'eval' })) {
        return { fn: 'eval', isMemberCall: false }; // (0, eval)(...) = eval indireto
      }
    }
    return undefined;
  }

  private onCall(path: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>): void {
    const node = path.node;
    const isNew = t.isNewExpression(node);
    const args = path.get('arguments') as NodePath[];
    const firstArg = args[0];

    if (!isNew && isModuleRequest(node)) {
      this.onModuleRequest(node, firstArg);
    }

    const info = this.calleeInfo(node.callee, path);
    if (info === undefined) {
      this.checkConstructorTrick(node);
      return;
    }
    const module = info.module?.split('#')[0];
    const offset = this.at(node);

    // ---- EXEC_SISTEMA
    // Cobre cp.exec(), exec() desestruturado, require('child_process').exec()
    // e aliases (import { exec as run }), pois calleeInfo resolve o binding.
    const cpCall =
      (module === 'child_process' && CP_FUNCTIONS.has(info.fn)) ||
      (info.isMemberCall && UNAMBIGUOUS_CP_FUNCTIONS.has(info.fn));
    if (cpCall) {
      const command = staticString(firstArg);
      this.rep.add(
        'exec-sistema',
        'EXEC_SISTEMA',
        offset,
        command !== undefined
          ? `Executa no sistema o comando "${command.slice(0, 60)}" com ${info.fn}().`
          : `Executa comandos do sistema operacional com ${info.fn}(), com o mesmo poder que você tem no terminal.`,
      );
      if (command !== undefined) {
        this.scanDecoded(command, offset, 'no comando executado');
      }
    }

    const isGlobalFn = (name: string): boolean =>
      (!info.isMemberCall && info.module === undefined && info.fn === name) ||
      (info.isMemberCall && info.object !== undefined && GLOBAL_OBJECTS.has(info.object) && info.fn === name);

    if (!isNew && isGlobalFn('eval')) {
      this.rep.add(
        'eval',
        'EXEC_SISTEMA',
        offset,
        'Usa eval() para executar um texto como código, que só será conhecido quando rodar.',
      );
    }
    if (isGlobalFn('Function')) {
      this.rep.add(
        'new-function',
        'EXEC_SISTEMA',
        offset,
        'Cria uma função a partir de um texto (new Function), uma forma disfarçada de executar código.',
      );
    }
    if (
      (isGlobalFn('setTimeout') || isGlobalFn('setInterval') || isGlobalFn('setImmediate')) &&
      firstArg !== undefined &&
      (firstArg.isStringLiteral() || firstArg.isTemplateLiteral() || firstArg.isBinaryExpression())
    ) {
      this.rep.add('eval', 'EXEC_SISTEMA', offset, 'Passa um texto para ser executado como código mais tarde, como um eval() escondido.');
    }
    if (info.object === 'process' && ['binding', '_linkedBinding', 'dlopen'].includes(info.fn)) {
      this.rep.add(
        'process-binding',
        'EXEC_SISTEMA',
        offset,
        'Acessa partes internas do Node que permitem executar programas sem passar pelos módulos usuais.',
      );
    }
    if (module === 'vm' && /^(?:run\w*|compileFunction|Script|default)$/.test(info.fn)) {
      this.rep.add('vm-exec', 'EXEC_SISTEMA', offset, 'Executa um texto como código usando o módulo vm do Node.');
    }

    // ---- SAIDA_REDE
    let network: string | undefined;
    if (isGlobalFn('fetch')) {
      network = 'fetch';
    } else if (module !== undefined && NETWORK_MODULE_FUNCTIONS[module]?.has(info.fn) === true) {
      network = `${module}.${info.fn}`;
    } else if (module !== undefined && HTTP_CLIENT_MODULES.has(module)) {
      network = module;
    } else if (info.object === 'axios' || (info.fn === 'axios' && !info.isMemberCall)) {
      network = 'axios';
    } else if (isNew && (isGlobalFn('WebSocket') || isGlobalFn('XMLHttpRequest'))) {
      network = info.fn;
    } else if (info.object === 'navigator' && info.fn === 'sendBeacon') {
      network = 'navigator.sendBeacon';
    }
    if (network !== undefined) {
      const target = staticString(firstArg);
      const host = target !== undefined ? findUrls(target)[0]?.host : undefined;
      this.rep.add(
        'rede',
        'SAIDA_REDE',
        offset,
        host !== undefined
          ? `Abre uma conexão de rede com ${host} usando ${network}; dados podem sair da sua máquina por aqui.`
          : `Abre uma conexão de rede usando ${network}; dados podem sair da sua máquina por aqui.`,
      );
    }

    // ---- OFUSCACAO
    const isBufferFrom = (info.object === 'Buffer' && info.fn === 'from') || (isNew && isGlobalFn('Buffer'));
    if (isBufferFrom && args.length >= 2) {
      const encoding = staticString(args[1]);
      if (encoding !== undefined && /^(?:base64|base64url|hex)$/i.test(encoding)) {
        const raw = staticString(firstArg);
        const decoded = raw !== undefined ? decodeAs(raw, encoding) : undefined;
        this.reportDecoding(offset, `Decodifica um conteúdo escondido em ${encoding}.`, decoded, encoding);
      }
    }
    if (!isNew && isGlobalFn('atob')) {
      const raw = staticString(firstArg);
      const decoded = raw !== undefined ? decodeAs(raw, 'base64') : undefined;
      this.reportDecoding(offset, 'Decodifica um conteúdo escondido em Base64 com atob().', decoded, 'Base64');
    }
    this.checkFromCharCode(path, info, offset);
    this.checkJoinFragments(path);
  }

  private onModuleRequest(node: t.CallExpression, argPath: NodePath | undefined): void {
    const arg = node.arguments[0];
    const isLiteral = t.isStringLiteral(arg) || (t.isTemplateLiteral(arg) && arg.expressions.length === 0);
    const name = staticString(argPath);
    const offset = this.at(node);
    if (name === undefined) {
      this.rep.add(
        'modulo-dinamico',
        'OFUSCACAO',
        offset,
        'Carrega um módulo cujo nome só é conhecido quando o código roda, o que impede saber o que ele usa.',
      );
      return;
    }
    const module = normalizeModule(name);
    if (!isLiteral) {
      this.rep.add(
        'modulo-nome-montado',
        'OFUSCACAO',
        offset,
        `Monta em pedaços o nome do módulo "${module}", um truque para fugir de buscas simples.`,
        { decodificado: module },
      );
    }
    if (module === 'child_process') {
      this.rep.add(
        'modulo-child-process',
        'EXEC_SISTEMA',
        offset,
        'Carrega o módulo child_process, que permite executar qualquer comando do sistema operacional.',
      );
    } else if (module === 'vm') {
      this.rep.add('modulo-vm', 'EXEC_SISTEMA', offset, 'Carrega o módulo vm, que executa textos como código.');
    }
  }

  /** `[].constructor.constructor("código")()` = new Function disfarçado. */
  private checkConstructorTrick(node: t.CallExpression | t.OptionalCallExpression | t.NewExpression): void {
    const c = node.callee;
    if (isMember(c) && propName(c) === 'constructor' && isMember(c.object) && propName(c.object) === 'constructor') {
      this.rep.add(
        'new-function',
        'EXEC_SISTEMA',
        this.at(node),
        'Chega ao construtor de funções por um caminho indireto para executar texto como código.',
      );
    }
  }

  private checkFromCharCode(
    path: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>,
    info: CalleeInfo,
    offset: number,
  ): void {
    const node = path.node;
    const direct = info.object === 'String' && info.fn === 'fromCharCode';
    // String.fromCharCode.apply(null, [...]) / .call(...)
    const applied =
      (info.fn === 'apply' || info.fn === 'call') &&
      isMember(node.callee) &&
      isMember(node.callee.object) &&
      t.isIdentifier(node.callee.object.object, { name: 'String' }) &&
      propName(node.callee.object) === 'fromCharCode';
    if (!direct && !applied) {
      return;
    }
    this.fromCharCodeCalls++;
    const chained =
      applied ||
      node.arguments.length >= 4 ||
      node.arguments.some((a) => t.isSpreadElement(a)) ||
      (t.isBinaryExpression(path.parent) && path.parent.operator === '+') ||
      this.fromCharCodeCalls === 3;
    if (chained) {
      const decoded = staticString(path as NodePath);
      this.reportDecoding(
        offset,
        'Monta um texto a partir de códigos numéricos (String.fromCharCode), técnica usada para esconder palavras do leitor.',
        decoded,
        'códigos de caractere',
        'fromcharcode',
      );
    }
  }

  private checkJoinFragments(path: NodePath<t.CallExpression | t.OptionalCallExpression | t.NewExpression>): void {
    const c = path.node.callee;
    if (!t.isCallExpression(path.node) || !isMember(c) || propName(c) !== 'join' || !t.isArrayExpression(c.object)) {
      return;
    }
    const value = staticString(path as NodePath);
    if (value !== undefined) {
      this.scanAssembled(value, path.node);
    }
  }

  private reportDecoding(
    offset: number,
    explicacao: string,
    decoded: string | undefined,
    how: string,
    regra = 'decodificacao',
  ): void {
    this.rep.add(regra, 'OFUSCACAO', offset, explicacao, decoded !== undefined ? { decodificado: decoded } : {});
    if (decoded !== undefined) {
      this.scanDecoded(decoded, offset, `escondido em ${how}`);
    }
  }

  // ---------------------------------------------------------- process.env

  private onMember(path: NodePath<t.MemberExpression>): void {
    const n = path.node;
    if (!t.isIdentifier(n.object, { name: 'process' }) || propName(n) !== 'env' || path.scope.getBinding('process') !== undefined) {
      return;
    }
    const parent = path.parentPath;
    const offset = this.at(n);

    if (parent?.isMemberExpression() && parent.node.object === n) {
      const key = propName(parent.node);
      if (key === undefined) {
        this.rep.add(
          'process-env-dinamico',
          'ACESSO_SENSIVEL',
          offset,
          'Lê uma variável de ambiente cujo nome só é conhecido quando o código roda.',
        );
      } else if (SECRET_ENV.test(key)) {
        this.rep.add(
          'process-env-segredo',
          'ACESSO_SENSIVEL',
          offset,
          `Lê a variável de ambiente ${key}, que costuma guardar uma senha ou um token.`,
        );
      }
      return;
    }

    if (parent?.isVariableDeclarator() && t.isObjectPattern(parent.node.id)) {
      for (const prop of parent.node.id.properties) {
        if (t.isRestElement(prop)) {
          this.reportWholeEnv(offset);
        } else if (t.isObjectProperty(prop)) {
          const key = t.isIdentifier(prop.key) ? prop.key.name : t.isStringLiteral(prop.key) ? prop.key.value : '';
          if (SECRET_ENV.test(key)) {
            this.rep.add(
              'process-env-segredo',
              'ACESSO_SENSIVEL',
              offset,
              `Lê a variável de ambiente ${key}, que costuma guardar uma senha ou um token.`,
            );
          }
        }
      }
      return;
    }

    // `spawn(cmd, { env: process.env })` e `{ env: { ...process.env } }`
    // apenas repassam o ambiente a um processo filho; a chamada em si já é
    // reportada como EXEC_SISTEMA.
    const envProperty = (p: NodePath | null): boolean =>
      p !== null && p.isObjectProperty() && t.isIdentifier(p.node.key, { name: 'env' });
    if (envProperty(parent)) {
      return;
    }
    if (parent?.isSpreadElement() && envProperty(parent.parentPath?.parentPath ?? null)) {
      return;
    }
    this.reportWholeEnv(offset);
  }

  private reportWholeEnv(offset: number): void {
    this.rep.add(
      'process-env-inteiro',
      'ACESSO_SENSIVEL',
      offset,
      'Pega todas as variáveis de ambiente de uma vez, incluindo tokens e senhas que estejam nelas.',
    );
  }

  // --------------------------------------------------------------- strings

  private onString(path: NodePath<t.StringLiteral>): void {
    const parent = path.parent;
    // Nomes de módulo já são tratados em onModuleRequest/ImportDeclaration.
    if (
      t.isImportDeclaration(parent) ||
      t.isExportNamedDeclaration(parent) ||
      t.isExportAllDeclaration(parent) ||
      (isModuleRequest(parent) && parent.arguments[0] === path.node) ||
      t.isTSLiteralType(parent) ||
      t.isDirectiveLiteral(path.node)
    ) {
      return;
    }
    const raw = (path.node.extra as { raw?: unknown } | undefined)?.raw;
    this.scanString(path.node.value, this.at(path.node), typeof raw === 'string' ? raw : undefined);
  }

  private onTemplate(path: NodePath<t.TemplateLiteral>): void {
    if (t.isTaggedTemplateExpression(path.parent) && t.isIdentifier(path.parent.tag, { name: 'String' })) {
      return;
    }
    for (const quasi of path.node.quasis) {
      this.scanString(quasi.value.cooked ?? quasi.value.raw, this.at(quasi), quasi.value.raw);
    }
  }

  private onBinary(path: NodePath<t.BinaryExpression>): void {
    if (path.node.operator !== '+') {
      return;
    }
    // Só a raiz de uma cadeia de concatenações, para não reavaliar a mesma cadeia N vezes.
    if (t.isBinaryExpression(path.parent) && path.parent.operator === '+') {
      return;
    }
    const value = staticString(path as NodePath);
    if (value !== undefined) {
      this.scanAssembled(value, path.node);
    }
  }

  private scanString(value: string, offset: number, raw?: string): void {
    for (const s of findSensitivePaths(value)) {
      this.rep.add(
        'caminho-sensivel',
        'ACESSO_SENSIVEL',
        offset,
        `Menciona ${s.rotulo}, um lugar que um script de projeto não tem motivo para ler.`,
      );
    }
    for (const chain of findDownloadChains(value)) {
      this.rep.add(
        'download-encadeado',
        'DOWNLOAD_ENCADEADO',
        offset,
        'Baixa um programa da internet e o executa na hora, sem que ninguém veja o conteúdo antes.',
        { trecho: chain.text },
      );
    }
    for (const url of findUrls(value)) {
      if (!url.benigno) {
        this.rep.add(
          'url-desconhecida',
          'SAIDA_REDE',
          offset,
          `Contém o endereço ${url.host}, para onde dados podem ser enviados ou de onde código pode ser baixado.`,
        );
      }
    }
    if (value.length > LONG_STRING && !/\s/.test(value)) {
      const decoded = tryDecode(value);
      this.reportDecoding(
        offset,
        `Tem um texto de ${value.length} caracteres sem espaços, formato típico de conteúdo codificado para não ser lido.`,
        decoded,
        'um texto codificado',
        'string-longa',
      );
    }
    if (raw !== undefined && (raw.match(/\\x[0-9a-f]{2}|\\u\{?[0-9a-f]{4,6}\}?/gi)?.length ?? 0) >= 6) {
      this.rep.add(
        'escapes',
        'OFUSCACAO',
        offset,
        'Escreve o texto com códigos de escape (\\x..) em vez de letras, para esconder o que ele diz.',
        isReadable(value) ? { decodificado: value } : {},
      );
    }
  }

  /**
   * Texto montado a partir de pedaços ('.s' + 'sh', [...].join('')). Só
   * reporta o que NÃO aparece em nenhum pedaço isolado, pois os pedaços já
   * foram analisados como strings comuns.
   */
  private scanAssembled(value: string, node: t.Node): void {
    const leaves = literalLeaves(node);
    const inLeaf = (text: string): boolean => leaves.some((leaf) => leaf.includes(text));
    const offset = this.at(node);
    let fragmented = false;

    for (const s of findSensitivePaths(value)) {
      if (!inLeaf(s.text)) {
        fragmented = true;
        this.rep.add(
          'caminho-sensivel-montado',
          'ACESSO_SENSIVEL',
          offset,
          `Monta em pedaços o caminho para ${s.rotulo}, para fugir de buscas simples.`,
          { decodificado: value },
        );
      }
    }
    for (const url of findUrls(value)) {
      if (!url.benigno && !inLeaf(url.text)) {
        fragmented = true;
        this.rep.add(
          'url-montada',
          'SAIDA_REDE',
          offset,
          `Monta em pedaços o endereço ${url.host}, para fugir de buscas simples.`,
          { decodificado: value },
        );
      }
    }
    for (const chain of findDownloadChains(value)) {
      if (!inLeaf(chain.text)) {
        fragmented = true;
        this.rep.add(
          'download-encadeado',
          'DOWNLOAD_ENCADEADO',
          offset,
          'Monta em pedaços um comando que baixa um programa da internet e o executa na hora.',
          { decodificado: value },
        );
      }
    }
    if (fragmented) {
      this.rep.add(
        'string-fragmentada',
        'OFUSCACAO',
        offset,
        'Divide um texto importante em pedaços para que ele não apareça inteiro no código.',
        { decodificado: value },
      );
    }
  }

  /** Procura sinais dentro de conteúdo decodificado (texto; nunca executado). */
  private scanDecoded(decoded: string, offset: number, how: string): void {
    scanHiddenText(this.rep, decoded, offset, how);
  }

  // ----------------------------------------------------------------- nomes

  private onScope(path: NodePath<t.Scopable>): void {
    for (const [name, binding] of Object.entries(path.scope.bindings)) {
      if (this.seenBindings.has(binding.identifier)) {
        continue;
      }
      this.seenBindings.add(binding.identifier);
      this.totalBindings++;
      if (name.length === 1) {
        this.singleLetter.push(binding.identifier);
      }
      if (/^_0x[0-9a-f]{3,}$/i.test(name)) {
        this.hexNames.push(binding.identifier);
      }
    }
  }
}

function scanHiddenText(rep: Reporter, text: string, offset: number, how: string): void {
  const opts = { decodificado: text };
  for (const s of findSensitivePaths(text)) {
    rep.add('oculto-caminho-sensivel', 'ACESSO_SENSIVEL', offset, `Há um texto ${how} que menciona ${s.rotulo}.`, opts);
  }
  for (const url of findUrls(text)) {
    if (!url.benigno) {
      rep.add('oculto-url', 'SAIDA_REDE', offset, `Há um texto ${how} com o endereço ${url.host}.`, opts);
    }
  }
  if (findDownloadChains(text).length > 0) {
    rep.add(
      'oculto-download',
      'DOWNLOAD_ENCADEADO',
      offset,
      `Há um texto ${how} que baixa e executa um programa da internet.`,
      opts,
    );
  }
  if (/child_process|\bexecSync\b|\bspawn\s*\(|\beval\s*\(|new\s+Function\b/.test(text)) {
    rep.add('oculto-exec', 'EXEC_SISTEMA', offset, `Há código ${how} que executa comandos no sistema.`, opts);
  }
  if (/\bfetch\s*\(|\bhttps?\.(?:request|get)\b|\baxios\b|XMLHttpRequest|\bnet\.connect\b/.test(text)) {
    rep.add('oculto-rede', 'SAIDA_REDE', offset, `Há código ${how} que se conecta à internet.`, opts);
  }
  if (/process\.env/.test(text)) {
    rep.add('oculto-env', 'ACESSO_SENSIVEL', offset, `Há código ${how} que lê as variáveis de ambiente.`, opts);
  }
}

/** Plano B quando nenhum parse funcionou: o arquivo não é ignorado, é lido como texto. */
function scanRawText(rep: Reporter, code: string): void {
  const rules: Array<{ regra: string; familia: Family; re: RegExp; explicacao: string }> = [
    {
      regra: 'exec-sistema',
      familia: 'EXEC_SISTEMA',
      re: /child_process|\bexecSync\s*\(|\bspawn\s*\(|\beval\s*\(|new\s+Function\s*\(/g,
      explicacao: 'Há sinais de código que executa comandos do sistema.',
    },
    {
      regra: 'rede',
      familia: 'SAIDA_REDE',
      re: /\bfetch\s*\(|\bhttps?\.(?:request|get)\s*\(|\baxios\b|\bnet\.connect\s*\(/g,
      explicacao: 'Há sinais de código que se conecta à internet.',
    },
    {
      regra: 'process-env-inteiro',
      familia: 'ACESSO_SENSIVEL',
      re: /process\.env\b/g,
      explicacao: 'Há sinais de leitura das variáveis de ambiente.',
    },
    {
      regra: 'decodificacao',
      familia: 'OFUSCACAO',
      re: /\batob\s*\(|['"]base64['"]/g,
      explicacao: 'Há sinais de conteúdo escondido em Base64.',
    },
  ];
  for (const rule of rules) {
    for (const m of code.matchAll(rule.re)) {
      rep.add(rule.regra, rule.familia, m.index ?? 0, rule.explicacao);
    }
  }
  for (const s of findSensitivePaths(code)) {
    rep.add('caminho-sensivel', 'ACESSO_SENSIVEL', s.offset, `Menciona ${s.rotulo}.`);
  }
  for (const url of findUrls(code)) {
    if (!url.benigno) {
      rep.add('url-desconhecida', 'SAIDA_REDE', url.offset, `Contém o endereço ${url.host}.`);
    }
  }
  for (const chain of findDownloadChains(code)) {
    rep.add(
      'download-encadeado',
      'DOWNLOAD_ENCADEADO',
      chain.offset,
      'Baixa um programa da internet e o executa na hora.',
    );
  }
}

// -------------------------------------------------------------------- shell

const SHELL_RULES: Array<{ regra: string; familia: Family; re: RegExp; explicacao: string }> = [
  {
    regra: 'shell-socket',
    familia: 'SAIDA_REDE',
    re: /\b(?:nc|ncat|netcat|socat)\s+\S|\/dev\/(?:tcp|udp)\//,
    explicacao: 'Abre uma conexão de rede direta, um jeito comum de enviar dados para fora.',
  },
  {
    regra: 'shell-upload',
    familia: 'SAIDA_REDE',
    re: /\bcurl\b[^\n]*\s(?:-d|--data(?:-binary|-raw|-urlencode)?|-F|--form|-T|--upload-file)(?:\s|=|$)|\bwget\b[^\n]*--post-(?:data|file)/,
    explicacao: 'Envia dados desta máquina para um servidor na internet.',
  },
  {
    regra: 'shell-decodificacao',
    familia: 'OFUSCACAO',
    re: /\bbase64\s+(?:-d|--decode|-D)\b|\bxxd\s+-r\b|\bopenssl\s+(?:enc\s+)?(?:base64\s+)?-d\b/,
    explicacao: 'Decodifica um conteúdo escondido antes de usá-lo.',
  },
  {
    regra: 'shell-eval',
    familia: 'EXEC_SISTEMA',
    re: /(?:^|[;&|(\s])eval\s/,
    explicacao: 'Usa eval para executar um texto montado na hora como comando.',
  },
  {
    regra: 'shell-env-inteiro',
    familia: 'ACESSO_SENSIVEL',
    re: /(?:^|[;&|(\s])(?:printenv|env)\s*(?:$|[|>;&])|\bexport\s+-p\b|(?:^|\s)set\s*\|/,
    explicacao: 'Lista todas as variáveis de ambiente, incluindo tokens e senhas que estejam nelas.',
  },
  {
    regra: 'shell-env-segredo',
    familia: 'ACESSO_SENSIVEL',
    re: /\$\{?(?:AWS_\w+|GH_\w+|GITHUB_\w+|NPM_\w+|\w*(?:TOKEN|SECRET|PASSWORD|API_KEY)\w*)\b/,
    explicacao: 'Lê uma variável de ambiente que costuma guardar uma senha ou um token.',
  },
];

export function analyzeShell(arquivo: string, code: string): Evidence[] {
  const rep = new Reporter(arquivo, code);
  let offset = 0;
  const lines = code.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineOffset = offset;
    offset += line.length + 1;
    if (/^\s*#/.test(line)) {
      continue;
    }
    for (const rule of SHELL_RULES) {
      const m = rule.re.exec(line);
      if (m !== null) {
        rep.add(rule.regra, rule.familia, lineOffset + m.index, rule.explicacao);
      }
    }
    for (const chain of findDownloadChains(line)) {
      rep.add(
        'download-encadeado',
        'DOWNLOAD_ENCADEADO',
        lineOffset + chain.offset,
        'Baixa um programa da internet e o executa na hora, sem que ninguém veja o conteúdo antes.',
        { trecho: chain.text },
      );
    }
    for (const s of findSensitivePaths(line)) {
      rep.add(
        'caminho-sensivel',
        'ACESSO_SENSIVEL',
        lineOffset + s.offset,
        `Menciona ${s.rotulo}, um lugar que um script de projeto não tem motivo para ler.`,
      );
    }
    for (const url of findUrls(line)) {
      if (!url.benigno) {
        rep.add(
          'url-desconhecida',
          'SAIDA_REDE',
          lineOffset + url.offset,
          `Contém o endereço ${url.host}, para onde dados podem ser enviados ou de onde código pode ser baixado.`,
        );
      }
    }
    for (const token of line.split(/[\s'"]+/)) {
      if (token.length > LONG_STRING) {
        const decoded = tryDecode(token);
        const at = lineOffset + line.indexOf(token);
        rep.add(
          'string-longa',
          'OFUSCACAO',
          at,
          `Tem um texto de ${token.length} caracteres sem espaços, formato típico de conteúdo codificado.`,
          decoded !== undefined ? { decodificado: decoded } : {},
        );
        if (decoded !== undefined) {
          scanHiddenText(rep, decoded, at, 'escondido em um texto codificado');
        }
      }
    }
  }
  return rep.evidencias;
}
