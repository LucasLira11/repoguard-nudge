import { dedupeEvidence } from './analyzers/common';
import { analyzeManifests } from './analyzers/manifests';
import { analyzeJavaScript, analyzeShell } from './analyzers/scripts';
import { WorkspaceReader, collectArtifacts } from './collector';
import { scoreEvidence } from './engine';
import { AnalysisResult, Evidence, SkippedArtifact, WeightsConfig } from './types';

/**
 * Orquestração: coleta → manifestos → scripts → motor, com prazo total.
 * Não importa `vscode`; a extensão injeta o leitor e os testes usam fs.
 */

export const ANALYSIS_TIMEOUT_MS = 5000;

export interface AnalysisRun {
  resultado: AnalysisResult;
  artefatos: number;
  descartados: SkippedArtifact[];
  duracaoMs: number;
}

/**
 * O host de extensões do VS Code é uma única thread compartilhada por todas
 * as extensões. Ceder a vez entre arquivos mantém o editor responsivo e
 * permite que o temporizador do prazo dispare. Um único arquivo (máx. 1 MB)
 * ainda é analisado de uma vez; esse é o limite da granularidade.
 */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export async function runAnalysis(
  reader: WorkspaceReader,
  weights: WeightsConfig,
  timeoutMs: number = ANALYSIS_TIMEOUT_MS,
): Promise<AnalysisRun> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const collection = await collectArtifacts(reader, controller.signal);
    let expired = collection.aborted;

    const manifests = analyzeManifests(collection.artifacts);
    const evidencias: Evidence[] = [...manifests.evidencias];

    const jobs: Array<() => Evidence[]> = [];
    for (const artifact of collection.artifacts) {
      if (artifact.kind === 'script') {
        jobs.push(() => analyzeJavaScript(artifact.path, artifact.content));
      } else if (artifact.kind === 'shell-script') {
        jobs.push(() => analyzeShell(artifact.path, artifact.content));
      }
    }
    for (const inline of manifests.scriptsEmbutidos) {
      jobs.push(() => analyzeJavaScript(inline.arquivo, inline.codigo, { linha: inline.linha, coluna: inline.coluna }));
    }

    for (const job of jobs) {
      if (controller.signal.aborted) {
        // Prazo esgotado: pontuamos o que já foi visto. A pontuação vira um
        // piso, e a justificativa avisa que a análise ficou incompleta.
        expired = true;
        break;
      }
      evidencias.push(...job());
      await yieldToEventLoop();
    }

    const resultado = scoreEvidence(dedupeEvidence(evidencias), weights, {
      analiseIncompleta: expired || collection.truncated,
    });
    return {
      resultado,
      artefatos: collection.artifacts.length,
      descartados: collection.skipped,
      duracaoMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}
