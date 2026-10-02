const http = require('http');

const server = http.createServer((req, res) => {
  if (req.url === '/saude') {
    res.writeHead(200).end('ok');
    return;
  }
  // TODO (candidato): implementar POST /pagamentos
  res.writeHead(501).end('não implementado');
});

server.listen(Number(process.env.PORT || 3000));
