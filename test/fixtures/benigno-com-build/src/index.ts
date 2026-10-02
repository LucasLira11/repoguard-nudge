import * as http from 'http';

interface Pedido {
  id: number;
  cliente: string;
  total: number;
}

const pedidos: Pedido[] = [{ id: 1, cliente: 'Ana', total: 42.5 }];

const server = http.createServer((req, res) => {
  if (req.url === '/pedidos') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pedidos));
    return;
  }
  res.writeHead(404).end();
});

server.listen(Number(process.env.PORT ?? 3000));
