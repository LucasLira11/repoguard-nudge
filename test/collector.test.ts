import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MAX_FILES,
  MAX_FILE_BYTES,
  collectArtifacts,
  relativeImports,
  resolveWorkspacePath,
  scriptReferencesInCommand,
} from '../src/collector';
import { createFsReader } from './helpers/fsReader';

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguard-collector-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const created: string[] = [];
afterAll(() => {
  for (const dir of created) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function repo(files: Record<string, string>): string {
  const root = makeRepo(files);
  created.push(root);
  return root;
}

describe('resolveWorkspacePath', () => {
  it('normaliza caminhos relativos', () => {
    expect(resolveWorkspacePath('./scripts/a.js', '')).toBe('scripts/a.js');
    expect(resolveWorkspacePath('../b.js', 'scripts')).toBe('b.js');
    expect(resolveWorkspacePath('${workspaceFolder}/x.js', 'qualquer')).toBe('x.js');
    expect(resolveWorkspacePath('scripts\\win.js', '')).toBe('scripts/win.js');
  });

  it('recusa caminhos fora do workspace', () => {
    expect(resolveWorkspacePath('../fora.js', '')).toBeNull();
    expect(resolveWorkspacePath('/etc/passwd', '')).toBeNull();
    expect(resolveWorkspacePath('~/.ssh/id_rsa', '')).toBeNull();
    expect(resolveWorkspacePath('C:/Users/x/a.js', '')).toBeNull();
    expect(resolveWorkspacePath('$HOME/a.js', '')).toBeNull();
  });
});

describe('scriptReferencesInCommand', () => {
  it('encontra scripts por extensão e após interpretadores', () => {
    const refs = scriptReferencesInCommand(
      'node scripts/setup && bash ./install.sh; tsc -p . && node --require=./hook.js "dist/main.mjs"',
    );
    expect(refs).toEqual([
      { raw: 'scripts/setup', kind: 'script' },
      { raw: './install.sh', kind: 'shell-script' },
      { raw: './hook.js', kind: 'script' },
      { raw: 'dist/main.mjs', kind: 'script' },
    ]);
  });

  it('não confunde a extensão enganosa: node payload.dat é JavaScript', () => {
    expect(scriptReferencesInCommand('node payload.dat')).toEqual([{ raw: 'payload.dat', kind: 'script' }]);
  });

  it('ignora URLs', () => {
    expect(scriptReferencesInCommand('curl https://x.test/a.sh')).toEqual([]);
  });
});

describe('relativeImports', () => {
  it('encontra require, import dinâmico e import estático relativos', () => {
    const src = `
      const a = require('./a');
      import b from "../b.js";
      import './c';
      export { d } from './d';
      const e = await import(\`./e.mjs\`);
      const fs = require('fs');
    `;
    expect(relativeImports(src).sort()).toEqual(['../b.js', './a', './c', './d', './e.mjs']);
  });
});

describe('collectArtifacts', () => {
  it('coleta manifestos, scripts referenciados e imports transitivos', async () => {
    const root = repo({
      'package.json': JSON.stringify({
        scripts: { postinstall: 'node scripts/setup.js', start: 'node server' },
      }),
      'scripts/setup.js': "require('./lib/helper');",
      'scripts/lib/helper.js': "module.exports = require('../../util/deep');",
      'util/deep.js': '// fim da cadeia',
      'server.js': 'console.log(1);',
      '.vscode/tasks.json': `{
        // comentário: JSONC válido
        "version": "2.0.0",
        "tasks": [{ "label": "x", "command": "node", "args": ["\${workspaceFolder}/.vscode/boot.js"], }],
      }`,
      '.vscode/boot.js': 'void 0;',
      'setup.py': 'print(1)',
    });

    const result = await collectArtifacts(createFsReader(root));
    const paths = result.artifacts.map((a) => a.path).sort();
    expect(paths).toEqual(
      [
        '.vscode/boot.js',
        '.vscode/tasks.json',
        'package.json',
        'scripts/lib/helper.js',
        'scripts/setup.js',
        'server.js',
        'setup.py',
        'util/deep.js',
      ].sort(),
    );
    expect(result.artifacts.find((a) => a.path === 'package.json')?.kind).toBe('package-json');
    expect(result.artifacts.find((a) => a.path === 'setup.py')?.kind).toBe('setup-py');
    expect(result.truncated).toBe(false);
    expect(result.aborted).toBe(false);
  });

  it('ignora node_modules, caminhos externos e arquivos grandes', async () => {
    const root = repo({
      'package.json': JSON.stringify({
        scripts: {
          a: 'node node_modules/pkg/index.js',
          b: 'node ../fora.js',
          c: 'node grande.js',
        },
      }),
      'node_modules/pkg/index.js': '',
      'grande.js': 'x'.repeat(MAX_FILE_BYTES + 1),
    });

    const result = await collectArtifacts(createFsReader(root));
    expect(result.artifacts.map((a) => a.path)).toEqual(['package.json']);
    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { path: 'node_modules/pkg/index.js', reason: 'ignorado' },
        { path: '../fora.js', reason: 'fora-do-workspace' },
        { path: 'grande.js', reason: 'tamanho' },
      ]),
    );
  });

  it(`para em ${MAX_FILES} arquivos`, async () => {
    const files: Record<string, string> = {};
    const scripts: Record<string, string> = {};
    for (let i = 0; i < MAX_FILES + 20; i++) {
      files[`s/a${i}.js`] = '';
      scripts[`s${i}`] = `node s/a${i}.js`;
    }
    files['package.json'] = JSON.stringify({ scripts });
    const root = repo(files);

    const result = await collectArtifacts(createFsReader(root));
    expect(result.artifacts).toHaveLength(MAX_FILES);
    expect(result.truncated).toBe(true);
  });

  it('não segue pasta que é link (junction no Windows)', async () => {
    const root = repo({
      'package.json': JSON.stringify({ scripts: { postinstall: 'node dir/x.js' } }),
      'alvo/x.js': 'segredo',
    });
    // Junctions não exigem privilégio no Windows; em outros SOs vira symlink comum.
    fs.symlinkSync(path.join(root, 'alvo'), path.join(root, 'dir'), 'junction');

    const result = await collectArtifacts(createFsReader(root));
    expect(result.artifacts.map((a) => a.path)).toEqual(['package.json']);
    expect(result.skipped).toContainEqual({ path: 'dir/x.js', reason: 'link-simbolico' });
  });

  const canSymlinkFiles = ((): boolean => {
    const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguard-probe-'));
    try {
      fs.writeFileSync(path.join(probe, 'a'), '');
      fs.symlinkSync(path.join(probe, 'a'), path.join(probe, 'b'));
      return true;
    } catch {
      return false; // Windows sem Modo Desenvolvedor/privilégio de link.
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  })();

  (canSymlinkFiles ? it : it.skip)('não segue arquivo que é link simbólico', async () => {
    const root = repo({
      'package.json': JSON.stringify({ scripts: { postinstall: 'node link.js' } }),
      'alvo.js': 'segredo',
    });
    fs.symlinkSync(path.join(root, 'alvo.js'), path.join(root, 'link.js'));

    const result = await collectArtifacts(createFsReader(root));
    expect(result.artifacts.map((a) => a.path)).toEqual(['package.json']);
    expect(result.skipped).toContainEqual({ path: 'link.js', reason: 'link-simbolico' });
  });

  it('respeita o prazo: sinal abortado não coleta nada', async () => {
    const root = repo({ 'package.json': '{}' });
    const controller = new AbortController();
    controller.abort();
    const result = await collectArtifacts(createFsReader(root), controller.signal);
    expect(result.artifacts).toHaveLength(0);
    expect(result.aborted).toBe(true);
  });
});
