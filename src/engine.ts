import * as fs from 'fs';
import {
  AnalysisResult,
  Evidence,
  FAMILIES,
  Family,
  RiskLevel,
  ScoreBreakdown,
  WeightsConfig,
} from './types';

/**
 * Motor heurístico.
 *
 * Pontuação = (soma dos pesos das famílias presentes no repositório) × multiplicador.
 *
 * - Cada família conta UMA vez no repositório, não uma vez por ocorrência nem
 *   por arquivo. Do contrário a pontuação mediria o tamanho do projeto: dez
 *   scripts de build com spawnSync somariam 200 e todo monorepo seria ALTO.
 * - O multiplicador só vem de correlação DENTRO DE UM MESMO ARQUIVO. Ler
 *   credenciais e falar com a rede no mesmo arquivo é o formato de um ladrão
 *   de credenciais; em arquivos diferentes (um teste lê .env, outro script
 *   chama fetch) é rotina em projetos legítimos.
 *
 * Níveis: abaixo de limiarAlerta é BAIXO e a extensão fica em silêncio. Duas
 * regras sobem o nível independentemente da soma:
 * - tríade ACESSO_SENSIVEL + OFUSCACAO + SAIDA_REDE num arquivo → ALTO;
 * - evidência fora da contenção (tarefa folderOpen, initializeCommand) → no
 *   mínimo MEDIO. Nesses casos o próprio VS Code executa o código na máquina
 *   do usuário e o container não protege; silêncio deixaria o usuário sem
 *   defesa nenhuma, o que justifica a exceção à regra do limiar.
 */

export const DEFAULT_WEIGHTS: WeightsConfig = {
  pesos: {
    EXEC_AUTOMATICA: 25,
    EXEC_SISTEMA: 20,
    ACESSO_SENSIVEL: 35,
    OFUSCACAO: 15,
    SAIDA_REDE: 25,
    DOWNLOAD_ENCADEADO: 30,
  },
  limiarAlerta: 50,
  limiarAlto: 100,
  multiplicadorAcessoRede: 1.5,
  multiplicadorTriade: 2.0,
};

export const FAMILY_LABELS: Record<Family, string> = {
  EXEC_AUTOMATICA: 'execução automática',
  EXEC_SISTEMA: 'execução de comandos do sistema',
  ACESSO_SENSIVEL: 'acesso a credenciais ou segredos',
  OFUSCACAO: 'código disfarçado',
  SAIDA_REDE: 'conexão com a internet',
  DOWNLOAD_ENCADEADO: 'download seguido de execução',
};

// ------------------------------------------------------------------- pesos

