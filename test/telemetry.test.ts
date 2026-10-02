import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_LOG_FILE, EventLog, checkWritable, redactSecrets, resolveLogPath, sanitizeDetails, shouldRecord } from '../src/telemetry';
import { TelemetryRecord } from '../src/types';

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguard-log-'));
  dirs.push(d);
  return d;
}

function readLines(file: string): TelemetryRecord[] {
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as TelemetryRecord);
}

const ctx = { participanteId: 'P07', grupo: 'experimental', desafioId: 'desafio-2' };

describe('EventLog', () => {
  it('grava uma linha JSON por evento, na ordem, com os campos da especificação', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'sub', 'eventos.jsonl');
    const fixed = new Date('2026-10-02T12:00:00.000Z');
    const log = new EventLog(() => file, () => ctx, undefined, () => fixed);

    log.record('workspace_aberto', { confiavel: false });
    log.record('analise_concluida', { pontuacao: 157.5, evidencias: 6 });
    log.record('painel_cancelado', { via: 'botao', tempoAbertoMs: 4200 });
    await log.flush();

    const lines = readLines(file);
    expect(lines.map((l) => l.evento)).toEqual(['workspace_aberto', 'analise_concluida', 'painel_cancelado']);
    expect(Object.keys(lines[0]).sort()).toEqual(
      ['detalhes', 'desafioId', 'evento', 'grupo', 'participanteId', 'timestamp'].sort(),
    );
    expect(lines[1]).toMatchObject({
      participanteId: 'P07',
      grupo: 'experimental',
      desafioId: 'desafio-2',
      timestamp: '2026-10-02T12:00:00.000Z',
      detalhes: { pontuacao: 157.5, evidencias: 6, seq: 2, sessaoId: log.sessaoId },
    });
  });

  it('acrescenta ao arquivo existente sem apagar sessões anteriores', async () => {
    const file = path.join(tempDir(), 'e.jsonl');
    const a = new EventLog(() => file, () => ctx);
    a.record('workspace_aberto');
    await a.flush();
    const b = new EventLog(() => file, () => ({ ...ctx, grupo: 'controle' }));
    b.record('workspace_aberto');
    await b.flush();
    const lines = readLines(file);
    expect(lines).toHaveLength(2);
    expect(lines[0].detalhes.sessaoId).not.toBe(lines[1].detalhes.sessaoId);
    expect(lines[1].grupo).toBe('controle');
  });

  it('falha de escrita não lança e avisa uma única vez', async () => {
    const dir = tempDir();
    const blocker = path.join(dir, 'arquivo');
    fs.writeFileSync(blocker, '');
    const errors: string[] = [];
    // O "diretório" do registro é um arquivo: mkdir falha.
    const log = new EventLog(() => path.join(blocker, 'x.jsonl'), () => ctx, (m) => errors.push(m));
    expect(() => {
      log.record('workspace_aberto');
      log.record('analise_concluida');
    }).not.toThrow();
    await log.flush();
    expect(errors).toHaveLength(1);
  });
});

describe('privacidade', () => {
  it('mascara segredos em comandos digitados', () => {
    const cmd =
      'API_KEY=abc123 GITHUB_TOKEN="ghp_x" npm start -- --auth "Bearer eyJhbGciOiJIUzI1NiJ9" ' +
      'https://user:senha@registry.exemplo AKIAABCDEFGHIJKLMNOP ghp_' + 'a'.repeat(36);
    const out = redactSecrets(cmd);
    expect(out).toContain('API_KEY=<omitido>');
    expect(out).toContain('GITHUB_TOKEN=<omitido>');
    expect(out).toContain('Bearer <omitido>');
    expect(out).toContain('https://<omitido>@registry.exemplo');
    expect(out).not.toMatch(/abc123|senha|AKIAABCDEFGHIJKLMNOP|eyJhbGci|ghp_a/);
    expect(out).toContain('npm start');
  });

  it('não altera comandos comuns', () => {
    expect(redactSecrets('npm install && npm run build -- --port=3000')).toBe('npm install && npm run build -- --port=3000');
  });

  it('limita tamanho e profundidade dos detalhes e descarta undefined', () => {
    const out = sanitizeDetails({
      longo: 'x'.repeat(2000),
      fundo: { a: { b: { c: { d: 1 } } } },
      vazio: undefined,
      lista: Array.from({ length: 100 }, (_, i) => i),
    }) as Record<string, unknown>;
    expect((out.longo as string).length).toBe(500);
    expect(JSON.stringify(out.fundo)).toContain('[…]');
    expect('vazio' in out).toBe(false);
    expect(out.lista).toHaveLength(50);
  });
});

describe('shouldRecord (quando gravar)', () => {
  const base = { participanteId: 'P07', desafioId: '', pastasAbertas: ['desafio-2'] };

  it('sem participante, nada é gravado', () => {
    expect(shouldRecord({ ...base, participanteId: '' })).toBe(false);
    expect(shouldRecord({ ...base, participanteId: '   ' }, 'desafio-2')).toBe(false);
  });

  it('sem desafioId, grava tudo (escopo não restringido pelo pesquisador)', () => {
    expect(shouldRecord(base)).toBe(true);
    expect(shouldRecord(base, 'outro-projeto')).toBe(true);
  });

  it('com desafioId, eventos de pasta só valem para a pasta do desafio', () => {
    const scope = { ...base, desafioId: 'desafio-2' };
    expect(shouldRecord(scope, 'desafio-2')).toBe(true);
    expect(shouldRecord(scope, 'DESAFIO-2')).toBe(true);
    expect(shouldRecord(scope, 'repoguard-nudge')).toBe(false);
  });

  it('com desafioId, eventos da janela só valem se a pasta do desafio está aberta nela', () => {
    expect(shouldRecord({ ...base, desafioId: 'desafio-2' })).toBe(true);
    expect(shouldRecord({ ...base, desafioId: 'desafio-2', pastasAbertas: ['repoguard-nudge'] })).toBe(false);
    expect(shouldRecord({ ...base, desafioId: 'desafio-2', pastasAbertas: [] })).toBe(false);
  });
});

describe('checkWritable', () => {
  it('confirma pasta gravável e informa o erro quando não é', async () => {
    const dir = tempDir();
    expect(await checkWritable(path.join(dir, 'novo', 'e.jsonl'))).toBeUndefined();
    const blocker = path.join(dir, 'arquivo');
    fs.writeFileSync(blocker, '');
    expect(await checkWritable(path.join(blocker, 'e.jsonl'))).toBeDefined();
  });
});

describe('resolveLogPath', () => {
  const def = path.join(os.tmpdir(), 'padrao');

  it('usa o padrão quando vazio', () => {
    expect(resolveLogPath('', def)).toEqual({ arquivo: path.join(def, DEFAULT_LOG_FILE) });
  });

  it('recusa caminho relativo com aviso', () => {
    const r = resolveLogPath('logs/eventos.jsonl', def);
    expect(r.arquivo).toBe(path.join(def, DEFAULT_LOG_FILE));
    expect(r.aviso).toContain('absoluto');
  });

  it('aceita arquivo absoluto e pasta existente', () => {
    const dir = tempDir();
    expect(resolveLogPath(path.join(dir, 'p07.jsonl'), def).arquivo).toBe(path.join(dir, 'p07.jsonl'));
    expect(resolveLogPath(dir, def).arquivo).toBe(path.join(dir, DEFAULT_LOG_FILE));
  });
});
