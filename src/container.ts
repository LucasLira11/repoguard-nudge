import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findSensitivePaths } from './analyzers/common';
import { ReleaseRequest } from './types';

/**
 * Contenção: o código do repositório roda num container efêmero que enxerga
 * apenas uma CÓPIA do workspace. Este é o ÚNICO módulo da extensão que inicia
 * processos (um teste em test/invariants.test.ts garante isso).
 *
 * Sobre a rede: ela NÃO é desligada. `npm install` precisa baixar pacotes, e
 * um sandbox que quebra o fluxo normal seria abandonado pelo usuário (que
 * voltaria a rodar tudo no hospedeiro). A proteção vem da AUSÊNCIA DE
 * SEGREDOS dentro do container: sem ~/.ssh, ~/.aws, .npmrc, variáveis de
 * ambiente do usuário ou pastas pessoais, um ladrão de credenciais não tem o
 * que roubar, mesmo podendo falar com a internet.
 *
 * Risco residual conhecido: com rede, o container ainda alcança serviços na
 * rede local e, em VMs de nuvem, o endpoint de metadados (169.254.169.254).
 * Isso fica documentado no README como limitação.
 */

export const DEFAULT_IMAGE = 'node:20-slim';
export const CONTAINER_WORKDIR = '/workspace';

const EXCLUDED_DIRS = new Set(['node_modules', '.git']);
export const COPY_LIMITS = { maxFiles: 50_000, maxBytes: 500 * 1024 * 1024 };

/** Liberações que se aplicam ao container (a de hospedeiro não é uma flag: é sair dele). */
export type ContainerGrant = Exclude<ReleaseRequest, { tipo: 'hospedeiro' }>;

/**
 * Docker ou Podman. O Podman aceita os mesmos comandos e flags usados aqui e
 * é gratuito e sem daemon com privilégio de root, útil quando a licença do
 * Docker Desktop é um problema na instituição.
 */
export type ContainerRuntime = 'docker' | 'podman';

export interface DockerCli {
  command: string;
  /** Argumentos inseridos antes de todos os outros (usado nos testes com um docker falso). */
  baseArgs?: string[];
  runtime?: ContainerRuntime;
}

export const DEFAULT_DOCKER: DockerCli = { command: 'docker', runtime: 'docker' };

export function cliFor(runtime: ContainerRuntime): DockerCli {
  return { command: runtime, runtime };
}

const RUNTIME_TEXT: Record<ContainerRuntime, { nome: string; app: string; iniciar: string }> = {
  docker: { nome: 'Docker', app: 'Docker Desktop', iniciar: 'Abra o Docker Desktop' },
  podman: { nome: 'Podman', app: 'Podman Desktop', iniciar: 'Abra o Podman Desktop (ou rode "podman machine start")' },
};

export function runtimeName(docker: DockerCli): string {
  return RUNTIME_TEXT[docker.runtime ?? 'docker'].nome;
}

// --------------------------------------------------------------- validação

export interface Validation {
  /** Pedido recusado: não pode ser concedido de forma alguma. */
  erro?: string;
  /** Pedido possível, mas que merece destaque no alerta de liberação. */
  alerta?: string;
}

/**
 * Valida a imagem configurada. A configuração já é restrita ao usuário, mas
 * o valor vira argumento do docker: "--privileged" como nome de imagem seria
 * interpretado como flag.
 */
export function isValidImage(image: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/.test(image);
}

const SECRET_NAME = /TOKEN|SECRET|PASSW|API_?KEY|PRIVATE|CREDENTIAL|^AWS_|^GH_|^GITHUB_|^NPM_|^AZURE_/i;

function isPort(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function validateGrant(grant: ContainerGrant): Validation {
  switch (grant.tipo) {
    case 'porta':
      if (!isPort(grant.portaHost) || !isPort(grant.portaContainer)) {
        return { erro: 'As portas devem ser números entre 1 e 65535.' };
      }
      return {};

    case 'pasta': {
      if (!path.isAbsolute(grant.caminhoHost)) {
        return { erro: 'Informe o caminho completo da pasta na sua máquina.' };
      }
      // O socket do Docker dá controle total do hospedeiro. Montá-lo é sair
      // do container por outra porta; quem quiser isso usa a liberação
      // "hospedeiro", que é explícita sobre o risco.
      if (/docker\.sock$|docker_engine/i.test(grant.caminhoHost)) {
        return { erro: 'O socket do Docker não pode ser montado: ele daria ao repositório controle total da sua máquina.' };
      }
      if (
        !/^\/[^:,]*$/.test(grant.destino) ||
        grant.destino === '/' ||
        grant.destino.replace(/\/+$/, '') === CONTAINER_WORKDIR
      ) {
        return { erro: 'O destino deve ser um caminho absoluto no container, diferente de / e de /workspace, sem ":" ou ",".' };
      }
      const alerta = sensitiveHostPathWarning(grant.caminhoHost);
      return alerta !== undefined ? { alerta } : {};
    }

    case 'variavel':
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(grant.nome)) {
        return { erro: 'Nome de variável inválido: use letras, números e _ (sem começar com número).' };
      }
      return SECRET_NAME.test(grant.nome)
        ? { alerta: `${grant.nome} parece guardar uma senha ou um token: é exatamente o que um repositório malicioso procura.` }
        : {};
  }
}

