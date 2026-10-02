import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  COPY_LIMITS,
  DockerCli,
  SandboxSession,
  buildDockerArgs,
  checkDocker,
  cliFor,
  copyWorkspace,
  imageExists,
  isValidImage,
  pullImage,
  runOnHost,
  validateGrant,
} from '../src/container';

const FAKE_DOCKER: DockerCli = { command: process.execPath, baseArgs: [path.join(__dirname, 'helpers', 'fakeDocker.js')] };

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguard-ws-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

describe('validação', () => {
  it('aceita imagens normais e recusa as que virariam flags', () => {
    expect(isValidImage('node:20-slim')).toBe(true);
    expect(isValidImage('ghcr.io/org/img:1.0@sha256:abc')).toBe(true);
    expect(isValidImage('--privileged')).toBe(false);
    expect(isValidImage('node:20 -v /:/host')).toBe(false);
  });

  it('valida portas', () => {
    expect(validateGrant({ tipo: 'porta', portaHost: 3000, portaContainer: 3000 })).toEqual({});
    expect(validateGrant({ tipo: 'porta', portaHost: 0, portaContainer: 3000 }).erro).toBeDefined();
    expect(validateGrant({ tipo: 'porta', portaHost: 70000, portaContainer: 3000 }).erro).toBeDefined();
  });

  it('recusa o socket do Docker e destinos perigosos', () => {
    const abs = path.resolve('/var/run/docker.sock');
    expect(validateGrant({ tipo: 'pasta', caminhoHost: abs, destino: '/mnt/x', somenteLeitura: true }).erro).toContain(
      'socket do Docker',
    );
    const dir = path.resolve('/dados');
    for (const destino of ['/', '/workspace', '/workspace/', 'relativo', '/a:b']) {
      expect(validateGrant({ tipo: 'pasta', caminhoHost: dir, destino, somenteLeitura: true }).erro).toBeDefined();
    }
    expect(validateGrant({ tipo: 'pasta', caminhoHost: 'relativo', destino: '/mnt/x', somenteLeitura: true }).erro).toBeDefined();
  });

  it('alerta ao montar a pasta pessoal ou pastas de credenciais', () => {
    const home = os.homedir();
    expect(validateGrant({ tipo: 'pasta', caminhoHost: home, destino: '/mnt/h', somenteLeitura: true }).alerta).toContain(
      'pasta pessoal',
    );
    expect(
      validateGrant({ tipo: 'pasta', caminhoHost: path.join(home, '.aws'), destino: '/mnt/a', somenteLeitura: true }).alerta,
    ).toContain('AWS');
    expect(
      validateGrant({ tipo: 'pasta', caminhoHost: path.join(home, 'projetos', 'dados'), destino: '/mnt/d', somenteLeitura: true }),
    ).toEqual({});
  });

  it('valida nomes de variável e alerta para segredos', () => {
    expect(validateGrant({ tipo: 'variavel', nome: 'API_URL', valor: 'x' })).toEqual({});
    expect(validateGrant({ tipo: 'variavel', nome: '1X', valor: 'x' }).erro).toBeDefined();
    expect(validateGrant({ tipo: 'variavel', nome: 'A=B', valor: 'x' }).erro).toBeDefined();
    expect(validateGrant({ tipo: 'variavel', nome: 'GITHUB_TOKEN', valor: 'x' }).alerta).toContain('token');
  });
});

describe('buildDockerArgs', () => {
  const base = { copyDir: '/tmp/copia', image: 'node:20-slim', command: 'npm install', containerName: 'repoguard-x' };

  it('segue a forma da especificação e não desliga a rede', () => {
    const args = buildDockerArgs({ ...base, grants: [] });
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    const v = args.indexOf('-v');
    expect(args[v + 1]).toBe('/tmp/copia:/workspace');
    expect(args[args.indexOf('-w') + 1]).toBe('/workspace');
    expect(args.slice(-4)).toEqual(['node:20-slim', 'sh', '-c', 'npm install']);
    expect(args.join(' ')).not.toMatch(/--network|--privileged|docker\.sock/);
    // Só uma montagem: a cópia.
    expect(args.filter((a) => a === '-v')).toHaveLength(1);
  });

  it('cada liberação vira exatamente uma flag', () => {
    const args = buildDockerArgs({
      ...base,
      grants: [
        { tipo: 'porta', portaHost: 8080, portaContainer: 3000 },
        { tipo: 'pasta', caminhoHost: '/dados', destino: '/mnt/dados', somenteLeitura: true },
        { tipo: 'variavel', nome: 'API_URL', valor: 'segredo-nao-pode-aparecer' },
      ],
      hostUser: '1000:1000',
    });
    expect(args[args.indexOf('-p') + 1]).toBe('127.0.0.1:8080:3000');
    expect(args).toContain('/dados:/mnt/dados:ro');
    expect(args).toContain('API_URL');
    expect(args.join(' ')).not.toContain('segredo-nao-pode-aparecer');
    expect(args[args.indexOf('--user') + 1]).toBe('1000:1000');
  });
});

