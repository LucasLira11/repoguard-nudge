import * as vscode from 'vscode';
import { ExperimentMode, ExtensionSettings } from './types';

const SECTION = 'repoguard';

/**
 * Lê uma configuração considerando APENAS o valor do usuário (global) ou o padrão.
 *
 * Segurança: o repositório analisado é hostil e pode trazer um
 * .vscode/settings.json com "repoguard.modo": "controle" (desliga a interface),
 * uma imagem de container maliciosa ou um caminho de registro arbitrário.
 * O package.json já declara scope "application", o que faz o VS Code ignorar
 * esses valores no workspace; aqui repetimos a regra como defesa em profundidade,
 * para não depender de um único mecanismo.
 */
function readUserValue<T>(key: string, fallback: T): T {
  const inspected = vscode.workspace.getConfiguration(SECTION).inspect<T>(key);
  if (inspected === undefined) {
    return fallback;
  }
  return inspected.globalValue ?? inspected.defaultValue ?? fallback;
}

function readString(key: string, fallback: string): string {
  const value = readUserValue<unknown>(key, fallback);
  return typeof value === 'string' ? value.trim() : fallback;
}

function readMode(): ExperimentMode {
  const value = readString('modo', 'experimental');
  return value === 'controle' ? 'controle' : 'experimental';
}

export function readSettings(): ExtensionSettings {
  const modo = readMode();
  return {
    modo,
    participanteId: readString('participanteId', ''),
    grupo: readString('grupo', '') || modo,
    desafioId: readString('desafioId', ''),
    caminhoRegistro: readString('caminhoRegistro', ''),
    imagemContainer: readString('imagemContainer', 'node:20-slim') || 'node:20-slim',
    comandoContainer: readString('comandoContainer', 'docker') === 'podman' ? 'podman' : 'docker',
  };
}

export function affectsSettings(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(SECTION);
}
