import * as fs from 'fs';
import * as path from 'path';
import { findUrls } from '../src/analyzers/common';
import { runAnalysis } from '../src/analysis';
import { DEFAULT_WEIGHTS, shouldAlert } from '../src/engine';
import { AnalysisResult } from '../src/types';
import { createFsReader } from './helpers/fsReader';

const FIXTURES = path.join(__dirname, 'fixtures');

async function analyze(name: string): Promise<AnalysisResult> {
  return (await runAnalysis(createFsReader(path.join(FIXTURES, name)), DEFAULT_WEIGHTS)).resultado;
}

describe('repositórios de teste: resultado esperado', () => {
  it('benigno-simples: 0, BAIXO, silêncio', async () => {
    const r = await analyze('benigno-simples');
    expect(r.pontuacao).toBe(0);
    expect(r.evidencias).toEqual([]);
    expect(shouldAlert(r)).toBe(false);
  });

  it('benigno-com-build: 45 (execução automática + comandos do sistema), BAIXO, silêncio', async () => {
    const r = await analyze('benigno-com-build');
    expect(r.detalhamento.familias).toEqual(['EXEC_AUTOMATICA', 'EXEC_SISTEMA']);
    expect(r.pontuacao).toBe(45);
    expect(r.nivel).toBe('BAIXO');
    expect(shouldAlert(r)).toBe(false);
  });

  it('adversarial-tasks-json: 127,5, ALTO, tarefa folderOpen fora da contenção', async () => {
    const r = await analyze('adversarial-tasks-json');
    expect(r.pontuacao).toBe(127.5);
    expect(r.nivel).toBe('ALTO');
    expect(r.detalhamento.arquivoCorrelacao).toBe('.vscode/preparar.js');
    expect(r.evidencias[0]).toMatchObject({ arquivo: '.vscode/tasks.json', foraDaContencao: true });
  });

  it('adversarial-postinstall: 200, ALTO pela tríade, destino decodificado visível', async () => {
    const r = await analyze('adversarial-postinstall');
    expect(r.pontuacao).toBe(200);
    expect(r.nivel).toBe('ALTO');
    expect(r.detalhamento.arquivoCorrelacao).toBe('scripts/setup.js');
    expect(r.evidencias.some((e) => e.decodificado === 'https://coleta.exemplo.invalid/chave')).toBe(true);
  });
});

describe('repositórios de teste: os canários são inofensivos', () => {
  const adversarial = ['adversarial-tasks-json', 'adversarial-postinstall'];

  function listFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      return e.isDirectory() ? listFiles(full) : [full];
    });
  }

  it.each(adversarial)('%s: toda URL, inclusive a escondida em Base64, aponta para .invalid', async (name) => {
    const r = await analyze(name);
    const texts = [
      ...listFiles(path.join(FIXTURES, name)).filter((f) => /\.(?:js|json)$/.test(f)).map((f) => fs.readFileSync(f, 'utf8')),
      ...r.evidencias.map((e) => e.decodificado ?? ''),
    ];
    const hosts = texts.flatMap((t) => findUrls(t).map((u) => u.host));
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      expect(host.endsWith('.invalid')).toBe(true);
    }
  });

  it.each(adversarial)('%s: nenhum script acessa a pasta pessoal do usuário', (name) => {
    for (const file of listFiles(path.join(FIXTURES, name)).filter((f) => f.endsWith('.js'))) {
      const code = fs.readFileSync(file, 'utf8');
      expect(code).not.toMatch(/homedir\s*\(|USERPROFILE|process\.env\.HOME\b|['"`]~[\\/]/);
    }
  });
});
