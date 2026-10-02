// Build comum: compila TypeScript e copia os arquivos estáticos.
// Usa child_process e roda no "prepare" (execução automática), mas não lê
// segredos nem fala com a rede: deve ficar abaixo do limiar, em silêncio.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const modo = process.env.NODE_ENV || 'development';

const tsc = spawnSync('npx', ['tsc', '-p', raiz], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, FORCE_COLOR: '1' },
});
if (tsc.status !== 0) {
  process.exit(tsc.status ?? 1);
}

fs.mkdirSync(path.join(raiz, 'dist', 'public'), { recursive: true });
fs.copyFileSync(path.join(raiz, 'public', 'index.html'), path.join(raiz, 'dist', 'public', 'index.html'));
console.log(`Build concluído (${modo}).`);
