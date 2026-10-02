// Copia test/fixtures para ../repoguard-fixtures (pasta irmã do projeto).
//
// Por quê: o VS Code faz subpastas herdarem a confiança da pasta-mãe. Se o
// projeto da extensão é confiável, abrir test/fixtures/<x> no Extension
// Development Host cairia direto em modo confiável, e não daria para testar o
// cenário principal (repositório aberto em modo restrito). Uma cópia fora do
// projeto começa sem confiança. Cada execução recomeça do zero, o que também
// apaga arquivos-marcador CANARIO-*.txt de testes anteriores.
const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, '..', 'test', 'fixtures');
const target = path.join(__dirname, '..', '..', 'repoguard-fixtures');
const marker = path.join(target, '.repoguard-fixtures');

if (fs.existsSync(target)) {
  // Só apaga a pasta se fomos nós que a criamos.
  if (!fs.existsSync(marker)) {
    console.error(`A pasta ${target} já existe e não foi criada por este script. Nada foi alterado.`);
    process.exit(1);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

fs.cpSync(source, target, { recursive: true });
fs.writeFileSync(marker, 'Pasta gerada por scripts/copy-fixtures.js do RepoGuard-Nudge. Pode ser apagada.\n');
console.log(`Fixtures copiadas para ${target}`);