function finiteNumber(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

/**
 * Valida o conteúdo de weights.json. Lança erro descrevendo o primeiro
 * problema: um peso ausente ou negativo calibraria o experimento em silêncio
 * de um jeito que ninguém perceberia nos dados.
 */
export function parseWeights(raw: unknown): WeightsConfig {
  if (raw === null || typeof raw !== 'object') {
    throw new Error('o arquivo de pesos deve conter um objeto JSON');
  }
  const obj = raw as Record<string, unknown>;
  const pesosRaw = obj.pesos;
  if (pesosRaw === null || typeof pesosRaw !== 'object') {
    throw new Error('campo "pesos" ausente');
  }
  const pesos = {} as Record<Family, number>;
  for (const family of FAMILIES) {
    const value = (pesosRaw as Record<string, unknown>)[family];
    if (!finiteNumber(value, 0)) {
      throw new Error(`peso inválido para ${family}`);
    }
    pesos[family] = value;
  }
  const fields: Array<[keyof Omit<WeightsConfig, 'pesos'>, number]> = [
    ['limiarAlerta', 0],
    ['limiarAlto', 0],
    ['multiplicadorAcessoRede', 1],
    ['multiplicadorTriade', 1],
  ];
  const config: WeightsConfig = { ...DEFAULT_WEIGHTS, pesos };
  for (const [field, min] of fields) {
    const value = obj[field];
    if (!finiteNumber(value, min)) {
      throw new Error(`valor inválido para ${field} (mínimo ${min})`);
    }
    config[field] = value;
  }
  if (config.limiarAlto < config.limiarAlerta) {
    throw new Error('limiarAlto não pode ser menor que limiarAlerta');
  }
  return config;
}

export interface LoadedWeights {
  config: WeightsConfig;
  /** Preenchido quando o arquivo não pôde ser usado e os padrões entraram no lugar. */
  aviso?: string;
}

/**
 * Lê os pesos do diretório da extensão. O arquivo vem com a extensão, nunca
 * do workspace analisado: um repositório não pode recalibrar o motor que o julga.
 */
export async function loadWeights(filePath: string): Promise<LoadedWeights> {
  try {
    const text = await fs.promises.readFile(filePath, 'utf8');
    return { config: parseWeights(JSON.parse(text)) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      config: DEFAULT_WEIGHTS,
      aviso: `Pesos em ${filePath} não puderam ser usados (${reason}); usando os valores padrão.`,
    };
  }
}

// ---------------------------------------------------------------- pontuação

export interface ScoreOptions {
  /** Coleta truncada ou prazo esgotado. */
  analiseIncompleta?: boolean;
}

interface FileCorrelation {
  arquivo: string;
  multiplicador: number;
  triade: boolean;
}

function correlationFor(familias: Set<Family>, weights: WeightsConfig): Omit<FileCorrelation, 'arquivo'> {
  const acesso = familias.has('ACESSO_SENSIVEL');
  const rede = familias.has('SAIDA_REDE');
  if (acesso && rede && familias.has('OFUSCACAO')) {
    return { multiplicador: weights.multiplicadorTriade, triade: true };
  }
  if (acesso && rede) {
    return { multiplicador: weights.multiplicadorAcessoRede, triade: false };
  }
  return { multiplicador: 1, triade: false };
}

export function scoreEvidence(
  evidencias: Evidence[],
  weights: WeightsConfig = DEFAULT_WEIGHTS,
  options: ScoreOptions = {},
): AnalysisResult {
  const byFile = new Map<string, Set<Family>>();
  const present = new Set<Family>();
  for (const e of evidencias) {
    present.add(e.familia);
    const set = byFile.get(e.arquivo) ?? new Set<Family>();
    set.add(e.familia);
    byFile.set(e.arquivo, set);
  }

  // A correlação mais forte entre todos os arquivos define o multiplicador.
  // Em empate, o primeiro arquivo em ordem alfabética, para o resultado ser
  // determinístico (o mesmo repositório gera sempre a mesma justificativa).
  let best: FileCorrelation = { arquivo: '', multiplicador: 1, triade: false };
  for (const arquivo of [...byFile.keys()].sort()) {
    const c = correlationFor(byFile.get(arquivo) as Set<Family>, weights);
    if (c.multiplicador > best.multiplicador || (c.triade && !best.triade)) {
      best = { arquivo, ...c };
    }
  }

  const familias = FAMILIES.filter((f) => present.has(f));
  const somaBase = familias.reduce((acc, f) => acc + weights.pesos[f], 0);
  const pontuacao = Math.round(somaBase * best.multiplicador * 10) / 10;

  let nivel: RiskLevel =
    pontuacao >= weights.limiarAlto ? 'ALTO' : pontuacao >= weights.limiarAlerta ? 'MEDIO' : 'BAIXO';
  let nivelForcadoPor: ScoreBreakdown['nivelForcadoPor'];
  if (best.triade && nivel !== 'ALTO') {
    nivel = 'ALTO';
    nivelForcadoPor = 'triade';
  }
  const foraDaContencao = evidencias.filter((e) => e.foraDaContencao === true);
  if (foraDaContencao.length > 0 && nivel === 'BAIXO') {
    nivel = 'MEDIO';
    nivelForcadoPor = 'fora-da-contencao';
  }

  const detalhamento: ScoreBreakdown = {
    familias,
    somaBase,
    multiplicador: best.multiplicador,
    analiseIncompleta: options.analiseIncompleta === true,
  };
  if (best.multiplicador > 1) {
    detalhamento.arquivoCorrelacao = best.arquivo;
  }
  if (nivelForcadoPor !== undefined) {
    detalhamento.nivelForcadoPor = nivelForcadoPor;
  }

  return {
    pontuacao,
    nivel,
    evidencias: sortEvidence(evidencias),
    justificativa: buildJustification(pontuacao, nivel, detalhamento, best.triade, foraDaContencao, weights),
    detalhamento,
  };
}

/** Somente acima do limiar (ou pelas exceções) a extensão aparece para o usuário. */
export function shouldAlert(result: AnalysisResult): boolean {
  return result.nivel !== 'BAIXO';
}

/** O que escapa da contenção primeiro; depois por arquivo e linha. */
function sortEvidence(list: Evidence[]): Evidence[] {
  return [...list].sort(
    (a, b) =>
      Number(b.foraDaContencao === true) - Number(a.foraDaContencao === true) ||
      a.arquivo.localeCompare(b.arquivo) ||
      a.linha - b.linha ||
      a.coluna - b.coluna,
  );
}

/**
 * Justificativa em linguagem simples. Ela cita os arquivos e as famílias do
 * repositório em questão, então muda de um repositório para outro: parte do
 * requisito de alertas polimórficos.
 */
function buildJustification(
  pontuacao: number,
  nivel: RiskLevel,
  d: ScoreBreakdown,
  triade: boolean,
  foraDaContencao: Evidence[],
  weights: WeightsConfig,
): string {
  if (d.familias.length === 0) {
    return d.analiseIncompleta
      ? 'Nenhum sinal de risco encontrado no que foi possível analisar dentro do prazo.'
      : 'Nenhum sinal de risco encontrado.';
  }

  const parts: string[] = [];
  const labels = d.familias.map((f) => FAMILY_LABELS[f]);
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`;
  parts.push(`Foram encontrados sinais de ${list}.`);

  if (d.arquivoCorrelacao !== undefined) {
    parts.push(
      triade
        ? `O arquivo ${d.arquivoCorrelacao} acessa segredos, disfarça o próprio código e se conecta à internet: o padrão típico de roubo de credenciais.`
        : `O arquivo ${d.arquivoCorrelacao} acessa segredos e se conecta à internet, uma combinação que pode enviar seus dados para fora.`,
    );
  }

  if (foraDaContencao.length > 0) {
    const arquivos = [...new Set(foraDaContencao.map((e) => e.arquivo))].join(', ');
    parts.push(
      `Atenção: ${arquivos} pede que o VS Code execute algo diretamente na sua máquina, por um caminho que o container não cobre.`,
    );
  }

  const multiplicador = d.multiplicador > 1 ? ` × ${d.multiplicador}` : '';
  parts.push(
    `Pontuação ${pontuacao} (${d.somaBase}${multiplicador}); o alerta aparece a partir de ${weights.limiarAlerta}. Nível: ${nivel}.`,
  );
  if (d.analiseIncompleta) {
    parts.push('A análise não terminou dentro do prazo ou do limite de arquivos, então pode haver mais sinais.');
  }
  return parts.join(' ');
}
