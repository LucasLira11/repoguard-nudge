/**
 * Tipos compartilhados. Este arquivo não importa `vscode` de propósito:
 * analisadores e motor dependem só dele e podem ser testados no Jest puro.
 */

export const FAMILIES = [
  'EXEC_AUTOMATICA',
  'EXEC_SISTEMA',
  'ACESSO_SENSIVEL',
  'OFUSCACAO',
  'SAIDA_REDE',
  'DOWNLOAD_ENCADEADO',
] as const;

export type Family = (typeof FAMILIES)[number];

export function isFamily(value: unknown): value is Family {
  return typeof value === 'string' && (FAMILIES as readonly string[]).includes(value);
}

/** Um achado da análise estática. Nomes de campo seguem a especificação da pesquisa. */
export interface Evidence {
  id: string;
  familia: Family;
  /** Caminho relativo à raiz do workspace, sempre com barras normais. */
  arquivo: string;
  /** 1-based. */
  linha: number;
  /** 1-based. */
  coluna: number;
  /** No máximo 120 caracteres. Conteúdo hostil: nunca renderizar como HTML. */
  trecho: string;
  /** Uma frase em português, para quem não é especialista. */
  explicacao: string;
  /** Texto decodificado de Base64, quando aplicável. Também é conteúdo hostil. */
  decodificado?: string;
  /**
   * Verdadeiro quando o gatilho é disparado pelo próprio IDE na máquina do
   * usuário (tarefa folderOpen, initializeCommand do devcontainer), ou seja,
   * por um caminho que a contenção desta extensão não intercepta.
   */
  foraDaContencao?: boolean;
}

export type ArtifactKind =
  | 'package-json'
  | 'package-lock'
  | 'vscode-tasks'
  | 'vscode-launch'
  | 'devcontainer'
  | 'setup-py'
  | 'pyproject'
  | 'makefile'
  /** JS/TS (ou qualquer arquivo que um comando entregue ao node). */
  | 'script'
  | 'shell-script';

export interface CollectedArtifact {
  /** Caminho relativo à raiz do workspace, com barras normais. */
  path: string;
  content: string;
  kind: ArtifactKind;
}

export type SkipReason =
  | 'tamanho'
  | 'limite-total'
  | 'fora-do-workspace'
  | 'ignorado'
  | 'link-simbolico'
  | 'erro-leitura';

export interface SkippedArtifact {
  path: string;
  reason: SkipReason;
}

export interface CollectionResult {
  artifacts: CollectedArtifact[];
  skipped: SkippedArtifact[];
  /** Verdadeiro se o limite total de arquivos foi atingido. */
  truncated: boolean;
  /** Verdadeiro se o prazo da análise esgotou antes do fim da coleta. */
  aborted: boolean;
}

export type RiskLevel = 'BAIXO' | 'MEDIO' | 'ALTO';

export interface AnalysisResult {
  pontuacao: number;
  nivel: RiskLevel;
  evidencias: Evidence[];
  justificativa: string;
  /** Como a pontuação foi obtida; vai para o registro do experimento. */
  detalhamento: ScoreBreakdown;
}

export interface ScoreBreakdown {
  /** Famílias presentes no repositório (cada uma conta uma vez). */
  familias: Family[];
  somaBase: number;
  multiplicador: number;
  /** Arquivo onde a correlação que definiu o multiplicador foi encontrada. */
  arquivoCorrelacao?: string;
  /** Regra que elevou o nível acima do que a pontuação indicaria. */
  nivelForcadoPor?: 'triade' | 'fora-da-contencao';
  /** Coleta truncada ou prazo esgotado: a pontuação é um piso, não um teto. */
  analiseIncompleta: boolean;
}

export interface WeightsConfig {
  pesos: Record<Family, number>;
  limiarAlerta: number;
  limiarAlto: number;
  multiplicadorAcessoRede: number;
  multiplicadorTriade: number;
}

export type ExperimentMode = 'experimental' | 'controle';

export interface ExtensionSettings {
  modo: ExperimentMode;
  participanteId: string;
  grupo: string;
  desafioId: string;
  caminhoRegistro: string;
  imagemContainer: string;
  comandoContainer: 'docker' | 'podman';
}

/**
 * Cada liberação é um pedido separado. Não há um tipo "sair do container":
 * liberar tudo de uma vez é exatamente o diálogo binário que queremos evitar.
 */
export type ReleaseRequest =
  | { tipo: 'porta'; portaHost: number; portaContainer: number }
  | { tipo: 'pasta'; caminhoHost: string; destino: string; somenteLeitura: boolean }
  | { tipo: 'variavel'; nome: string; valor: string }
  | { tipo: 'hospedeiro' };

export type ReleaseKind = ReleaseRequest['tipo'];

export type TelemetryEventName =
  | 'workspace_aberto'
  | 'analise_concluida'
  | 'painel_exibido'
  /** Painel fechado sem rodar nada pelo sandbox (botão Cancelar ou fechar a aba). */
  | 'painel_cancelado'
  | 'evidencia_inspecionada'
  | 'sandbox_executado'
  | 'liberacao_solicitada'
  | 'liberacao_concedida'
  | 'liberacao_negada'
  | 'execucao_hospedeiro';

export interface TelemetryRecord {
  participanteId: string;
  grupo: string;
  desafioId: string;
  evento: TelemetryEventName;
  /** ISO 8601. */
  timestamp: string;
  detalhes: Record<string, unknown>;
}
