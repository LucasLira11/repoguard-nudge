import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';

/**
 * Invariantes de segurança do próprio código da extensão.
 */
const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src');

function listFiles(dir: string, pattern: RegExp): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === 'out' ? [] : listFiles(full, pattern);
    }
    return pattern.test(entry.name) ? [full] : [];
  });
}

const PROCESS_MODULES = new Set(['child_process', 'worker_threads', 'cluster']);

function importedModules(code: string): string[] {
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript'] });
  const found: string[] = [];
  traverse(ast, {
    ImportDeclaration(p) {
      found.push(p.node.source.value);
    },
    CallExpression(p) {
      const c = p.node.callee;
      const arg = p.node.arguments[0];
      if ((t.isIdentifier(c, { name: 'require' }) || t.isImport(c)) && t.isStringLiteral(arg)) {
        found.push(arg.value);
      }
    },
  });
  return found.map((m) => m.replace(/^node:/, ''));
}

it('só container.ts importa APIs capazes de iniciar processos', () => {
  // Coletor, analisadores, motor, painel e registro rodam antes de qualquer
  // decisão do usuário; não podem ter meios de executar nada.
  const offenders = listFiles(SRC, /\.ts$/)
    .filter((file) => path.relative(SRC, file).replace(/\\/g, '/') !== 'container.ts')
    .filter((file) => importedModules(fs.readFileSync(file, 'utf8')).some((m) => PROCESS_MODULES.has(m)))
    .map((file) => path.relative(ROOT, file));
  expect(offenders).toEqual([]);
});

it('o código-fonte não contém caracteres invisíveis ou bidirecionais literais', () => {
  // Uma ferramenta que denuncia Trojan Source não pode carregar esses
  // caracteres no próprio código; nos padrões de detecção, use escapes \uXXXX.
  const ranges: Array<[number, number]> = [
    [0x00, 0x08],
    [0x0b, 0x0c],
    [0x0e, 0x1f],
    [0x7f, 0x7f],
    [0x200b, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
    [0xfeff, 0xfeff],
  ];
  const isInvisible = (code: number): boolean => ranges.some(([lo, hi]) => code >= lo && code <= hi);

  const offenders: string[] = [];
  for (const file of listFiles(ROOT, /\.(?:ts|js|json)$/)) {
    const text = fs.readFileSync(file, 'utf8');
    for (let i = 0; i < text.length; i++) {
      if (isInvisible(text.charCodeAt(i))) {
        offenders.push(`${path.relative(ROOT, file)} @${i} U+${text.charCodeAt(i).toString(16)}`);
        break;
      }
    }
  }
  expect(offenders).toEqual([]);
});
