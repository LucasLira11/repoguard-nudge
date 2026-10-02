import { HOST_EXECUTION_MARKERS, hostMarkerFor, terminalCanBeCaptured } from '../src/hostMarkers';

describe('indícios de execução no hospedeiro', () => {
  it('reconhece node_modules e lockfiles na raiz da pasta', () => {
    expect(hostMarkerFor('node_modules')).toBe('node_modules');
    expect(hostMarkerFor('package-lock.json')).toBe('package-lock.json');
    expect(hostMarkerFor('yarn.lock')).toBe('yarn.lock');
    expect(hostMarkerFor('pnpm-lock.yaml')).toBe('pnpm-lock.yaml');
  });

  it('ignora arquivos comuns e indícios fora da raiz', () => {
    expect(hostMarkerFor('package.json')).toBeUndefined();
    expect(hostMarkerFor('app.js')).toBeUndefined();
    expect(hostMarkerFor('packages/web/node_modules')).toBeUndefined();
    expect(hostMarkerFor('packages\\web\\package-lock.json')).toBeUndefined();
    expect(hostMarkerFor('../package-lock.json')).toBeUndefined();
  });

  it('cobre os gerenciadores de pacotes mais usados', () => {
    expect(HOST_EXECUTION_MARKERS).toEqual(
      expect.arrayContaining(['node_modules', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']),
    );
  });
});

describe('captura de comandos do terminal', () => {
  it('cmd.exe não permite captura', () => {
    expect(terminalCanBeCaptured('C:\\WINDOWS\\System32\\cmd.exe')).toBe(false);
    expect(terminalCanBeCaptured('cmd.exe')).toBe(false);
    expect(terminalCanBeCaptured('CMD')).toBe(false);
  });

  it('PowerShell, bash e zsh permitem', () => {
    expect(terminalCanBeCaptured('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(true);
    expect(terminalCanBeCaptured('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe(true);
    expect(terminalCanBeCaptured('/bin/bash')).toBe(true);
    expect(terminalCanBeCaptured('/bin/zsh')).toBe(true);
    // Nome que só contém "cmd" não é o cmd.exe.
    expect(terminalCanBeCaptured('/usr/local/bin/mycmd-shell')).toBe(true);
  });
});
