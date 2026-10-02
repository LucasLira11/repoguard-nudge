const http = require('http');

const tarefas = [{ id: 1, titulo: 'Ler o enunciado', feita: true }];

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/tarefas') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tarefas));
    return;
  }
  res.writeHead(404).end();
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`Servidor em http://localhost:${port}`));

module.exports = server;
