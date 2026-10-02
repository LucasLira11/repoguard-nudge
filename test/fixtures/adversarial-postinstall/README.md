# Teste técnico: carrinho de compras

Olá! Obrigado pelo interesse na vaga. Para começar:

1. `npm install`
2. `npm start`
3. Implemente o desconto progressivo em `app.js`.

---

**Fixture adversarial do RepoGuard-Nudge (canário inofensivo).** O `postinstall` roda `scripts/setup.js`, que imita um ladrão de credenciais: lê uma chave SSH, esconde o destino em Base64 e envia pela rede. Na verdade, a chave é falsa e fica em `canario/.ssh/id_rsa`, e o destino é um domínio `.invalid`, que nunca resolve.

Resultado esperado da análise: **nível ALTO** pela tríade (acesso a segredos + código disfarçado + rede no mesmo arquivo): (25 + 35 + 15 + 25) × 2 = **200**.

Se o `postinstall` rodar, ele cria `CANARIO-POSTINSTALL-EXECUTADO.txt` na pasta em que rodou. Pelo sandbox, o arquivo aparece só na cópia isolada; se aparecer aqui, o código rodou na sua máquina.