/** Pastas cuja montagem desfaz a premissa "não há segredos no container". */
export function sensitiveHostPathWarning(hostPath: string): string | undefined {
  const normalized = path.resolve(hostPath);
  const home = path.resolve(os.homedir());
  const root = path.parse(normalized).root;
  if (normalized === root) {
    return 'Esta é a raiz do disco: o repositório teria acesso a todos os seus arquivos.';
  }
  if (normalized.toLowerCase() === home.toLowerCase()) {
    return 'Esta é a sua pasta pessoal: nela ficam chaves SSH, credenciais de nuvem e tokens.';
  }
  const sensitive = findSensitivePaths(normalized.replace(/\\/g, '/'))[0];
  if (sensitive !== undefined) {
    return `Esta pasta contém ${sensitive.rotulo}.`;
  }
  return undefined;
}

// -------------------------------------------------------------------- cópia

export interface CopyStats {
  dir: string;
  arquivos: number;
  bytes: number;
  /** Links simbólicos e junctions encontrados e NÃO copiados. */
  linksIgnorados: number;
}

/**
 * Copia o workspace para um diretório temporário privado.
 *
 * - node_modules e .git ficam de fora (pedido da especificação; .git também
 *   pode conter hooks e credenciais em .git/config).
 * - Links simbólicos NÃO são copiados nem seguidos. Copiar o alvo de
 *   `chave -> ~/.ssh/id_rsa` colocaria o segredo dentro do container, que é
 *   justamente o que a contenção existe para impedir.
 * - A cópia é de mão única: nada do que o código fizer no container volta
 *   sozinho para o workspace real (um postinstall poderia, por exemplo,
 *   escrever um .vscode/tasks.json malicioso).
 */
export async function copyWorkspace(sourceDir: string, signal?: AbortSignal): Promise<CopyStats> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'repoguard-'));
  if (process.platform !== 'win32') {
    await fs.promises.chmod(dir, 0o700);
  }
  const stats: CopyStats = { dir, arquivos: 0, bytes: 0, linksIgnorados: 0 };

  const walk = async (from: string, to: string): Promise<void> => {
    const entries = await fs.promises.readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      if (signal?.aborted === true) {
        throw new Error('Cópia cancelada.');
      }
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isSymbolicLink()) {
        stats.linksIgnorados++;
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        // lstat confirma: em alguns sistemas uma junction aparece como diretório no Dirent.
        if ((await fs.promises.lstat(src)).isSymbolicLink()) {
          stats.linksIgnorados++;
          continue;
        }
        await fs.promises.mkdir(dst);
        await walk(src, dst);
      } else if (entry.isFile()) {
        const { size } = await fs.promises.lstat(src);
        stats.arquivos++;
        stats.bytes += size;
        if (stats.arquivos > COPY_LIMITS.maxFiles || stats.bytes > COPY_LIMITS.maxBytes) {
          throw new Error(
            `O repositório é grande demais para a cópia de contenção (limite: ${COPY_LIMITS.maxFiles} arquivos ou ${COPY_LIMITS.maxBytes / 1024 / 1024} MB).`,
          );
        }
        await fs.promises.copyFile(src, dst);
      }
      // FIFOs, sockets e dispositivos são ignorados.
    }
  };

  try {
    await walk(sourceDir, dir);
    return stats;
  } catch (error) {
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

// ------------------------------------------------------------------- docker

export interface DockerStatus {
  disponivel: boolean;
  versao?: string;
  /** Mensagem para o usuário quando indisponível. */
  motivo?: string;
}

export async function checkDocker(docker: DockerCli = DEFAULT_DOCKER, timeoutMs = 5000): Promise<DockerStatus> {
  const runtime = docker.runtime ?? 'docker';
  const text = RUNTIME_TEXT[runtime];
  // `docker version` só preenche Server quando o daemon responde. No Podman,
  // `podman info` só funciona com a máquina virtual (Windows/macOS) ligada.
  const probe = runtime === 'podman' ? ['info', '--format', '{{.Version.Version}}'] : ['version', '--format', '{{.Server.Version}}'];
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    const finish = (status: DockerStatus): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(status);
      }
    };
    const child = spawn(docker.command, [...(docker.baseArgs ?? []), ...probe], {
      env: process.env,
      shell: false,
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill();
      finish({ disponivel: false, motivo: `O ${text.nome} não respondeu a tempo. Verifique se o ${text.app} está aberto.` });
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', (error: NodeJS.ErrnoException) =>
      finish({
        disponivel: false,
        motivo:
          error.code === 'ENOENT'
            ? `O ${text.nome} não está instalado (ou não está no PATH). Instale o ${text.app} para usar a contenção.`
            : `Não foi possível falar com o ${text.nome}: ${error.message}`,
      }),
    );
    child.on('close', (code) =>
      finish(
        code === 0 && out.trim() !== ''
          ? { disponivel: true, versao: out.trim() }
          : { disponivel: false, motivo: `O ${text.nome} está instalado, mas não está rodando. ${text.iniciar} e tente de novo.` },
      ),
    );
  });
}

