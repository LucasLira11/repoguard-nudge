// Docker/Podman falso para os testes: não executa nada, só responde como o CLI faria.
// Usado como `node fakeDocker.js <args do docker>`.
const args = process.argv.slice(2);
const down = process.env.FAKE_DOCKER_DOWN === '1';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

// docker version --format {{.Server.Version}}  |  podman info --format {{.Version.Version}}
if (args[0] === 'version' || args[0] === 'info') {
  if (down) {
    fail('Cannot connect to the Docker daemon');
  }
  process.stdout.write(args[0] === 'info' ? '5.2.0\n' : '27.0.0\n');
  process.exit(0);
}

if (args[0] === 'image' && args[1] === 'inspect') {
  if (process.env.FAKE_IMAGE_PRESENT === '1') {
    process.stdout.write('[{}]\n');
    process.exit(0);
  }
  fail(`Error: No such image: ${args[2]}`);
}

if (args[0] === 'pull') {
  process.stdout.write(`Pulling ${args[1]}...\nStatus: Downloaded newer image for ${args[1]}\n`);
  process.exit(0);
}

if (args[0] === 'run') {
  // Ecoa os argumentos e a variável liberada, para o teste conferir o que
  // chegaria ao container.
  process.stdout.write(JSON.stringify({ args, apiUrl: process.env.API_URL ?? null }) + '\n');
  // FAKE_DOCKER_SLEEP_MS simula um comando demorado (ex.: um servidor rodando).
  setTimeout(() => process.exit(Number(process.env.FAKE_DOCKER_EXIT ?? '0')), Number(process.env.FAKE_DOCKER_SLEEP_MS ?? '0'));
  return;
}

if (args[0] === 'rm') {
  process.exit(0);
}

process.exit(2);
