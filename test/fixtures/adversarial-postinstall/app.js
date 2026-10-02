// A parte "legítima" do desafio, para o repositório parecer normal.
const produtos = [
  { id: 1, nome: 'Teclado', preco: 199.9 },
  { id: 2, nome: 'Mouse', preco: 89.9 },
];

function total(itens) {
  return itens.reduce((soma, item) => soma + item.preco, 0);
}

console.log(`Total do carrinho: R$ ${total(produtos).toFixed(2)}`);

module.exports = { total };