export interface DockerRunSpec {
  copyDir: string;
  image: string;
  command: string;
  grants: readonly ContainerGrant[];
  containerName: string;
  /** "uid:gid" no Linux, para que os arquivos criados na cópia sejam do usuário. */
  hostUser?: string;
  runtime?: ContainerRuntime;
}

/**
 * Monta os argumentos de `docker run`. A forma básica é a da especificação:
 *   docker run --rm -v <copia>:/workspace -w /workspace <imagem> <comando>
 * acrescida de endurecimentos que não quebram `npm install`.
 */
export function buildDockerArgs(spec: DockerRunSpec): string[] {
  const args = [
    'run',
    '--rm',
    '--init',
    '--name',
    spec.containerName,
    '--label',
    'repoguard=1',
    // Impede escalar privilégios via binários setuid dentro do container.
    '--security-opt=no-new-privileges',
    // Sem sockets brutos: evita falsificação de ARP/ICMP na rede local.
    '--cap-drop=NET_RAW',
    '--pids-limit=1024',
    '--memory=4g',
    '-v',
    `${spec.copyDir}:${CONTAINER_WORKDIR}`,
    '-w',
    CONTAINER_WORKDIR,
  ];
  if (spec.hostUser !== undefined) {
    if (spec.runtime === 'podman') {
      // Podman sem root: keep-id mapeia o usuário do container para o do
      // hospedeiro; --user com o uid do hospedeiro cairia num subuid estranho.
      args.push('--userns=keep-id');
    } else {
      // Com um uid sem entrada em /etc/passwd, HOME seria "/" (não gravável) e o npm falharia.
      args.push('--user', spec.hostUser, '-e', 'HOME=/tmp');
    }
  }
  for (const grant of spec.grants) {
    switch (grant.tipo) {
      case 'porta':
        // Só no loopback: sem isso, o servidor de desenvolvimento ficaria
        // acessível para qualquer máquina da rede local.
        args.push('-p', `127.0.0.1:${grant.portaHost}:${grant.portaContainer}`);
        break;
      case 'pasta':
        args.push('-v', `${grant.caminhoHost}:${grant.destino}${grant.somenteLeitura ? ':ro' : ''}`);
        break;
      case 'variavel':
        // Só o NOME vai na linha de comando; o valor segue pelo ambiente do
        // processo docker. Na linha de comando ele ficaria visível para
        // outros usuários da máquina via `ps`.
        args.push('-e', grant.nome);
        break;
    }
  }
  args.push(spec.image, 'sh', '-c', spec.command);
  return args;
}

// ----------------------------------------------------------------- execução

export interface RunOptions {
  onOutput?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface RunResult {
  executado: boolean;
  codigoSaida: number | null;
  cancelado: boolean;
  /** Preenchido quando nada foi executado (ex.: Docker indisponível). */
  motivo?: string;
}

function runProcess(
  command: string,
  args: string[],
  opts: RunOptions & { cwd?: string; env?: NodeJS.ProcessEnv; shell?: boolean; onAbort?: () => void },
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: opts.shell ?? false,
      windowsHide: true,
    });
    let cancelado = false;
    const abort = (): void => {
      cancelado = true;
      opts.onAbort?.();
      child.kill();
    };
    opts.signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (d: Buffer) => opts.onOutput?.(d.toString()));
    child.stderr.on('data', (d: Buffer) => opts.onOutput?.(d.toString()));
    child.on('error', (error) => {
      opts.signal?.removeEventListener('abort', abort);
      resolve({ executado: false, codigoSaida: null, cancelado, motivo: error.message });
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', abort);
      resolve({ executado: true, codigoSaida: code, cancelado });
    });
  });
}

function hostUser(): string | undefined {
  // No Linux o bind mount preserva uid/gid: rodar como root deixaria na
  // cópia arquivos que o usuário não consegue apagar. No Docker Desktop
  // (Windows/macOS) o mapeamento de permissões já é feito pela VM.
  if (process.platform === 'linux' && typeof process.getuid === 'function' && typeof process.getgid === 'function') {
    return `${process.getuid()}:${process.getgid()}`;
  }
  return undefined;
}

