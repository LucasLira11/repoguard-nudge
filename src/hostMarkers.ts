/**
 * Indícios de execução no hospedeiro que não dependem do terminal.
 *
 * A cópia do sandbox é de mão única: nada do que roda no container volta
 * para a pasta real. Logo, se aparece na pasta real um node_modules ou um
 * lockfile que não existia, alguma instalação rodou NA MÁQUINA, seja num
 * terminal sem captura de comandos (cmd.exe), num terminal fora do VS Code
 * ou numa tarefa. Sem isto, no grupo controle a variável principal do
 * experimento se perderia em silêncio nesses casos.
 */
export const HOST_EXECUTION_MARKERS: readonly string[] = [
  'node_modules',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'bun.lockb',
];

/** Só a raiz do workspace conta; caminhos com barras de qualquer sistema. */
export function hostMarkerFor(relativePath: string): string | undefined {
  const normalized = relativePath.replace(/\\/g, '/');
  return HOST_EXECUTION_MARKERS.includes(normalized) ? normalized : undefined;
}

/**
 * A captura de comandos do VS Code (integração de shell) funciona em
 * PowerShell, bash, zsh e fish, mas não no cmd.exe.
 */
export function terminalCanBeCaptured(shellPath: string): boolean {
  return !/(^|[\\/])cmd(\.exe)?$/i.test(shellPath.trim());
}