describe('copyWorkspace', () => {
  it('copia o projeto sem node_modules, .git e links simbólicos', async () => {
    const root = repo({
      'package.json': '{}',
      'src/index.js': 'x',
      'node_modules/pkg/index.js': 'x',
      '.git/config': '[core]',
      'alvo-externo/segredo.txt': 'chave',
    });
    fs.symlinkSync(path.join(root, 'alvo-externo'), path.join(root, 'link'), 'junction');

    const copy = await copyWorkspace(root);
    dirs.push(copy.dir);
    const exists = (rel: string): boolean => fs.existsSync(path.join(copy.dir, rel));
    expect(exists('package.json')).toBe(true);
    expect(exists('src/index.js')).toBe(true);
    expect(exists('node_modules')).toBe(false);
    expect(exists('.git')).toBe(false);
    expect(exists('link')).toBe(false);
    expect(copy.linksIgnorados).toBe(1);
    expect(copy.arquivos).toBe(3);
    // A cópia é independente do original.
    fs.writeFileSync(path.join(copy.dir, 'package.json'), 'alterado');
    expect(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).toBe('{}');
  });

  it('recusa repositórios acima do limite e apaga a cópia parcial', async () => {
    const root = repo({ 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' });
    const original = COPY_LIMITS.maxFiles;
    COPY_LIMITS.maxFiles = 2;
    // Raiz temporária própria: outros arquivos de teste, em paralelo, também
    // criam pastas repoguard-* na pasta temporária do sistema.
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repoguard-raiz-'));
    dirs.push(tempRoot);
    try {
      await expect(copyWorkspace(root, undefined, tempRoot)).rejects.toThrow('grande demais');
    } finally {
      COPY_LIMITS.maxFiles = original;
    }
    expect(fs.readdirSync(tempRoot)).toEqual([]);
  });
});

describe('Docker indisponível: degradação clara', () => {
  it('Docker não instalado', async () => {
    const status = await checkDocker({ command: 'repoguard-docker-que-nao-existe' });
    expect(status.disponivel).toBe(false);
    expect(status.motivo).toContain('não está instalado');
  });

  it('Docker instalado mas parado', async () => {
    process.env.FAKE_DOCKER_DOWN = '1';
    try {
      const status = await checkDocker(FAKE_DOCKER);
      expect(status.disponivel).toBe(false);
      expect(status.motivo).toContain('não está rodando');
    } finally {
      delete process.env.FAKE_DOCKER_DOWN;
    }
  });

  it('sem Docker, nada é executado e nenhuma cópia é criada (nunca cai para o hospedeiro)', async () => {
    const root = repo({ 'package.json': '{}' });
    const session = new SandboxSession(root, 'node:20-slim', { command: 'repoguard-docker-que-nao-existe' });
    const result = await session.run('npm install');
    expect(result).toMatchObject({ executado: false, codigoSaida: null, semRuntime: true });
    expect(result.motivo).toContain('Docker');
    expect(session.copia).toBeUndefined();
  });

  it('imagem inválida não executa', async () => {
    const session = new SandboxSession(repo({}), '--privileged', FAKE_DOCKER);
    const result = await session.run('id');
    expect(result.executado).toBe(false);
    expect(result.motivo).toContain('Imagem');
  });
});

describe('SandboxSession com Docker falso', () => {
  it('executa na cópia, passa o valor da variável pelo ambiente e reaproveita a cópia', async () => {
    const root = repo({ 'package.json': '{}' });
    const session = new SandboxSession(root, 'node:20-slim', FAKE_DOCKER);
    session.addGrant({ tipo: 'variavel', nome: 'API_URL', valor: 'https://api.exemplo' });
    session.addGrant({ tipo: 'porta', portaHost: 3000, portaContainer: 3000 });

    let output = '';
    const r1 = await session.run('npm install', { onOutput: (c) => (output += c) });
    expect(r1).toMatchObject({ executado: true, codigoSaida: 0, cancelado: false });

    const echoed = JSON.parse(output.split('\n').find((l) => l.startsWith('{')) as string) as {
      args: string[];
      apiUrl: string | null;
    };
    const copyDir = session.copia?.dir as string;
    expect(echoed.args).toContain(`${copyDir}:/workspace`);
    expect(echoed.args).toContain('127.0.0.1:3000:3000');
    expect(echoed.apiUrl).toBe('https://api.exemplo');
    expect(copyDir).not.toBe(root);

    await session.run('npm test');
    expect(session.copia?.dir).toBe(copyDir);

    await session.dispose();
    expect(fs.existsSync(copyDir)).toBe(false);
  });

  it('repassa o código de saída', async () => {
    process.env.FAKE_DOCKER_EXIT = '3';
    try {
      const session = new SandboxSession(repo({}), 'node:20-slim', FAKE_DOCKER);
      expect((await session.run('false')).codigoSaida).toBe(3);
      await session.dispose();
    } finally {
      delete process.env.FAKE_DOCKER_EXIT;
    }
  });

  it('recusa liberação inválida mesmo se a interface falhar em validar', () => {
    const session = new SandboxSession(repo({}), 'node:20-slim', FAKE_DOCKER);
    expect(() =>
      session.addGrant({ tipo: 'pasta', caminhoHost: path.resolve('/var/run/docker.sock'), destino: '/s', somenteLeitura: false }),
    ).toThrow('socket do Docker');
    expect(session.concessoes).toHaveLength(0);
  });
});

it('runOnHost executa no diretório indicado', async () => {
  const root = repo({ 'marca.txt': 'aqui' });
  let output = '';
  const result = await runOnHost(`node -e "process.stdout.write(require('fs').readFileSync('marca.txt','utf8'))"`, root, {
    onOutput: (c) => (output += c),
  });
  expect(result.codigoSaida).toBe(0);
  expect(output).toBe('aqui');
});

describe('Podman', () => {
  const FAKE_PODMAN = { ...FAKE_DOCKER, runtime: 'podman' as const };

  it('cliFor monta o comando do programa escolhido', () => {
    expect(cliFor('podman')).toEqual({ command: 'podman', runtime: 'podman' });
    expect(cliFor('docker')).toEqual({ command: 'docker', runtime: 'docker' });
  });

  it('verifica o Podman com "podman info" e usa o nome certo nas mensagens', async () => {
    expect(await checkDocker(FAKE_PODMAN)).toEqual({ disponivel: true, versao: '5.2.0' });
    const missing = await checkDocker({ command: 'repoguard-podman-que-nao-existe', runtime: 'podman' });
    expect(missing.motivo).toContain('O Podman não está instalado');
    expect(missing.motivo).toContain('Podman Desktop');
  });

  it('no Linux usa --userns=keep-id em vez de --user', () => {
    const base = { copyDir: '/tmp/c', image: 'node:20-slim', command: 'id', grants: [], containerName: 'n', hostUser: '1000:1000' };
    const podman = buildDockerArgs({ ...base, runtime: 'podman' });
    expect(podman).toContain('--userns=keep-id');
    expect(podman).not.toContain('--user');
    expect(buildDockerArgs({ ...base, runtime: 'docker' })).toContain('--user');
  });

  it('a sessão executa com o Podman', async () => {
    const session = new SandboxSession(repo({}), 'node:20-slim', FAKE_PODMAN);
    expect((await session.run('id')).executado).toBe(true);
    await session.dispose();
  });
});

describe('verificar ambiente: imagem', () => {
  it('detecta imagem ausente e presente', async () => {
    expect(await imageExists(FAKE_DOCKER, 'node:20-slim')).toBe(false);
    process.env.FAKE_IMAGE_PRESENT = '1';
    try {
      expect(await imageExists(FAKE_DOCKER, 'node:20-slim')).toBe(true);
    } finally {
      delete process.env.FAKE_IMAGE_PRESENT;
    }
  });

  it('baixa a imagem e mostra o progresso', async () => {
    let output = '';
    const result = await pullImage(FAKE_DOCKER, 'node:20-slim', { onOutput: (c) => (output += c) });
    expect(result).toMatchObject({ executado: true, codigoSaida: 0 });
    expect(output).toContain('Downloaded newer image for node:20-slim');
  });

  it('não baixa nem consulta imagem com nome inválido', async () => {
    expect(await imageExists(FAKE_DOCKER, '--privileged')).toBe(false);
    expect((await pullImage(FAKE_DOCKER, '--privileged')).executado).toBe(false);
  });
});

// Integração real: só roda com REPOGUARD_DOCKER_IT=1 e Docker ativo (baixa node:20-slim).
(process.env.REPOGUARD_DOCKER_IT === '1' ? it : it.skip)(
  'integração: o container não enxerga a pasta pessoal do hospedeiro',
  async () => {
    const root = repo({ 'package.json': '{}' });
    const session = new SandboxSession(root);
    let output = '';
    const result = await session.run('ls -a /workspace; ls ~/.ssh 2>&1 || true; env', {
      onOutput: (c) => (output += c),
    });
    expect(result.codigoSaida).toBe(0);
    expect(output).toContain('package.json');
    expect(output).not.toContain(os.userInfo().username + '/.ssh');
    await session.dispose();
  },
  120_000,
);