/**
 * Uma sessão de contenção por workspace: mantém a cópia entre comandos (para
 * que `npm install` e depois `npm test` funcionem) e as liberações concedidas.
 */
export class SandboxSession {
  private copy: CopyStats | undefined;
  private readonly grants: ContainerGrant[] = [];

  constructor(
    readonly workspaceDir: string,
    public image: string = DEFAULT_IMAGE,
    /** Pode mudar entre comandos se o usuário trocar repoguard.comandoContainer. */
    public docker: DockerCli = DEFAULT_DOCKER,
  ) {}

  get concessoes(): readonly ContainerGrant[] {
    return this.grants;
  }

  get copia(): CopyStats | undefined {
    return this.copy;
  }

  addGrant(grant: ContainerGrant): void {
    const v = validateGrant(grant);
    if (v.erro !== undefined) {
      throw new Error(v.erro);
    }
    this.grants.push(grant);
  }

  revokeGrants(): void {
    this.grants.length = 0;
  }

  /** Descarta a cópia atual e copia o workspace de novo no próximo comando. */
  async resetCopy(): Promise<void> {
    if (this.copy !== undefined) {
      await fs.promises.rm(this.copy.dir, { recursive: true, force: true });
      this.copy = undefined;
    }
  }

  async run(command: string, opts: RunOptions = {}): Promise<RunResult> {
    if (!isValidImage(this.image)) {
      return { executado: false, codigoSaida: null, cancelado: false, motivo: `Imagem de container inválida: "${this.image}".` };
    }
    const status = await checkDocker(this.docker);
    if (!status.disponivel) {
      // Degradação explícita: NUNCA cair silenciosamente para o hospedeiro.
      return { executado: false, codigoSaida: null, cancelado: false, motivo: status.motivo };
    }
    if (this.copy === undefined) {
      this.copy = await copyWorkspace(this.workspaceDir, opts.signal);
      opts.onOutput?.(
        `[RepoGuard] Cópia isolada criada: ${this.copy.arquivos} arquivo(s)` +
          (this.copy.linksIgnorados > 0 ? `, ${this.copy.linksIgnorados} link(s) simbólico(s) ignorado(s)` : '') +
          '.\n',
      );
    }

    const containerName = `repoguard-${crypto.randomBytes(6).toString('hex')}`;
    const user = hostUser();
    const args = buildDockerArgs({
      copyDir: this.copy.dir,
      image: this.image,
      command,
      grants: this.grants,
      containerName,
      runtime: this.docker.runtime ?? 'docker',
      ...(user !== undefined ? { hostUser: user } : {}),
    });

    // O ambiente do processo docker (CLI) precisa de PATH/DOCKER_HOST, mas
    // nada dele entra no container, exceto as variáveis liberadas com -e.
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const grant of this.grants) {
      if (grant.tipo === 'variavel') {
        env[grant.nome] = grant.valor;
      }
    }

    return runProcess(this.docker.command, [...(this.docker.baseArgs ?? []), ...args], {
      ...opts,
      env,
      // Matar o cliente docker não para o container; removê-lo pelo nome sim.
      onAbort: () => {
        spawn(this.docker.command, [...(this.docker.baseArgs ?? []), 'rm', '-f', containerName], {
          env: process.env,
          windowsHide: true,
        }).on('error', () => undefined);
      },
    });
  }

  async dispose(): Promise<void> {
    await this.resetCopy();
  }
}

/** A imagem já está baixada? (Sem ela, o primeiro sandbox precisa de rede e pode demorar.) */
export async function imageExists(docker: DockerCli, image: string): Promise<boolean> {
  if (!isValidImage(image)) {
    return false;
  }
  const result = await runProcess(docker.command, [...(docker.baseArgs ?? []), 'image', 'inspect', image], {
    env: process.env,
  });
  return result.executado && result.codigoSaida === 0;
}

/** Baixa a imagem antes de precisar dela (preparação das máquinas do experimento). */
export async function pullImage(docker: DockerCli, image: string, opts: RunOptions = {}): Promise<RunResult> {
  if (!isValidImage(image)) {
    return { executado: false, codigoSaida: null, cancelado: false, motivo: `Imagem de container inválida: "${image}".` };
  }
  return runProcess(docker.command, [...(docker.baseArgs ?? []), 'pull', image], { ...opts, env: process.env });
}

/**
 * Liberação "hospedeiro": executa direto na máquina do usuário, no workspace
 * REAL, com o ambiente completo dele. Só deve ser chamada depois da
 * confirmação digitada feita pela interface.
 */
export function runOnHost(command: string, cwd: string, opts: RunOptions = {}): Promise<RunResult> {
  return runProcess(command, [], { ...opts, cwd, shell: true, env: process.env });
}
